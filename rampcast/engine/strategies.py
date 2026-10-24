"""Strategy generator: three genuinely different preparation plans, each chosen by OR-Tools CP-SAT.

For every plan the solver decides which arriving jets keep an overnight stand and which drop off their
passengers and leave, so the ramp stays under the booking cap in every hour of the week.
- A  Cap overnight stays + drop-and-go quota. Overflow jets find their own parking (ad hoc reposition).
- B  Partner-airport overflow. Same cap; the solver also sends each overflow jet to WHP, CMA or BUR within
     the spaces each partner holds, nearest first. Fuel and CO2 come from the real distance to that partner.
- C  Temporary taxiway parking (+stands). Needs airport operations and the FAA. Remaining overflow as in B.
Objective, in order: no hour over the cap; fewest jets turned away (each one is two empty legs); shortest
repositioning distance; and, among equals, jets that arrived first keep their stand.
Scored on aircraft accommodated, hours over capacity, empty legs, CO2, peak staff, fuel and risk.
"""
from __future__ import annotations

from datetime import timedelta

import numpy as np

from rampcast_server import config as C
from rampcast_server.data import KVNY, Dataset, Flight, great_circle_nm

from .common import A, airport_ll, as_drop_and_go, capacity, occupancy_hourly, staff

try:
    from ortools.sat.python import cp_model
except ImportError:  # pragma: no cover
    cp_model = None

SCALE = 10                    # footprints are multiples of 0.1 large-cabin equivalents
HOUR_OVER_COST = 1_000_000    # one hour over the cap outweighs any number of turned-away jets
TURN_AWAY_COST = 10_000
WORKERS, TIME_LIMIT_S = 8, 20.0
LAST_STATUS = [""]


def _partner_nm() -> dict[str, float]:
    return {k: round(great_circle_nm(*KVNY, *airport_ll(k)), 1) for k in A()["overflow"]["partner_airports"]}


def _hourly(f: Flight) -> np.ndarray:
    return np.rint(occupancy_hourly([f]) * SCALE).astype(int)


