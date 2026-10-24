"""Reference decision engine: occupancy, stand plan, strategies, priority queue, alerts, what-if.

Every function returns plain dicts shaped like contracts/README.md. Nothing here takes an action;
each output is a suggestion with reasons and the role that must approve it.
"""
from __future__ import annotations

import math
from dataclasses import replace
from datetime import datetime, timedelta

import numpy as np

from . import config as C
from .data import KVNY, Dataset, Flight, great_circle_nm

A = C.assumptions


# ---------- occupancy ----------

def _hours(t: datetime) -> float:
    return (t - C.window_start_local()).total_seconds() / 3600


def occupancy_hourly(flights: list[Flight]) -> np.ndarray:
    """Large-cabin equivalents on the ramp at the middle of each hour of the window."""
    mids = np.arange(C.n_hours()) + 0.5
    occ = np.zeros(C.n_hours())
    for f in flights:
        lo, hi = _hours(f.landed), _hours(f.departed_vny)
        occ += f.footprint * ((mids >= lo) & (mids < hi))
    return occ


def movements_hourly(flights: list[Flight]) -> np.ndarray:
    moves = np.zeros(C.n_hours())
    for f in flights:
        for t in (f.landed, f.departed_vny):
            h = int(_hours(t))
            if 0 <= h < C.n_hours():
                moves[h] += 1
    return moves


def capacity() -> float:
    from .store import get_settings
    return float(get_settings().get("capacity") or A()["fbo"]["capacity_large_equiv"])


# ---------- stand plan ----------

def assign_stands(flights: list[Flight], stands: list[dict]) -> dict[str, dict]:
    """Greedy, departure-order-aware stand plan. A jet parked deeper should leave no earlier than the jet in front.

    Returns flight_id -> {stand_id or None, conflicts}. None means no stand fits (overflow).
    """
    by_id = {s["stand_id"]: s for s in stands}
    occupant: dict[str, Flight | None] = {s["stand_id"]: None for s in stands}
    plan: dict[str, dict] = {}
    events = sorted([(f.landed, 1, f) for f in flights] + [(f.departed_vny, 0, f) for f in flights],
                    key=lambda e: (e[0], e[1]))
    for t, kind, f in events:
        if kind == 0:
            sid = plan.get(f.flight_id, {}).get("stand_id")
            if sid and occupant.get(sid) is f:
                occupant[sid] = None
            continue
        span = C.WINGSPAN_FT.get(f.size_class, 60)
        long_stay = f.stay_type in ("through_game", "pre_window") or (f.departed_vny - f.landed) > timedelta(hours=20)
        best, best_key = None, None
        for sid, occ in occupant.items():
            s = by_id[sid]
            if occ is not None or s["max_wingspan_ft"] < span:
                continue
            conflicts = 0
            for other_id, other in occupant.items():
                if other is None:
                    continue
                o = by_id[other_id]
                if o["row"] != s["row"] or o.get("column") != s.get("column"):
                    continue
                if o["depth"] < s["depth"] and other.departed_vny > f.departed_vny:
                    conflicts += 1  # the jet in front leaves later: we'd be boxed in
                if o["depth"] > s["depth"] and other.departed_vny < f.departed_vny:
                    conflicts += 1  # we'd box in the jet behind
            depth_pref = (3 - s["depth"]) if long_stay else s["depth"]
            key = (conflicts, depth_pref, s["max_wingspan_ft"] - span, sid)
            if best_key is None or key < best_key:
                best, best_key = sid, key
        if best is None:
            plan[f.flight_id] = {"stand_id": None, "conflicts": 0}
        else:
            occupant[best] = f
            plan[f.flight_id] = {"stand_id": best, "conflicts": best_key[0]}
    return plan


# ---------- strategies ----------

def _cap_sim(flights: list[Flight], cap: float) -> tuple[list[Flight], list[Flight]]:
    """First-come parking under a cap. Drop-and-go always handled; stays beyond the cap overflow."""
    kept, overflow = [], []
    events = sorted([(f.landed, 1, f) for f in flights] + [(f.departed_vny, 0, f) for f in flights],
                    key=lambda e: (e[0], e[1]))
    occ, parked = 0.0, set()
    for _, kind, f in events:
        if kind == 0:
            if f.flight_id in parked:
                occ -= f.footprint
                parked.discard(f.flight_id)
            continue
        if f.stay_type == "drop_and_go" or occ + f.footprint <= cap:
            occ += f.footprint
            parked.add(f.flight_id)
            kept.append(f)
        else:
            overflow.append(f)
    return kept, overflow


