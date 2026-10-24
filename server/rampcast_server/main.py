"""RAMPCAST API. Run: uvicorn rampcast_server.main:app --reload --port 8000 (from server/)."""
from __future__ import annotations

import functools
import threading
from contextlib import asynccontextmanager
from datetime import timedelta

import numpy as np
from fastapi import APIRouter, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import adapters, config as C, engine, explain, forecast, la28, parking, store
from .data import Dataset, generate_sample, load_processed
from .replay import Replay

@asynccontextmanager
async def lifespan(_: FastAPI):
    # Warm the slow caches (Monte Carlo, stand plan) in the background so the first screen loads fast.
    threading.Thread(target=lambda: (replay(), forecast.occupancy("medium"), la28.report("medium")), daemon=True).start()
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


def check_scenario(s: str) -> str:
    if s not in C.SCENARIOS:
        raise HTTPException(422, f"scenario must be one of {C.SCENARIOS}")
    return s


# ---------- models ----------

class RunwayClosed(BaseModel):
    from_: str = Field(alias="from")
    to: str
    model_config = {"populate_by_name": True}


class ArrivalDelay(BaseModel):
    from_: str = Field(alias="from")
    to: str
    minutes: int = Field(120, ge=15, le=480)
    model_config = {"populate_by_name": True}


class Modifiers(BaseModel):
    runway_closed: RunwayClosed | None = None
    arrival_delay: ArrivalDelay | None = None
    demand_multiplier: float = 1.0
    customs_hours: dict[str, list[str]] | None = None
    at: str | None = None


class PlanRequest(BaseModel):
    scenario: str = "medium"
    modifiers: Modifiers = Modifiers()


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
            "claude_enabled": explain.claude_available(), "modules": adapters.status(),
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


@router.post("/plan/strategies")
def post_strategies(req: PlanRequest):
    mods = req.modifiers.model_dump(by_alias=True, exclude_none=True)
    out = adapters.call("rampcast.engine.api", "get_strategies", _strategies, check_scenario(req.scenario), mods)
    out["approved"] = store.approved_strategy()
    return out


@router.get("/priority/queue")
def get_queue(t: str | None = None):
    return engine.priority_queue(live_dataset(), C.parse_t(t), store.get_settings()["weights"])


@router.get("/alerts")
def get_alerts(t: str | None = None):
    return engine.alerts(live_dataset(), C.parse_t(t))


@router.get("/replay/state")
def get_replay(t: str | None = None):
    return replay().state(C.parse_t(t))


@router.post("/whatif")
def post_whatif(req: PlanRequest):
    scenario = check_scenario(req.scenario)
    mods = req.modifiers.model_dump(by_alias=True, exclude_none=True)
    base = plan_dataset(scenario)
    changed = plan_dataset(scenario, mods.get("demand_multiplier", 1.0))
    affected: list[dict] = []
    t = C.parse_t(mods.get("at"))
    if mods.get("runway_closed"):
        changed, affected = engine.apply_runway_closure(changed, mods["runway_closed"])
        t = C.parse_t(mods["runway_closed"]["from"])
        mods_alert = {**mods, "affected_count": len(affected)}
    else:
        mods_alert = mods
    if mods.get("arrival_delay"):
        changed, late = engine.apply_arrival_delay(changed, mods["arrival_delay"])
        affected += late
        t = C.parse_t(mods["arrival_delay"]["from"])
        mods_alert = {**mods_alert, "affected_count": len(affected)}
    before, after = engine.strategies(base), engine.strategies(changed)
    kpi_diff = {}
    for b, a in zip(before["strategies"], after["strategies"]):
        kpi_diff[b["id"]] = {k: [b["kpis"][k], a["kpis"][k]] for k in b["kpis"] if k != "risk"}
    alerts_before = {x["id"] for x in engine.alerts(base, t)["alerts"]}
    alerts_after = engine.alerts(changed, t, mods_alert)["alerts"]
    customs_risk = [x for x in alerts_after if x["kind"] == "customs_window"]
    customs_missed = sum(1 for x in affected if x.get("customs_missed"))
    facts = {"facts": [
        {"id": "whatif.affected", "value": len(affected), "text": "inbound jets affected"},
        {"id": "whatif.max_delay_min", "value": max([x["delay_min"] for x in affected], default=0), "text": "max delay"},
        {"id": "whatif.customs_at_risk", "value": max(len(customs_risk), customs_missed), "text": "international arrivals at customs risk"},
        {"id": "whatif.hours_before", "value": before["status_quo"]["hours_over_capacity"], "text": "hours over capacity before"},
        {"id": "whatif.hours_after", "value": after["status_quo"]["hours_over_capacity"], "text": "hours over capacity after"},
    ], "modifiers": mods}
    if mods.get("arrival_delay"):
        # Fixed-time commitments the delay now breaks: deadline was reachable before, not after.
        broken = 0
        for x in affected:
            bk = base.bookings.get(x["booking_code"] or "")
            if bk and bk.deadline_local:
                drive = timedelta(minutes=engine.drive_minutes("KVNY", bk.hotel_zone) + 25)
                if C.parse_t(x["eta_local"]) + drive <= bk.deadline_local < C.parse_t(x["new_eta_local"]) + drive:
                    broken += 1
        kb, ka = before["strategies"][1]["kpis"], after["strategies"][1]["kpis"]
        facts["facts"] += [
            {"id": "whatif.peak_moves_before", "value": kb["peak_movements_per_hour"], "text": "movements in the peak hour before"},
            {"id": "whatif.peak_moves_after", "value": ka["peak_movements_per_hour"], "text": "movements in the peak hour after"},
            {"id": "whatif.staff_before", "value": kb["peak_line_staff"], "text": "line techs at the peak, strategy B, before"},
            {"id": "whatif.staff_after", "value": ka["peak_line_staff"], "text": "line techs at the peak, strategy B, after"},
            {"id": "whatif.commitments_at_risk", "value": broken, "text": "fixed-time commitments now at risk"},
        ]
    key = f"whatif:{scenario}:{sorted(mods.items())}"
    return {"scenario": scenario, "modifiers": mods, "kpi_diff": kpi_diff,
            "status_quo": {"before": before["status_quo"], "after": after["status_quo"]},
            "new_alerts": [x for x in alerts_after if x["id"] not in alerts_before],
            "affected_flights": affected, "strategies": after["strategies"],
            "explanation": explain.explain("whatif", facts, key)}


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
    tt = C.parse_t(t)
    facts = _briefing_facts(check_scenario(scenario), tt)
    out = explain.explain("briefing", facts, f"briefing:{scenario}:{tt:%d%H}")
    return {**out, "recommended": facts["recommended"], "facts": facts["facts"]}


