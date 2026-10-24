"""RAMPCAST API. Run: uvicorn rampcast_server.main:app --reload --port 8000 (from server/)."""
from __future__ import annotations

import dataclasses
import functools
import re
import threading
from contextlib import asynccontextmanager
from datetime import timedelta

import numpy as np
from fastapi import APIRouter, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator, model_validator

from rampcast.engine import audit, models as M, whatif

from . import adapters, ai, bookings, config as C, engine, explain, forecast, la28, parking, store
from .data import Dataset, Flight, airfield_movements, generate_sample, load_processed
from .replay import Replay

@asynccontextmanager
async def lifespan(_: FastAPI):
    # Warm the slow caches (Monte Carlo, stand plan) in the background so the first screen loads fast.
    threading.Thread(target=lambda: (replay(), forecast.occupancy("medium"), la28.report("medium")), daemon=True).start()
    # The exact solver takes seconds: plan the default game-day layout up front so the co-pilot's benchmark is ready.
    threading.Thread(target=_warm_benchmarks, daemon=True).start()
    yield


app = FastAPI(title="RAMPCAST API", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
router = APIRouter()


# ---------- datasets ----------

@functools.lru_cache(maxsize=1)
def live_dataset() -> Dataset:
    """The week we replay as 'live': real 2022 replay if processed, otherwise a seeded sample week."""
    return load_processed() or generate_sample("medium", seed=2027, count_noise=0.12)


def plan_dataset(scenario: str, demand_multiplier: float = 1.0) -> Dataset:
    return _plan_dataset(scenario, round(demand_multiplier, 3))


@functools.lru_cache(maxsize=16)
def _plan_dataset(scenario: str, demand_multiplier: float) -> Dataset:
    return generate_sample(scenario, seed=61, demand_multiplier=demand_multiplier)


@functools.lru_cache(maxsize=1)
def replay() -> Replay:
    return Replay(live_dataset())


def query_t(t: str | None):
    """A replay time from a request; a malformed one is the caller's error (422), not a crash."""
    try:
        return C.parse_t(t)
    except ValueError:
        raise HTTPException(422, f"t must be an ISO time like 2027-02-12T13:10:00-08:00, not {t!r}")


def check_scenario(s: str) -> str:
    if s not in C.SCENARIOS:
        raise HTTPException(422, f"scenario must be one of {C.SCENARIOS}")
    return s


# ---------- models ----------

def _check_time(value: str, what: str) -> str:
    try:
        t = C.parse_t(value)
    except ValueError:
        raise ValueError(f"{what} must be an ISO time like 2027-02-12T13:05:00-08:00, not {value!r}")
    start = C.window_start_local()
    if not (start - timedelta(days=1) <= t <= start + timedelta(hours=C.n_hours())):
        raise ValueError(f"{what} {value} is outside the planning window {C.window()[0]} to {C.window()[1]}")
    return value


class _Window(BaseModel):
    from_: str = Field(alias="from")
    to: str
    model_config = {"populate_by_name": True}

    @model_validator(mode="after")
    def _ordered(self):
        _check_time(self.from_, "from")
        _check_time(self.to, "to")
        if C.parse_t(self.to) <= C.parse_t(self.from_):
            raise ValueError(f"'to' ({self.to}) must be after 'from' ({self.from_})")
        return self


class RunwayClosed(_Window):
    pass


class ArrivalDelay(_Window):
    minutes: int = Field(120, ge=15, le=480)


class Modifiers(BaseModel):
    runway_closed: RunwayClosed | None = None
    arrival_delay: ArrivalDelay | None = None
    demand_multiplier: float = Field(1.0, ge=0.3, le=3.0)
    customs_hours: dict[str, list[str]] | None = None
    diversions: dict[str, str] | None = None   # flight_id -> ICAO the operator says the jet will land at
    at: str | None = None

    @field_validator("customs_hours")
    @classmethod
    def _customs(cls, v):
        days = {"mon", "tue", "wed", "thu", "fri", "sat", "sun"}
        for day, hours in (v or {}).items():
            if day not in days:
                raise ValueError(f"customs day must be one of {sorted(days)}, not {day!r}")
            if len(hours) != 2 or not all(re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", h) for h in hours):
                raise ValueError(f"customs hours for {day} must be two HH:MM times, e.g. ['09:00', '14:30']")
            if hours[1] <= hours[0]:
                raise ValueError(f"customs on {day} must close after it opens")
        return v

    @field_validator("diversions")
    @classmethod
    def _icao(cls, v):
        for fid, icao in (v or {}).items():
            if not re.fullmatch(r"[A-Z]{4}", icao):
                raise ValueError(f"diversion airport for {fid} must be a 4-letter ICAO code, not {icao!r}")
        return v

    @field_validator("at")
    @classmethod
    def _at(cls, v):
        return _check_time(v, "at") if v else v


class PlanRequest(BaseModel):
    scenario: str = "medium"
    modifiers: Modifiers = Modifiers()
    layout: str = "stands"          # which parking layout a what-if re-plans


class AuditEntry(BaseModel):
    action: str
    target: str
    actor_role: str = "FBO general manager"
    note: str = ""
    replay_t_local: str | None = None


class ExplainRequest(BaseModel):
    kind: str = "question"
    question: str
    scenario: str = "medium"
    t: str | None = None


# ---------- routes ----------

@functools.lru_cache(maxsize=1)
def demo_t() -> str:
    """Replay start for the demo: 90 minutes before the ramp first reaches 90% of capacity."""
    occ = engine.occupancy_hourly(live_dataset().flights)
    over = np.nonzero(occ >= 0.9 * engine.capacity())[0]
    h = int(over[0]) if len(over) else 3 * 24 + 12
    return C.iso_local(C.window_start_local() + timedelta(hours=h, minutes=-90))


@router.get("/meta")
def meta():
    ds = live_dataset()
    a = C.assumptions()
    return {"product": "RAMPCAST", "event": a["event"], "fbo": a["fbo"], "settings": store.get_settings(),
            "window": [d.isoformat() for d in C.window_days()], "live_source": ds.source, "notes": ds.notes,
            "claude_enabled": explain.claude_available(),
            "local_llm_enabled": explain.local_llm_available(),
            "local_llm_model": explain.get_local_model_name() if explain.local_llm_available() else None,
            "modules": adapters.status(),
            "scenarios": list(C.SCENARIOS), "stands": ds.stands, "demo_t": demo_t(),
            "privacy": "Tail numbers hashed; people appear only as booking codes; bookings are synthetic."}


@router.get("/forecast")
def get_forecast(scenario: str = "medium"):
    return adapters.call("rampcast.forecast.api", "get_forecast", forecast.forecast, check_scenario(scenario))


@router.get("/ramp/occupancy")
def get_occupancy(scenario: str = "medium"):
    return adapters.call("rampcast.forecast.api", "get_occupancy", forecast.occupancy, check_scenario(scenario))


def _strategies(scenario: str, modifiers: dict) -> dict:
    ds = plan_dataset(scenario, modifiers.get("demand_multiplier", 1.0))
    if modifiers.get("runway_closed"):
        ds, _ = engine.apply_runway_closure(ds, modifiers["runway_closed"])
    return engine.strategies(ds)


@router.post("/plan/strategies", response_model=M.StrategiesResponse)
def post_strategies(req: PlanRequest):
    mods = req.modifiers.model_dump(by_alias=True, exclude_none=True)
    out = adapters.call("rampcast.engine.api", "get_strategies", _strategies, check_scenario(req.scenario), mods)
    for c in out["strategies"]:
        k = c["kpis"]
        audit.propose(f"strategy:{c['id']}", f"{c['name']}: {k['overflow_aircraft']} overflow, {k['co2_t']} t CO2",
                      key=f"{req.scenario}:{sorted(mods.items())}:{c['id']}:{k['overflow_aircraft']}:{k['co2_t']}")
    out["approved"] = store.approved_strategy()
    return out


@router.get("/priority/queue", response_model=M.QueueResponse)
def get_queue(t: str | None = None):
    return engine.priority_queue(live_dataset(), query_t(t), store.get_settings()["weights"])


@router.get("/alerts", response_model=M.AlertsResponse)
def get_alerts(t: str | None = None):
    return engine.alerts(live_dataset(), query_t(t))


@router.get("/replay/state")
def get_replay(t: str | None = None):
    return replay().state(query_t(t))


@router.post("/whatif", response_model=M.WhatIfResponse)
def post_whatif(req: PlanRequest):
    scenario = check_scenario(req.scenario)
    mods = req.modifiers.model_dump(by_alias=True, exclude_none=True)
    out = whatif.run(plan_dataset(scenario), plan_dataset(scenario, mods.get("demand_multiplier", 1.0)), mods,
                     store.get_settings()["weights"])
    if mods.get("runway_closed") or mods.get("arrival_delay"):
        # New ETAs: re-solve the live week's stand plan (the one Parking control shows), incrementally,
        # on the departure times owners gave, as the plan itself was made.
        layout = check_layout(req.layout)
        live = parking.as_told(ops_dataset())
        plan = parking_plan("optimized", False, layout)
        out["stand_plan"] = whatif.restand(live, whatif.apply_disruptions(live, mods)[0], plan.assignment,
                                           plan.positions, dict(_pins[layout]))
    key = f"whatif:{scenario}:{sorted(mods.items())}"
    out["explanation"] = explain.explain("whatif", {"facts": out.pop("facts"), "modifiers": mods}, key)
    return {"scenario": scenario, **out}


def _briefing_facts(scenario: str, t) -> dict:
    s = _strategies(scenario, {})
    al = engine.alerts(live_dataset(), t)["alerts"]
    risk_rank = {"low": 0, "medium": 1, "high": 2}
    # Suggest the safest plan that keeps the ramp under capacity; CO2 and staff break ties.
    best = min(s["strategies"], key=lambda c: (c["kpis"]["hours_over_capacity"], risk_rank[c["kpis"]["risk"]],
                                              c["kpis"]["co2_t"], c["kpis"]["peak_line_staff"]))
    facts = [{"id": "capacity", "value": s["capacity"], "text": "ramp capacity, large-cabin equivalents"},
             {"id": "status_quo.peak_demand", "value": s["status_quo"]["peak_demand"], "text": "peak unconstrained demand"},
             {"id": "status_quo.hours_over_capacity", "value": s["status_quo"]["hours_over_capacity"], "text": "hours over capacity with no plan"},
             {"id": "alerts.high", "value": sum(1 for a in al if a["severity"] == "high"), "text": "high-severity alerts now"}]
    for c in s["strategies"]:
        for k in ("overflow_aircraft", "empty_legs", "co2_t", "hours_over_capacity", "peak_line_staff"):
            facts.append({"id": f"{c['id']}.kpis.{k}", "value": c["kpis"][k], "text": f"strategy {c['id']} {k}"})
        facts.append({"id": f"{c['id']}.approvers", "value": ", ".join(c["approvers"]), "text": f"strategy {c['id']} approvers"})
    return {"scenario": scenario, "replay_time": C.iso_local(t), "recommended": best["id"], "facts": facts,
            "top_alerts": [a["message"] for a in al[:3]]}


@router.get("/briefing")
def get_briefing(scenario: str = "medium", t: str | None = None):
    tt = query_t(t)
    facts = _briefing_facts(check_scenario(scenario), tt)
    out = explain.explain("briefing", facts, f"briefing:{scenario}:{tt:%d%H}")
    return {**out, "recommended": facts["recommended"], "facts": facts["facts"]}


@router.post("/explain", response_model=M.Explanation)
def post_explain(req: ExplainRequest):
    tt = query_t(req.t)
    facts = _briefing_facts(check_scenario(req.scenario), tt)
    return explain.explain("question", facts, f"q:{req.scenario}:{tt:%d%H}:{req.question}", req.question)


@router.get("/afteraction")
def get_afteraction(scenario: str = "medium"):
    fc = get_forecast(check_scenario(scenario))
    ds = live_dataset()
    actual = []
    for d in C.window_days():
        actual.append(sum(1 for f in ds.flights if f.stay_type != "pre_window" and f.landed.date() == d))
    rows, ape, covered = [], [], 0
    for day, a in zip(fc["days"], actual):
        rows.append({**day, "actual": a})
        if a:
            ape.append(abs(day["p50"] - a) / a * 100)
        covered += day["p10"] <= a <= day["p90"]
    naive = [day["baseline_p50"] for day in fc["days"]]
    naive_ape = [abs(n - a) / a * 100 for n, a in zip(naive, actual) if a]
    strat = engine.strategies(ds)
    chosen = store.approved_strategy() or "B"
    card = next(c for c in strat["strategies"] if c["id"] == chosen)
    occ = engine.occupancy_hourly(ds.flights)
    return {"scenario": scenario, "source": ds.source, "notes": ds.notes, "days": rows,
            "mape_pct": round(float(np.mean(ape)), 1) if ape else None,
            "naive_mape_pct": round(float(np.mean(naive_ape)), 1) if naive_ape else None,
            "interval_coverage_pct": round(covered / len(rows) * 100),
            "hours_over_capacity_no_plan": strat["status_quo"]["hours_over_capacity"],
            "hours_over_capacity_with_plan": card["kpis"]["hours_over_capacity"],
            "strategy": chosen, "strategy_kpis": card["kpis"],
            "peak_occupancy": round(float(occ.max()), 1), "capacity": engine.capacity(),
            "stand_conflicts_week": replay().conflicts, "audit": store.audit_list()[-50:],
            "out_of_sample": _out_of_sample(), "validation_note": fc.get("validation", {}).get("validation_note")}


def _out_of_sample() -> dict | None:
    """Role 2's leave-one-event-out error on the published arrival ratios: the only check not shaped on the replay."""
    rows = [r for r in ai.validation_summary() if r["check"] == "leave_one_event_out" and r["metric"] == "arrivals_ratio"]
    model = [float(r["abs_pct_error"]) for r in rows if r["method"] == "analog_mean_leave_one_out"]
    naive = [float(r["abs_pct_error"]) for r in rows if r["method"] == "naive_ordinary_week"]
    if not model or not naive:
        return None
    return {"model_pct": round(sum(model) / len(model), 1), "naive_pct": round(sum(naive) / len(naive), 1), "events": len(model)}


@router.get("/airfield/movements")
def get_airfield_movements():
    """The other FBOs' traffic at VNY in the same replayed week, so the 3D runway carries the whole field."""
    return {"source": live_dataset().source, "movements": _airfield()}


@functools.lru_cache(maxsize=1)
def _airfield() -> list[dict]:
    return airfield_movements()


@router.get("/la28")
def get_la28(scenario: str = "medium"):
    """Stretch goal: the same engine on an LA28 Olympic opening-week profile."""
    return la28.report(check_scenario(scenario))


@router.get("/settings")
def get_settings():
    return store.get_settings()


@router.put("/settings")
def put_settings(patch: dict):
    s = store.put_settings(patch)
    return s


@router.get("/audit")
def get_audit():
    return {"entries": store.audit_list()}


@router.post("/audit")
def post_audit(entry: AuditEntry):
    if entry.action not in audit.DECISIONS:
        raise HTTPException(422, "action must be approve, edit or reject")
    return store.audit_append(entry.model_dump())


@router.get("/health")
def health():
    return {"ok": True}


# ---------- parking control ----------

LAYOUTS = ("stands", "tandem")
_pins: dict[str, dict[str, str]] = {lay: {} for lay in LAYOUTS}   # manual placements, per layout

# Bookings accepted at the desk become flights on the ramp (in memory until the server restarts).
_accepted: dict[str, Flight] = {}
_accepted_meta: dict[str, dict] = {}
_accepted_v = [0]


def ops_dataset() -> Dataset:
    """The replay week plus every booking accepted at the desk: what parking, bookings and the 3D plan from."""
    return _ops_dataset(_accepted_v[0]) if _accepted else live_dataset()


@functools.lru_cache(maxsize=4)
def _ops_dataset(version: int) -> Dataset:
    base = live_dataset()
    return dataclasses.replace(base, flights=base.flights + list(_accepted.values()))


class AssignRequest(BaseModel):
    flight_id: str
    position_id: str | None = None
    confirm: bool = False
    actor_role: str = "Line supervisor"
    replay_t_local: str | None = None
    layout: str = "stands"


def check_layout(layout: str) -> str:
    if layout not in LAYOUTS:
        raise HTTPException(422, f"layout must be one of {', '.join(LAYOUTS)}")
    return layout


@functools.lru_cache(maxsize=32)
def _parking_plan(method: str, temp: bool, layout: str, key: str) -> parking.Plan:
    return parking.build(ops_dataset(), method, temp, dict(_pins[layout]), layout)


def parking_plan(method: str, temp: bool, layout: str = "stands") -> parking.Plan:
    if method not in parking.METHODS:
        raise HTTPException(422, f"method must be one of {', '.join(parking.METHODS)}")
    check_layout(layout)
    return _parking_plan(method, temp, layout, f"{parking.pins_key(_pins[layout])}-{_accepted_v[0]}")


@router.get("/parking/plan")
def get_parking_plan(method: str = "optimized", temp: bool = False, layout: str = "stands"):
    ds = ops_dataset()
    plan = parking_plan(method, temp, layout)
    other = parking_plan("optimized" if method == "first_come" else "first_come", temp, layout)
    return {"method": method, "temp_zone": temp, "layout": layout, "source": ds.source,
            "positions": [p.to_dict() for p in plan.positions],
            "metrics": parking.metrics(ds, plan), "compare": parking.metrics(ds, other),
            "gantt": parking.gantt(ds, plan, ds.bookings), "tows": plan.tows,
            "pins": dict(_pins[layout]), "booked": sorted(_accepted), "window": [d.isoformat() for d in C.window_days()]}


@router.get("/parking/state")
def get_parking_state(t: str | None = None, method: str = "optimized", temp: bool = False, layout: str = "stands"):
    return parking.state(ops_dataset(), parking_plan(method, temp, check_layout(layout)), query_t(t))


@router.get("/parking/reservations")
def get_parking_reservations(day: str = "2027-02-12", method: str = "optimized", temp: bool = False, layout: str = "stands"):
    return {"day": day, "items": parking.recommendations(ops_dataset(), parking_plan(method, temp, layout), day)}


@router.post("/parking/assign")
def post_parking_assign(req: AssignRequest):
    """Check a manual move; with confirm=true, pin it, re-plan everyone else around it, and log it."""
    ds, pins = ops_dataset(), _pins[check_layout(req.layout)]
    before = parking.metrics(ds, parking_plan("optimized", False, req.layout))
    if req.position_id is None:
        if req.confirm:
            pins.pop(req.flight_id, None)
        return {"ok": True, "issues": [], "pins": dict(pins)}
    issues = parking.validate_move(ds, parking_plan("optimized", False, req.layout), req.flight_id, req.position_id)
    trial = dict(pins)
    trial[req.flight_id] = req.position_id
    after = parking.metrics(ds, parking.build(ds, "optimized", False, trial, req.layout))
    if req.confirm and not issues:
        pins[req.flight_id] = req.position_id
        store.audit_append({"action": "edit", "target": f"parking:{req.flight_id}->{req.position_id}",
                            "actor_role": req.actor_role, "note": "Manual stand assignment",
                            "replay_t_local": req.replay_t_local})
    return {"ok": not issues, "issues": issues, "confirmed": bool(req.confirm and not issues),
            "tows_before": before["tows"], "tows_after": after["tows"], "pins": dict(pins)}


# ---------- booking desk ----------

class TripRequest(BaseModel):
    arrive_local: str
    depart_local: str
    size_class: str | None = None
    aircraft_type: str | None = None
    tail: str | None = None
    origin: str | None = None
    international: bool = False
    services: list[str] = Field(default_factory=list)
    channel: str = "FBO portal"
    t: str | None = None              # replay "now", for the hold expiry
    layout: str = "stands"            # which ramp layout to quote against


class AcceptRequest(BaseModel):
    trip_sheet: dict
    actor_role: str = "Customer service"
    replay_t_local: str | None = None
    layout: str = "stands"
    channel: str = "FBO portal"


def _quote(req: TripRequest) -> dict:
    if req.size_class is not None and req.size_class not in C.SIZE_CLASSES:
        raise HTTPException(422, f"size_class must be one of {', '.join(C.SIZE_CLASSES)}")
    if req.size_class is None and req.aircraft_type not in bookings.AIRCRAFT_TYPES:
        raise HTTPException(422, "give size_class or a known aircraft_type (ICAO designator)")
    try:
        return bookings.quote(ops_dataset(), parking_plan("optimized", False, check_layout(req.layout)), forecast.occupancy("medium"),
                              req.model_dump(), C.parse_t(req.t or demo_t()))
    except ValueError as e:
        raise HTTPException(422, f"bad time: {e}") from e


@router.post("/bookings/quote")
def post_booking_quote(req: TripRequest):
    """Instant answer for a trip request typed in at the desk."""
    return _quote(req)


@router.post("/bookings/inbound")
def post_booking_inbound(req: TripRequest):
    """Open endpoint: any scheduler, trip-services tool or FBO system can post a trip request and get the answer back."""
    return {"received_via": req.channel, **_quote(req)}


@router.post("/bookings/accept")
def post_booking_accept(req: AcceptRequest):
    """The operator accepted: the jet joins the ramp plan on the quoted position, and the trip sheet goes back."""
    sheet = {**req.trip_sheet, "parking": {**req.trip_sheet.get("parking", {}), "status": "confirmed"}}
    pos = sheet["parking"].get("position")
    if not pos:
        raise HTTPException(409, "nothing to accept: this request has no position (offer an alternative instead)")
    check_layout(req.layout)
    f = bookings.flight_from_sheet(sheet, taken=set(_accepted) | {x.flight_id for x in live_dataset().flights})
    _accepted[f.flight_id] = f
    _accepted_meta[f.flight_id] = {"request_id": sheet.get("request_id"), "channel": req.channel, "position": pos,
                                   "received_local": req.replay_t_local or demo_t(), "layout": req.layout}
    _pins[req.layout][f.flight_id] = pos
    _accepted_v[0] += 1
    store.audit_append({"action": "approve", "target": f"booking:{sheet.get('request_id')}->{pos}",
                        "actor_role": req.actor_role, "note": f"Parking confirmed for {f.flight_id}",
                        "replay_t_local": req.replay_t_local})
    return {"ok": True, "flight_id": f.flight_id, "position": pos, "trip_sheet": {**sheet, "flight_id": f.flight_id}}


@router.delete("/bookings/accepted/{flight_id}")
def delete_booking(flight_id: str):
    """Cancel an accepted booking: the jet leaves the plan and its position is free again."""
    if flight_id not in _accepted:
        raise HTTPException(404, "no accepted booking with that id")
    _accepted.pop(flight_id)
    _accepted_meta.pop(flight_id, None)
    for pins in _pins.values():
        pins.pop(flight_id, None)
    _accepted_v[0] += 1
    store.audit_append({"action": "reject", "target": f"booking:{flight_id}", "actor_role": "Customer service",
                        "note": "Booking cancelled", "replay_t_local": None})
    return {"ok": True}


@router.get("/bookings/inbox")
def get_booking_inbox(t: str | None = None, layout: str = "stands"):
    return bookings.inbox(ops_dataset(), parking_plan("optimized", False, check_layout(layout)), C.parse_t(t or demo_t()),
                          accepted=_accepted_meta)


@router.get("/bookings/connections")
def get_booking_connections():
    types = [{"code": k, "name": v[0], "size_class": v[1]} for k, v in bookings.AIRCRAFT_TYPES.items()]
    return {"connections": bookings.CONNECTIONS, "aircraft_types": types, "services": list(bookings.SERVICES)}


# ---------- AI co-pilot: every model, what it suggests now, and how each one works ----------

_bench: dict[tuple, dict] = {}
_bench_locks: dict[tuple, threading.Lock] = {}
_bench_guard = threading.Lock()


def _bench_key(layout: str, temp: bool) -> tuple:
    return (layout, temp, parking.pins_key(_pins[layout]), _accepted_v[0])


def _warm_benchmarks() -> None:
    try:  # the co-pilot is the first screen: its own answers first, then the slow solver runs
        get_ai_models("medium", "tandem")
        get_ai_recommendations(None, "medium", "tandem")
    except Exception:
        pass
    for layout, temp in (("tandem", False), ("tandem", True), ("stands", False)):
        try:
            get_ai_benchmark(layout, temp)
        except Exception:  # warm-up only; the route computes on demand
            pass


@router.get("/ai/benchmark")
def get_ai_benchmark(layout: str = "tandem", temp: bool = False):
    """Whiteboard, adaptive and exact (CP-SAT) parking on the same week; the exact solver takes a few seconds."""
    layout = check_layout(layout)
    key = _bench_key(layout, temp)
    with _bench_guard:
        lock = _bench_locks.setdefault(key, threading.Lock())
    with lock:  # a second request for the same benchmark waits for the first instead of solving again
        if key not in _bench:
            ds = ops_dataset()
            rows = {m: parking.metrics(ds, parking_plan(m, temp, layout)) for m in parking.METHODS}
            _bench[key] = ai.benchmark(rows, layout, temp)
    return _bench[key]


def _drift_evidence(ds: Dataset) -> list[dict]:
    long = [(f, parking._as_told(f)) for f in ds.flights if (f.departed_vny - f.landed) > timedelta(hours=3)]
    if not long:
        return []
    gaps = [(f.departed_vny - t.departed_vny).total_seconds() / 3600 for f, t in long]
    return [{"label": "Mean drift, stays over 3 h", "value": round(sum(abs(g) for g in gaps) / len(gaps), 1), "unit": "h",
             "detail": f"{len(long)} jets"},
            {"label": "Left later than they said", "value": round(sum(g > 0 for g in gaps) / len(gaps) * 100), "unit": "%",
             "detail": "the ones that box others in"}]


@router.get("/ai/models")
def get_ai_models(scenario: str = "medium", layout: str = "stands"):
    scenario, layout = check_scenario(scenario), check_layout(layout)
    fc, occ = get_forecast(scenario), get_occupancy(scenario)
    f_ev, r_ev = ai.forecast_evidence(fc, occ)
    ds = ops_dataset()
    m = parking.metrics(ds, parking_plan("optimized", False, layout))
    wb = parking.metrics(ds, parking_plan("first_come", False, layout))
    s = _strategies(scenario, {})
    best = _briefing_facts(scenario, C.parse_t(None))["recommended"]
    card = next(c for c in s["strategies"] if c["id"] == best)
    t = C.parse_t(demo_t())
    q = engine.priority_queue(live_dataset(), t, store.get_settings()["weights"])
    al = engine.alerts(live_dataset(), t)["alerts"]
    kinds: dict[str, int] = {}
    for a in al:
        kinds[a["kind"]] = kinds.get(a["kind"], 0) + 1
    inbox = bookings.inbox(ds, parking_plan("optimized", False, layout), t, accepted=_accepted_meta)
    bench = _bench.get(_bench_key(layout, False))
    cp = next((r for r in bench["rows"] if r["method"] == "cpsat"), None) if bench else None
    mods = adapters.status()
    evidence = {
        "forecast": f_ev, "ramp_mc": r_ev,
        "strategies": [{"label": "Suggested plan", "value": f"Strategy {card['id']}", "detail": card["name"]},
                       {"label": "Hours over capacity", "value": card["kpis"]["hours_over_capacity"], "unit": "h",
                        "detail": f"from {s['status_quo']['hours_over_capacity']} h with no plan"}],
        "stand_default": [{"label": "Tows this week", "value": m["tows"], "detail": f"whiteboard {wb['tows']} on the same week ({layout})"},
                          {"label": "Jets turned away", "value": m["overflow_aircraft"], "detail": f"{m['aircraft_parked']} parked"}],
        "stand_cpsat": ([{"label": "Tows this week", "value": cp["tows"], "detail": f"{cp['overflow']} turned away · {cp['solve_s']} s to solve"}]
                        if cp else [{"label": "Benchmark", "value": "not run yet", "detail": "run it in the algorithm arena"}]),
        "drift": _drift_evidence(ds),
        "booking": [{"label": "Answered automatically", "value": round(inbox["auto"] / inbox["total"] * 100) if inbox["total"] else 0,
                     "unit": "%", "detail": f"{inbox['auto']} of {inbox['total']} requests by {_hhmm(inbox['t_local'])} Fri"}],
        "priority": [{"label": "In the queue", "value": len(q["items"]), "detail": (q["items"][0]["reasons"][0] if q["items"] and q["items"][0]["reasons"] else "")}],
        "alerts": [{"label": "Alerts at the demo time", "value": len(al), "detail": ", ".join(f"{v} {k.replace('_', ' ')}" for k, v in kinds.items())}],
        "runway": [{"label": "Separation", "value": "90 s / 2 min", "detail": "arrivals / departures on 16R"}],
        "explain": [{"label": "Writer", "value": "Claude" if explain.claude_available()
                     else f"Local LLM ({explain.get_local_model_name()})" if explain.local_llm_available() else "Built-in templates",
                     "detail": "every number cites a fact id"}],
    }
    status = {"forecast": "live" if mods["forecast"] else "fallback", "ramp_mc": "live" if mods["occupancy"] else "fallback",
              "strategies": "live" if mods["strategies"] else "fallback",
              "stand_cpsat": "live" if parking.cpsat.cp_model is not None else "unavailable"}
    return ai.models(evidence, status)


def _hhmm(iso: str) -> str:
    return iso[11:16]


@router.get("/ai/recommendations")
def get_ai_recommendations(t: str | None = None, scenario: str = "medium", layout: str = "stands"):
    scenario, layout = check_scenario(scenario), check_layout(layout)
    tt = query_t(t)
    ds = ops_dataset()
    plan = parking_plan("optimized", False, layout)
    recs = ai.recommendations(
        tt, briefing=_briefing_facts(scenario, tt), strategies=_strategies(scenario, {}), approved=store.approved_strategy(),
        parking_now=parking.state(ds, plan, tt), plan_metrics=parking.metrics(ds, plan),
        temp_metrics=parking.metrics(ds, parking_plan("optimized", True, layout)),
        bench=_bench.get(_bench_key(layout, False)), alerts=engine.alerts(live_dataset(), tt)["alerts"],
        queue=engine.priority_queue(live_dataset(), tt, store.get_settings()["weights"]),
        inbox=bookings.inbox(ds, plan, tt, accepted=_accepted_meta), occ=get_occupancy(scenario),
        settings=store.get_settings(), layout=layout)
    counts = {u: sum(1 for r in recs if r["urgency"] == u) for u in ("now", "today", "this week")}
    return {"t_local": C.iso_local(tt), "scenario": scenario, "layout": layout, "items": recs, "counts": counts,
            "models_consulted": len({m for r in recs for m in r["models"]}),
            "note": "Suggestions only. Each names the numbers it used, the models behind it and who approves."}


app.include_router(router, prefix="/api")
app.include_router(router)