def _as_drop_and_go(f: Flight) -> Flight:
    return replace(f, departed_vny=f.landed + timedelta(minutes=90), stay_type="drop_and_go")


def _staff(flights: list[Flight], extra: int = 0) -> tuple[int, int]:
    moves = movements_hourly(flights)
    peak = int(moves.max()) if len(moves) else 0
    return math.ceil(peak / 3) * 2 + 2 + extra, peak


def strategies(ds: Dataset) -> dict:
    a = A()
    cap = capacity()
    buffer = a["fbo"]["reservation_buffer_pct"] / 100
    cap_eff = cap * (1 - buffer)
    temp = a["fbo"]["temp_taxiway_stands"]
    fuel = a["fuel"]
    ov = a["overflow"]
    co2 = fuel["co2_kg_per_gal"]
    gal_nm = fuel["gal_per_nm_repositioning"]
    flights = [f for f in ds.flights if f.landed < C.window_start_local() + timedelta(hours=C.n_hours())]
    arrivals = [f for f in flights if f.stay_type != "pre_window"]
    unconstrained = occupancy_hourly(flights)
    status_quo_hours = int((unconstrained > cap).sum())

    def card(sid, name, summary, overflow, nm, extra_cap, approvers, risk, extra_staff, note):
        kept_ids = {f.flight_id for f in overflow}
        after = [(_as_drop_and_go(f) if f.flight_id in kept_ids else f) for f in flights]
        occ_after = occupancy_hourly(after)
        hours_over = int((occ_after > cap + extra_cap).sum())
        legs = len(overflow) * ov["empty_legs_per_overflow_aircraft"]
        co2_t = legs * nm * gal_nm * co2 / 1000
        adhoc_t = legs * ov["adhoc_reposition_nm"] * gal_nm * co2 / 1000
        staff, peak_moves = _staff(after, extra_staff)
        deps = sum(1 for f in after if C.window_start_local() <= f.departed_vny)
        kpis = {
            "aircraft_accommodated": len(arrivals),
            "parked_at_vny": len(arrivals) - len(overflow),
            "overflow_aircraft": len(overflow),
            "hours_over_capacity": hours_over,
            "empty_legs": legs,
            "co2_t": round(co2_t, 1),
            "co2_saved_vs_adhoc_t": round(adhoc_t - co2_t, 1),
            "peak_line_staff": staff,
            "peak_movements_per_hour": peak_moves,
            "fuel_gal_week": deps * fuel["gal_per_departure_blended"],
            "risk": risk,
        }
        facts = [
            {"id": f"{sid}.kpis.overflow_aircraft", "text": f"{len(overflow)} aircraft cannot stay on our ramp"},
            {"id": f"{sid}.kpis.empty_legs", "text": f"{legs} empty repositioning legs"},
            {"id": f"{sid}.kpis.co2_t", "text": f"{co2_t:.1f} t CO2 from those legs"},
            {"id": f"{sid}.kpis.hours_over_capacity", "text": f"{hours_over} hours over capacity after the plan"},
            {"id": f"{sid}.kpis.peak_line_staff", "text": f"{staff} line techs at the peak hour"},
        ]
        return {"id": sid, "name": name, "summary": summary, "kpis": kpis, "approvers": approvers,
                "assumptions": [f"assumptions.yaml#{k}" for k in note], "explanation_facts": facts}

    _, ov_a = _cap_sim(flights, cap_eff)
    _, ov_c = _cap_sim(flights, cap_eff + temp)
    cards = [
        card("A", "Cap overnight stays + drop-and-go",
             f"Book overnight stands up to {cap_eff:.0f} of {cap:.0f}. Extra arrivals drop passengers and leave.",
             ov_a, ov["adhoc_reposition_nm"], 0, ["FBO general manager"], "medium", 0,
             ["fbo.reservation_buffer_pct", "overflow.adhoc_reposition_nm"]),
        card("B", "Partner-airport overflow",
             "Same cap. Overflow jets reposition to partner FBOs at WHP, CMA or BUR, then return for pickup.",
             ov_a, ov["partner_reposition_nm"], 0, ["FBO general manager", "Partner FBOs (WHP, CMA, BUR)"], "low", 2,
             ["overflow.partner_airports", "overflow.partner_reposition_nm"]),
        card("C", "Temporary taxiway parking",
             f"Close a taxiway for {temp} extra stands. Remaining overflow goes to partners.",
             ov_c, ov["partner_reposition_nm"], temp, ["FBO general manager", "Airport operations", "FAA"], "high", 4,
             ["fbo.temp_taxiway_stands", "overflow.partner_reposition_nm"]),
    ]
    return {"scenario": ds.scenario, "source": ds.source, "capacity": cap,
            "status_quo": {"hours_over_capacity": status_quo_hours, "peak_demand": round(float(unconstrained.max()), 1)},
            "strategies": cards}