@router.post("/explain")
def post_explain(req: ExplainRequest):
    tt = C.parse_t(req.t)
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
            "stand_conflicts_week": replay().conflicts, "audit": store.audit_list()[-50:]}


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
    if entry.action not in ("approve", "edit", "reject"):
        raise HTTPException(422, "action must be approve, edit or reject")
    return store.audit_append(entry.model_dump())


@router.get("/health")
def health():
    return {"ok": True}


# ---------- parking control ----------

_pins: dict[str, str] = {}


class AssignRequest(BaseModel):
    flight_id: str
    position_id: str | None = None
    confirm: bool = False
    actor_role: str = "Line supervisor"
    replay_t_local: str | None = None


@functools.lru_cache(maxsize=32)
def _parking_plan(method: str, temp: bool, pins_key: str) -> parking.Plan:
    return parking.build(live_dataset(), method, temp, dict(_pins))


def parking_plan(method: str, temp: bool) -> parking.Plan:
    if method not in ("optimized", "first_come"):
        raise HTTPException(422, "method must be optimized or first_come")
    return _parking_plan(method, temp, parking.pins_key(_pins))


@router.get("/parking/plan")
def get_parking_plan(method: str = "optimized", temp: bool = False):
    ds = live_dataset()
    plan = parking_plan(method, temp)
    other = parking_plan("first_come" if method == "optimized" else "optimized", temp)
    return {"method": method, "temp_zone": temp, "source": ds.source,
            "positions": [p.to_dict() for p in plan.positions],
            "metrics": parking.metrics(ds, plan), "compare": parking.metrics(ds, other),
            "gantt": parking.gantt(ds, plan, ds.bookings), "tows": plan.tows,
            "pins": dict(_pins), "window": [d.isoformat() for d in C.window_days()]}


@router.get("/parking/state")
def get_parking_state(t: str | None = None, method: str = "optimized", temp: bool = False):
    return parking.state(live_dataset(), parking_plan(method, temp), C.parse_t(t))


@router.get("/parking/reservations")
def get_parking_reservations(day: str = "2027-02-12", method: str = "optimized", temp: bool = False):
    return {"day": day, "items": parking.recommendations(live_dataset(), parking_plan(method, temp), day)}


@router.post("/parking/assign")
def post_parking_assign(req: AssignRequest):
    """Check a manual move; with confirm=true, pin it, re-plan everyone else around it, and log it."""
    ds = live_dataset()
    before = parking.metrics(ds, parking_plan("optimized", False))
    if req.position_id is None:
        if req.confirm:
            _pins.pop(req.flight_id, None)
        return {"ok": True, "issues": [], "pins": dict(_pins)}
    issues = parking.validate_move(ds, parking_plan("optimized", False), req.flight_id, req.position_id)
    trial = dict(_pins)
    trial[req.flight_id] = req.position_id
    after = parking.metrics(ds, parking.build(ds, "optimized", False, trial))
    if req.confirm and not issues:
        _pins[req.flight_id] = req.position_id
        store.audit_append({"action": "edit", "target": f"parking:{req.flight_id}->{req.position_id}",
                            "actor_role": req.actor_role, "note": "Manual stand assignment",
                            "replay_t_local": req.replay_t_local})
    return {"ok": not issues, "issues": issues, "confirmed": bool(req.confirm and not issues),
            "tows_before": before["tows"], "tows_after": after["tows"], "pins": dict(_pins)}


app.include_router(router, prefix="/api")
app.include_router(router)