def choose(flights: list[Flight], cap: float, partners: dict[str, float] | None = None) -> tuple[list[Flight], dict[str, str]]:
    """Which jets give up their overnight stand, and (with partners) where each one goes.

    Returns (overflow flights, flight_id -> partner ICAO or "adhoc").
    """
    cands = [f for f in flights if f.stay_type not in ("pre_window", "drop_and_go")]
    fixed = [f for f in flights if f.stay_type in ("pre_window", "drop_and_go")]
    if cp_model is None:
        return _first_come(flights, cap), {}
    base = sum((_hourly(f) for f in fixed), np.zeros(C.n_hours(), dtype=int))
    full = {f.flight_id: _hourly(f) for f in cands}
    dg = {f.flight_id: _hourly(as_drop_and_go(f)) for f in cands}
    cap_i = int(round(cap * SCALE))
    order = {f.flight_id: i for i, f in enumerate(sorted(cands, key=lambda f: (f.landed, f.flight_id)))}

    m = cp_model.CpModel()
    keep = {f.flight_id: m.NewBoolVar(f"keep[{f.flight_id}]") for f in cands}
    over_h = []
    for h in range(C.n_hours()):
        terms = [(full[fid][h] - dg[fid][h]) * keep[fid] for fid in keep if full[fid][h] != dg[fid][h]]
        load = int(base[h]) + sum(int(dg[fid][h]) for fid in keep)
        if not terms and load <= cap_i:
            continue
        s = m.NewIntVar(0, 10_000, f"over[{h}]")
        b = m.NewBoolVar(f"hour_over[{h}]")
        m.Add(load + sum(terms) - s <= cap_i)
        m.Add(s == 0).OnlyEnforceIf(b.Not())
        over_h.append(b)
    n = len(cands)
    cost = [HOUR_OVER_COST * b for b in over_h]
    cost += [(TURN_AWAY_COST + (n - order[fid])) * (1 - keep[fid]) for fid in keep]

    where: dict[tuple[str, str], object] = {}
    if partners:
        spaces = A()["overflow"]["partner_spaces"]
        for f in cands:
            fid = f.flight_id
            opts = [m.NewBoolVar(f"to[{fid},{k}]") for k in partners] + [m.NewBoolVar(f"to[{fid},adhoc]")]
            for k, v in zip(list(partners) + ["adhoc"], opts):
                where[fid, k] = v
            m.Add(sum(opts) == 1 - keep[fid])
        # Each partner holds a fixed number of spaces while our jets wait there.
        for k in partners:
            ivs, demands = [], []
            for f in cands:
                lo = int((f.landed - C.window_start_local()).total_seconds() // 60) + 90
                hi = int((f.departed_vny - C.window_start_local()).total_seconds() // 60)
                if hi > lo:
                    ivs.append(m.NewOptionalFixedSizeIntervalVar(lo, hi - lo, where[f.flight_id, k], ""))
                    demands.append(int(round(f.footprint * SCALE)))
            m.AddCumulative(ivs, demands, int(spaces.get(k, 0) * SCALE))
        adhoc_nm = A()["overflow"]["adhoc_reposition_nm"]
        cost += [int(round(nm)) * where[fid, k] for (fid, k), _ in where.items() for nm in [partners.get(k, adhoc_nm)]]
    m.Minimize(sum(cost))

    sv = cp_model.CpSolver()
    sv.parameters.num_workers = WORKERS
    sv.parameters.random_seed = 2027
    sv.parameters.max_time_in_seconds = TIME_LIMIT_S
    st = sv.Solve(m)
    LAST_STATUS[0] = sv.StatusName(st)
    if st not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return _first_come(flights, cap), {}
    overflow = [f for f in cands if not sv.Value(keep[f.flight_id])]
    dest = {}
    if partners:
        for f in overflow:
            dest[f.flight_id] = next(k for k in list(partners) + ["adhoc"] if sv.Value(where[f.flight_id, k]))
    return overflow, dest


def _first_come(flights: list[Flight], cap: float) -> list[Flight]:
    """Fallback without the solver: first-come parking under the cap."""
    overflow, occ, parked = [], 0.0, set()
    events = sorted([(f.landed, 1, f) for f in flights] + [(f.departed_vny, 0, f) for f in flights], key=lambda e: (e[0], e[1]))
    for _, kind, f in events:
        if kind == 0:
            if f.flight_id in parked:
                occ -= f.footprint
                parked.discard(f.flight_id)
        elif f.stay_type == "drop_and_go" or occ + f.footprint <= cap:
            occ += f.footprint
            parked.add(f.flight_id)
        else:
            overflow.append(f)
    return overflow


def strategies(ds: Dataset) -> dict:
    a = A()
    cap = capacity()
    cap_eff = cap * (1 - a["fbo"]["reservation_buffer_pct"] / 100)
    temp = a["fbo"]["temp_taxiway_stands"]
    fuel, ov = a["fuel"], a["overflow"]
    co2, gal_nm = fuel["co2_kg_per_gal"], fuel["gal_per_nm_repositioning"]
    legs_per = ov["empty_legs_per_overflow_aircraft"]
    partners = _partner_nm()
    flights = [f for f in ds.flights if f.landed < C.window_start_local() + timedelta(hours=C.n_hours())]
    arrivals = [f for f in flights if f.stay_type != "pre_window"]
    unconstrained = occupancy_hourly(flights)
    status_quo_hours = int((unconstrained > cap).sum())

    def card(sid, name, summary, overflow, dest, extra_cap, approvers, risk, extra_staff, note):
        ids = {f.flight_id for f in overflow}
        after = [(as_drop_and_go(f) if f.flight_id in ids else f) for f in flights]
        hours_over = int((occupancy_hourly(after) > cap + extra_cap).sum())
        nm = {f.flight_id: partners.get(dest.get(f.flight_id, "adhoc"), ov["adhoc_reposition_nm"]) for f in overflow}
        legs = len(overflow) * legs_per
        repo_gal = sum(legs_per * nm[f.flight_id] * gal_nm for f in overflow)
        co2_t = repo_gal * co2 / 1000
        adhoc_t = legs * ov["adhoc_reposition_nm"] * gal_nm * co2 / 1000
        peak_staff, peak_moves = staff(after, extra_staff)
        deps = sum(1 for f in after if C.window_start_local() <= f.departed_vny)
        split = {k: sum(1 for v in dest.values() if v == k) for k in list(partners) + ["adhoc"]} if dest else {}
        kpis = {
            "aircraft_accommodated": len(arrivals),
            "parked_at_vny": len(arrivals) - len(overflow),
            "overflow_aircraft": len(overflow),
            "hours_over_capacity": hours_over,
            "empty_legs": legs,
            "co2_t": round(co2_t, 1),
            "co2_saved_vs_adhoc_t": round(adhoc_t - co2_t, 1),
            "reposition_fuel_gal": int(round(repo_gal)),
            "peak_line_staff": peak_staff,
            "peak_movements_per_hour": peak_moves,
            "fuel_gal_week": deps * fuel["gal_per_departure_blended"],
            "risk": risk,
        }
        facts = [
            {"id": f"{sid}.kpis.overflow_aircraft", "text": f"{len(overflow)} aircraft cannot stay on our ramp"},
            {"id": f"{sid}.kpis.empty_legs", "text": f"{legs} empty repositioning legs"},
            {"id": f"{sid}.kpis.co2_t", "text": f"{co2_t:.1f} t CO2 from those legs"},
            {"id": f"{sid}.kpis.hours_over_capacity", "text": f"{hours_over} hours over capacity after the plan"},
            {"id": f"{sid}.kpis.peak_line_staff", "text": f"{peak_staff} line techs at the peak hour"},
        ]
        if split:
            facts.append({"id": f"{sid}.overflow_split",
                          "text": ", ".join(f"{v} to {k}" for k, v in split.items() if v) or "no overflow"})
        return {"id": sid, "name": name, "summary": summary, "kpis": kpis, "approvers": approvers,
                "assumptions": [f"assumptions.yaml#{k}" for k in note], "explanation_facts": facts,
                "overflow_split": split, "solver": "cp-sat" if cp_model else "first-come"}

    ov_a, _ = choose(flights, cap_eff)
    ov_b, dest_b = choose(flights, cap_eff, partners)
    ov_c, dest_c = choose(flights, cap_eff + temp, partners)
    names = ", ".join(k[1:] for k in partners)
    cards = [
        card("A", "Cap overnight stays + drop-and-go",
             f"Book overnight stands up to {cap_eff:.0f} of {cap:.0f}. Extra arrivals drop passengers and leave.",
             ov_a, {}, 0, ["FBO general manager"], "medium", 0,
             ["fbo.reservation_buffer_pct", "overflow.adhoc_reposition_nm"]),
        card("B", "Partner-airport overflow",
             f"Same cap. Overflow jets reposition to partner FBOs at {names}, then return for pickup.",
             ov_b, dest_b, 0, ["FBO general manager", f"Partner FBOs ({names})"], "low", 2,
             ["overflow.partner_airports", "overflow.partner_spaces", "fuel.gal_per_nm_repositioning"]),
        card("C", "Temporary taxiway parking",
             f"Close a taxiway for {temp} extra stands. Remaining overflow goes to partners.",
             ov_c, dest_c, temp, ["FBO general manager", "Airport operations", "FAA"], "high", 4,
             ["fbo.temp_taxiway_stands", "overflow.partner_spaces"]),
    ]
    return {"scenario": ds.scenario, "source": ds.source, "capacity": cap,
            "status_quo": {"hours_over_capacity": status_quo_hours, "peak_demand": round(float(unconstrained.max()), 1)},
            "strategies": cards}