# ---------- priority queue ----------

def eta_band_min(minutes_to_go: float) -> float:
    """P90 arrival-time spread. Reference shape; the ML module calibrates it on 2022 tracks."""
    return min(45.0, 4 + 0.08 * max(0.0, minutes_to_go))


def customs_close(day: datetime, override: dict | None = None) -> datetime:
    hours = dict(A()["customs_kvny"]["hours_local"])
    if override:
        hours.update(override)
    key = day.strftime("%a").lower()
    close = hours.get(key, ["09:00", "20:30"])[1]
    hh, mm = map(int, close.split(":"))
    return day.astimezone(C.LA).replace(hour=hh, minute=mm, second=0, microsecond=0)


def drive_minutes(airport: str, zone: str) -> int:
    return int(A()["drive_minutes"].get(airport, A()["drive_minutes"]["KVNY"]).get(zone, 45))


def priority_queue(ds: Dataset, t: datetime, weights: dict, customs_override: dict | None = None) -> dict:
    items = []
    for f in ds.flights:
        b = ds.bookings.get(f.booking_code or "")
        if not b:
            continue
        mins_to = (f.landed - t).total_seconds() / 60
        if not (-35 <= mins_to <= 180):
            continue
        status = "inbound" if mins_to > 0 else "on_ground"
        p90 = f.landed + timedelta(minutes=eta_band_min(mins_to))
        comp = {"fixed_time": 0.0, "medical_access": 0.0, "hard_deadline": 0.0, "wait": 0.0}
        reasons, slack = [], None
        drive = drive_minutes("KVNY", b.hotel_zone)
        if b.commitment_type == "fixed_time" and b.deadline_local:
            slack = int((b.deadline_local - (f.landed + timedelta(minutes=20 + drive))).total_seconds() // 60)
            comp["fixed_time"] = float(np.clip((180 - slack) / 180, 0, 1))
            reasons.append(f"Fixed-time commitment in {b.hotel_zone} at {b.deadline_local:%H:%M}; "
                           f"{slack} min of slack after a {drive}-min drive")
        if b.commitment_type == "medical_access":
            comp["medical_access"] = 1.0
            reasons.append("Medical or accessibility assistance requested")
        if f.is_international:
            close = customs_close(f.landed, customs_override)
            if p90 > close:
                comp["hard_deadline"] = 1.0
                reasons.append(f"Customs closes {close:%H:%M}; P90 arrival {p90:%H:%M}")
            else:
                reasons.append(f"International: customs inspection at Signature West before release")
        if status == "on_ground":
            waited = -mins_to
            comp["wait"] = float(min(1.0, waited / 30))
            reasons.append(f"Waiting {int(waited)} min since landing")
        if not reasons:
            reasons.append("No time commitment; served in arrival order")
        score = sum(weights.get(k, 0) * v for k, v in comp.items())
        items.append({"booking_code": b.booking_code, "flight_id": f.flight_id, "status": status,
                      "eta_local": C.iso_local(f.landed), "eta_p90_local": C.iso_local(p90),
                      "size_class": f.size_class, "origin": f.origin, "is_international": f.is_international,
                      "party_size": b.party_size, "hotel_zone": b.hotel_zone, "score": round(score, 3),
                      "components": comp, "slack_min": slack, "reasons": reasons, "synthetic": b.synthetic})
    items.sort(key=lambda i: (-i["score"], i["eta_local"]))
    for rank, i in enumerate(items, 1):
        i["rank"] = rank
    return {"t_local": C.iso_local(t), "weights": weights, "items": items,
            "policy": "Need-based only: fixed-time commitments, medical/accessibility, hard deadlines, wait time. "
                      "Identity, status and payment are never inputs."}


# ---------- alerts ----------

def alerts(ds: Dataset, t: datetime, modifiers: dict | None = None) -> dict:
    modifiers = modifiers or {}
    a = A()
    out = []
    cap = capacity()
    occ = occupancy_hourly(ds.flights)
    h0 = C.hour_index(t)
    look = a["alerts"]["ramp_lookahead_h"]
    window_occ = occ[max(0, h0): max(0, h0) + look + 1]
    if len(window_occ):
        peak = float(window_occ.max())
        pct = peak / cap * 100
        if pct >= a["alerts"]["ramp_threshold_pct"]:
            at = C.window_start_local() + timedelta(hours=max(0, h0) + int(window_occ.argmax()))
            out.append({"id": f"AL-RAMP-{at:%d%H}", "severity": "high" if pct >= 100 else "watch", "kind": "ramp_capacity",
                        "message": f"Ramp reaches {pct:.0f}% of capacity ({peak:.1f} of {cap:.0f}) around {at:%a %H:%M}",
                        "recommended_action": "Review today's strategy card; confirm drop-and-go quota and partner stands",
                        "owner_role": "FBO general manager", "t_local": C.iso_local(at)})
    rc = modifiers.get("runway_closed")
    if rc:
        r_from, r_to = C.parse_t(rc["from"]), C.parse_t(rc["to"])
        if r_from - timedelta(hours=2) <= t <= r_to:
            n = modifiers.get("affected_count", sum(1 for f in ds.flights if r_from <= f.landed <= r_to))
            out.append({"id": "AL-RWY", "severity": "high", "kind": "runway",
                        "message": f"Runway 16R/34L closed {r_from:%H:%M}-{r_to:%H:%M}; {n} of our inbounds affected",
                        "recommended_action": "Send alternate-option cards to operators' dispatchers; hold their stands",
                        "owner_role": "Customer service", "t_local": C.iso_local(r_from)})
    for f in ds.flights:
        mins_to = (f.landed - t).total_seconds() / 60
        if f.is_international and 0 < mins_to <= 360:
            close = customs_close(f.landed, modifiers.get("customs_hours"))
            p90 = f.landed + timedelta(minutes=eta_band_min(mins_to))
            if p90 > close:
                sev = "high" if f.landed > close else "watch"
                out.append({"id": f"AL-CBP-{f.flight_id}", "severity": sev, "kind": "customs_window",
                            "message": f"{f.flight_id} from {f.origin_name}: P90 arrival {p90:%H:%M} is after VNY customs closes at {close:%H:%M}",
                            "recommended_action": "Draft a customs extension request for a person to send to CBP landing rights",
                            "owner_role": "Customer service", "t_local": C.iso_local(f.landed), "flight_id": f.flight_id})
    late = [f for f in ds.flights if 0 < (f.departed_vny - t).total_seconds() / 3600 <= 10
            and (f.departed_vny.hour >= 22 or f.departed_vny.hour < 7)]
    if late:
        out.append({"id": f"AL-CURFEW-{h0}", "severity": "info", "kind": "curfew",
                    "message": f"{len(late)} departures planned between 22:00 and 07:00 in the next 10 h",
                    "recommended_action": "Confirm each aircraft's noise stage against the VNY curfew before night release",
                    "owner_role": "Line supervisor", "t_local": C.iso_local(late[0].departed_vny)})
    for ca in modifiers.get("car_moves", []):
        out.append({"id": f"AL-CAR-{ca['booking_code']}", "severity": "watch", "kind": "car_wrong_airport",
                    "message": f"Car for {ca['booking_code']} is staged at KVNY but the jet may land at {ca['to']}",
                    "recommended_action": "Ground dispatcher re-stages the car once the operator confirms the airport",
                    "owner_role": "Ground dispatcher", "t_local": C.iso_local(t)})
    order = {"high": 0, "watch": 1, "info": 2}
    out.sort(key=lambda x: (order[x["severity"]], x["t_local"]))
    return {"t_local": C.iso_local(t), "alerts": out}


# ---------- what-if ----------

def alternates(f: Flight, zone: str, delay_min: int) -> list[dict]:
    a = A()
    need = a["runway_needed_ft"].get(f.size_class, 5000)
    base_drive = drive_minutes("KVNY", zone)
    opts = [{"airport": "KVNY", "name": "Hold for Van Nuys", "expected_delay_min": delay_min,
             "extra_drive_min": 0, "customs": "yes" if f.is_international else "n/a", "parking": "own stand held",
             "score": delay_min, "notes": ["Stand held for 90 min", "Pilot and ATC decide holding"]}]
    for icao, alt in a["alternates"].items():
        if alt["runway_ft"] < need:
            continue
        customs = alt["customs"]
        if f.is_international and customs == "no":
            continue
        extra = drive_minutes(icao, zone) - base_drive
        dist = great_circle_nm(*KVNY, *_airport_ll(icao))
        score = max(0, extra) + 8 + dist / 4 + (0 if alt["partner_parking"] else 25) + (30 if f.is_international and customs == "verify" else 0)
        notes = [f"Runway {alt['runway_ft']:,} ft (need {need:,} ft for {f.size_class.replace('_', '-')})"]
        if f.is_international:
            notes.append("Customs available" if customs == "yes" else "Customs availability must be verified")
        notes.append("Partner FBO parking" if alt["partner_parking"] else "No partner parking agreement")
        opts.append({"airport": icao, "name": alt["name"], "expected_delay_min": 0, "extra_drive_min": extra,
                     "customs": customs if f.is_international else "n/a",
                     "parking": "partner FBO" if alt["partner_parking"] else "ad hoc", "score": round(score, 1),
                     "notes": notes})
    opts.sort(key=lambda o: o["score"])
    return opts[:4]


_LL = {"KBUR": (34.2007, -118.3585), "KWHP": (34.2593, -118.4134), "KCMA": (34.2137, -119.0943),
       "KLGB": (33.8177, -118.1516), "KONT": (34.0560, -117.6012), "KLAX": (33.9425, -118.4081), "KVNY": KVNY}


def _airport_ll(icao: str) -> tuple[float, float]:
    return _LL.get(icao, KVNY)


def apply_runway_closure(ds: Dataset, rc: dict) -> tuple[Dataset, list[dict]]:
    r_from, r_to = C.parse_t(rc["from"]), C.parse_t(rc["to"])
    hit = sorted([f for f in ds.flights if r_from <= f.landed <= r_to], key=lambda f: f.landed)
    new_landed = {f.flight_id: max(f.landed, r_to + timedelta(minutes=3 * i)) for i, f in enumerate(hit)}
    flights = []
    for f in ds.flights:
        if f.flight_id in new_landed:
            nl = new_landed[f.flight_id]
            flights.append(replace(f, landed=nl, departed_vny=max(f.departed_vny, nl + timedelta(minutes=50))))
        else:
            flights.append(f)
    affected = []
    for f in hit:
        b = ds.bookings.get(f.booking_code or "")
        delay = int((new_landed[f.flight_id] - f.landed).total_seconds() // 60)
        zone = b.hotel_zone if b else "Beverly Hills"
        affected.append({"flight_id": f.flight_id, "booking_code": f.booking_code, "size_class": f.size_class,
                         "origin": f.origin, "origin_name": f.origin_name, "is_international": f.is_international,
                         "eta_local": C.iso_local(f.landed), "new_eta_local": C.iso_local(new_landed[f.flight_id]),
                         "delay_min": delay, "hotel_zone": zone, "cause": "runway_closure",
                         "options": alternates(f, zone, delay),
                         "decided_by": "Operator dispatcher and pilot in command"})
    return Dataset(ds.source, ds.scenario, sorted(flights, key=lambda f: f.landed), ds.bookings, ds.stands, ds.notes), affected


def apply_arrival_delay(ds: Dataset, ad: dict) -> tuple[Dataset, list[dict]]:
    """A bank of inbound jets lands late (weather at origin, a ground delay program): same jets, later times."""
    a_from, a_to, mins = C.parse_t(ad["from"]), C.parse_t(ad["to"]), int(ad.get("minutes", 120))
    hit = sorted([f for f in ds.flights if f.stay_type != "pre_window" and a_from <= f.landed <= a_to], key=lambda f: f.landed)
    late = {f.flight_id for f in hit}
    flights = []
    for f in ds.flights:
        if f.flight_id in late:
            nl = f.landed + timedelta(minutes=mins)
            flights.append(replace(f, departed_origin=f.departed_origin + timedelta(minutes=mins), landed=nl,
                                   departed_vny=max(f.departed_vny, nl + timedelta(minutes=50))))
        else:
            flights.append(f)
    affected = []
    for f in hit:
        b = ds.bookings.get(f.booking_code or "")
        zone = b.hotel_zone if b else "Beverly Hills"
        nl = f.landed + timedelta(minutes=mins)
        affected.append({"flight_id": f.flight_id, "booking_code": f.booking_code, "size_class": f.size_class,
                         "origin": f.origin, "origin_name": f.origin_name, "is_international": f.is_international,
                         "eta_local": C.iso_local(f.landed), "new_eta_local": C.iso_local(nl),
                         "delay_min": mins, "hotel_zone": zone, "cause": "arrival_delay",
                         "customs_missed": bool(f.is_international and nl > customs_close(nl)),
                         "options": alternates(f, zone, mins),
                         "decided_by": "Operator dispatcher and pilot in command"})
    return Dataset(ds.source, ds.scenario, sorted(flights, key=lambda f: f.landed), ds.bookings, ds.stands, ds.notes), affected
