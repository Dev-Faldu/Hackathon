"""Stand planner: assign every aircraft to a stand with OR-Tools CP-SAT.

The ramp is stacked: each column of stands is three deep and only depth 1 touches the taxilane.
Hard rules:
- the jet's wingspan fits the stand (wingspan <= stand max);
- one jet per position at a time;
- nobody is boxed in. Within a column, if two jets are on the ramp at the same time, the deeper one must
  land first and leave no earlier than the one in front of it (departure(depth k+1) >= departure(depth k)).
  Two jets whose stays cross (one lands first, but also leaves first) can never share a column.
Objective: keep every jet on our ramp (overflow is the big cost), then use hot spots for short stays, keep the
temporary taxiway zone for when it is needed, and park long stays deep. With these rules a plan needs no tows;
tows appear only where the manager pins a jet somewhere the rules would not have put it.

Re-solving is incremental: the previous assignment is passed back as a solution hint, and pinned jets are fixed.
Two solve modes:
- "rolling" (default, deterministic): one day of arrivals at a time with earlier days fixed, single worker,
  deterministic time budget. Same input, same plan, on any machine.
- "portfolio": the whole week in one model with parallel workers and a wall-clock limit. Usually a little
  better, but not bit-for-bit repeatable.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Protocol

from rampcast_server import config as C
from rampcast_server.data import Flight

from .common import A, minutes_from_start

try:
    from ortools.sat.python import cp_model
except ImportError:  # pragma: no cover - the greedy plan still obeys every hard rule
    cp_model = None

OVERFLOW_COST, PRE_WINDOW_OVERFLOW_COST = 1000, 5000
TEMP_COST, SHORT_ON_STAND_COST, DEPTH_COST = 20, 4, 3
MOVE_COST = 30   # re-solves: moving an already-placed jet costs this; saving one from overflow (1000) still wins


class Position(Protocol):
    id: str
    kind: str          # stand | hot | temp
    row: str
    column: int
    depth: int
    max_wingspan_ft: int


@dataclass
class StandSolution:
    assignment: dict[str, str | None]            # flight_id -> position id (None = overflow)
    method: str                                  # cp-sat-rolling | cp-sat-portfolio | greedy
    status: str
    overflow: int
    solve_s: float
    windows: list[dict] = field(default_factory=list)


def span(f: Flight) -> int:
    return C.WINGSPAN_FT.get(f.size_class, 60)


def stay_h(f: Flight) -> float:
    return (f.departed_vny - f.landed).total_seconds() / 3600


def ideal_depth(f: Flight) -> int:
    h = stay_h(f)
    return 3 if h > 20 else 2 if h > 4 else 1


def is_short(f: Flight) -> bool:
    return f.stay_type == "drop_and_go" or stay_h(f) <= A()["parking"]["hot_spot_max_hours"]


def overlap(a: Flight, b: Flight) -> bool:
    return a.landed < b.departed_vny and b.landed < a.departed_vny


def can_be_behind(back: Flight, front: Flight) -> bool:
    """True if `back` may park deeper than `front` in the same column while both are on the ramp."""
    return back.landed < front.landed and back.departed_vny >= front.departed_vny


def candidates(f: Flight, positions: list[Position]) -> list[Position]:
    return [p for p in positions if p.max_wingspan_ft >= span(f) and (p.kind != "hot" or is_short(f))]


def placement_cost(f: Flight, p: Position) -> int:
    if p.kind == "hot":
        return 0
    if p.kind == "temp":
        return TEMP_COST
    return DEPTH_COST * abs(ideal_depth(f) - p.depth) + (SHORT_ON_STAND_COST if is_short(f) else 0)


def _columns(positions: list[Position]) -> dict[tuple, list[Position]]:
    cols: dict[tuple, list[Position]] = {}
    for p in positions:
        if p.kind == "stand":
            cols.setdefault((p.row, p.column), []).append(p)
    return cols


def greedy(flights: list[Flight], positions: list[Position], fixed: dict[str, str | None] | None = None) -> dict[str, str | None]:
    """Arrival-order plan that obeys every hard rule. Used as the solver's warm start and as a fallback."""
    fixed = fixed or {}
    by_id = {p.id: p for p in positions}
    col_of = {p.id: (p.row, p.column) for p in positions if p.kind == "stand"}
    cols = _columns(positions)
    occ: dict[str, Flight | None] = {p.id: None for p in positions}
    out: dict[str, str | None] = {}
    events = sorted([(f.landed, 1, f) for f in flights] + [(f.departed_vny, 0, f) for f in flights], key=lambda e: (e[0], e[1]))
    for _, kind, f in events:
        fid = f.flight_id
        if kind == 0:
            pid = out.get(fid)
            if pid and occ[pid] is f:
                occ[pid] = None
            continue
        if fid in fixed:
            pid = fixed[fid]
            out[fid] = pid
            if pid and occ.get(pid) is None:
                occ[pid] = f
            continue
        best = None
        for p in candidates(f, positions):
            if occ[p.id] is not None:
                continue
            if p.kind == "stand" and not all(
                    occ[q.id] is None or (can_be_behind(occ[q.id], f) if q.depth > p.depth else can_be_behind(f, occ[q.id]))
                    for q in cols[col_of[p.id]] if q.id != p.id):
                continue
            cost = (placement_cost(f, p), by_id[p.id].max_wingspan_ft - span(f), p.id)
            if best is None or cost < best[0]:
                best = (cost, p.id)
        out[fid] = best[1] if best else None
        if best:
            occ[best[1]] = f
    return out


def _model(flights: list[Flight], positions: list[Position], fixed: dict[str, str | None], free: set[str],
           hint: dict[str, str | None], previous: dict[str, str | None] | None = None):
    """CP-SAT model over `flights`; those not in `free` are held at their `fixed` position."""
    m = cp_model.CpModel()
    cols = _columns(positions)
    col_of = {p.id: (p.row, p.column) for p in positions if p.kind == "stand"}
    x: dict[tuple[str, str], object] = {}
    over: dict[str, object] = {}
    cands: dict[str, list[Position]] = {}
    for f in flights:
        fid = f.flight_id
        if fid in free:
            cands[fid] = candidates(f, positions)
        else:
            pid = fixed.get(fid)
            cands[fid] = [p for p in positions if p.id == pid]
        for p in cands[fid]:
            x[fid, p.id] = m.NewBoolVar(f"x[{fid},{p.id}]")
        over[fid] = m.NewBoolVar(f"over[{fid}]")
        m.AddExactlyOne([x[fid, p.id] for p in cands[fid]] + [over[fid]])
        if fid not in free:
            m.Add(over[fid] == (1 if fixed.get(fid) is None else 0))

    # One jet per position at a time.
    per_pos: dict[str, list] = {p.id: [] for p in positions}
    for f in flights:
        s, e = minutes_from_start(f.landed), minutes_from_start(f.departed_vny)
        for p in cands[f.flight_id]:
            per_pos[p.id].append(m.NewOptionalFixedSizeIntervalVar(s, max(1, e - s), x[f.flight_id, p.id], ""))
    for ivs in per_pos.values():
        if len(ivs) > 1:
            m.AddNoOverlap(ivs)

    # Redundant but tightens the bound: jets on the ramp never exceed the positions that fit them.
    for thr in sorted({span(f) for f in flights}):
        big = [f for f in flights if span(f) >= thr]
        ivs = []
        for f in big:
            s, e = minutes_from_start(f.landed), minutes_from_start(f.departed_vny)
            ivs.append(m.NewOptionalFixedSizeIntervalVar(s, max(1, e - s), over[f.flight_id].Not(), ""))
        m.AddCumulative(ivs, [1] * len(ivs), sum(1 for p in positions if p.max_wingspan_ft >= thr))

    # Nobody boxed in.
    in_col: dict[tuple[str, tuple], object] = {}
    for f in flights:
        by_col: dict[tuple, list] = {}
        for p in cands[f.flight_id]:
            if p.kind == "stand":
                by_col.setdefault(col_of[p.id], []).append(x[f.flight_id, p.id])
        for c, lits in by_col.items():
            v = m.NewBoolVar("")
            m.Add(sum(lits) == v)
            in_col[f.flight_id, c] = v
    srt = sorted(flights, key=lambda f: (f.landed, f.flight_id))
    for i, f in enumerate(srt):
        for g in srt[i + 1:]:
            if g.landed >= f.departed_vny:
                break
            if f.flight_id not in free and g.flight_id not in free:
                continue  # both held: a pin may knowingly box a jet in, and earlier windows are settled
            if can_be_behind(f, g):
                # f may only be deeper than g: forbid g behind f, and f at the same depth or in front.
                for c, ps in cols.items():
                    for p in ps:
                        for q in ps:
                            if q.depth > p.depth and (f.flight_id, p.id) in x and (g.flight_id, q.id) in x:
                                m.AddBoolOr([x[f.flight_id, p.id].Not(), x[g.flight_id, q.id].Not()])
            else:
                for c in cols:
                    if (f.flight_id, c) in in_col and (g.flight_id, c) in in_col:
                        m.AddBoolOr([in_col[f.flight_id, c].Not(), in_col[g.flight_id, c].Not()])

    m.Minimize(sum((PRE_WINDOW_OVERFLOW_COST if f.stay_type == "pre_window" else OVERFLOW_COST) * over[f.flight_id]
                   for f in flights)
               + sum(placement_cost(f, p) * x[f.flight_id, p.id] for f in flights for p in cands[f.flight_id])
               + sum(MOVE_COST * (1 - x[f.flight_id, previous[f.flight_id]]) for f in flights
                     if previous and f.flight_id in free and (f.flight_id, previous.get(f.flight_id)) in x))
    for f in flights:
        h = hint.get(f.flight_id, "missing")
        if h == "missing":
            continue
        for p in cands[f.flight_id]:
            m.AddHint(x[f.flight_id, p.id], h == p.id)
        m.AddHint(over[f.flight_id], h is None)
    return m, x, over, cands


def _read(sv, flights, x, over, cands) -> dict[str, str | None]:
    out = {}
    for f in flights:
        out[f.flight_id] = None if sv.Value(over[f.flight_id]) else next(
            p.id for p in cands[f.flight_id] if sv.Value(x[f.flight_id, p.id]))
    return out


def solve(flights: list[Flight], positions: list[Position], pins: dict[str, str] | None = None,
          hint: dict[str, str | None] | None = None, mode: str | None = None, budget: float | None = None) -> StandSolution:
    """Assign every flight. `pins` are manager placements (held fixed); `hint` is a previous plan to start from."""
    t0 = time.time()
    by_id = {p.id: p for p in positions}
    pins = {fid: pid for fid, pid in (pins or {}).items() if pid in by_id}
    flights = sorted(flights, key=lambda f: (f.landed, f.flight_id))
    start_hint = greedy(flights, positions, pins)
    if hint:
        start_hint.update({k: v for k, v in hint.items() if v is None or v in by_id})
    if cp_model is None:
        return StandSolution(start_hint, "greedy", "NO_SOLVER", _count_over(flights, start_hint), time.time() - t0)
    mode = mode or os.environ.get("RAMPCAST_STANDS_MODE", "rolling")
    if mode == "portfolio":
        sol = _solve_portfolio(flights, positions, pins, start_hint, budget)
    else:
        sol = _solve_rolling(flights, positions, pins, start_hint, budget)
    sol.solve_s = round(time.time() - t0, 2)
    return sol


def _count_over(flights, assignment) -> int:
    return sum(1 for f in flights if assignment.get(f.flight_id) is None and f.stay_type != "pre_window")


def _solve_portfolio(flights, positions, pins, hint, budget) -> StandSolution:
    m, x, over, cands = _model(flights, positions, dict(pins), {f.flight_id for f in flights} - set(pins), hint)
    sv = cp_model.CpSolver()
    sv.parameters.num_workers = 8
    sv.parameters.random_seed = 2027
    sv.parameters.max_time_in_seconds = budget or float(os.environ.get("RAMPCAST_STANDS_SECONDS", 10))
    st = sv.Solve(m)
    if st not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return StandSolution(hint, "greedy", sv.StatusName(st), _count_over(flights, hint), 0)
    out = _read(sv, flights, x, over, cands)
    return StandSolution(out, "cp-sat-portfolio", sv.StatusName(st), _count_over(flights, out), 0)


def _solve_rolling(flights, positions, pins, hint, budget) -> StandSolution:
    """One day of arrivals at a time; earlier days fixed. Deterministic: one worker, deterministic time."""
    per_window = budget or float(os.environ.get("RAMPCAST_STANDS_DET_TIME", 2))
    fixed: dict[str, str | None] = dict(pins)
    windows = []
    start = C.window_start_local()
    days = sorted({max(0, (f.landed - start).days) for f in flights})
    for d in days:
        lo, hi = start + timedelta(days=d), start + timedelta(days=d + 1)
        free = {f.flight_id for f in flights if f.flight_id not in pins and
                ((f.landed < lo and d == days[0]) or lo <= f.landed < hi or (d == days[-1] and f.landed >= hi))}
        if not free:
            continue
        live = [f for f in flights if f.flight_id in free or (f.flight_id in fixed and f.departed_vny > lo)]
        live = [f for f in live if f.flight_id in free or any(overlap(f, g) for g in live if g.flight_id in free)]
        m, x, over, cands = _model(live, positions, fixed, free, hint)
        sv = cp_model.CpSolver()
        sv.parameters.num_workers = 1
        sv.parameters.random_seed = 2027
        sv.parameters.max_deterministic_time = per_window
        st = sv.Solve(m)
        if st in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            got = _read(sv, live, x, over, cands)
        else:  # keep the hint for this window; it already obeys the hard rules
            got = {fid: hint.get(fid) for fid in free}
        fixed.update({fid: got[fid] for fid in free})
        windows.append({"day": (lo).date().isoformat(), "flights": len(free), "status": sv.StatusName(st)})
    out = {f.flight_id: fixed.get(f.flight_id) for f in flights}
    status = "OPTIMAL" if all(w["status"] == "OPTIMAL" for w in windows) else "FEASIBLE"
    return StandSolution(out, "cp-sat-rolling", status, _count_over(flights, out), 0, windows)


def _fits(f: Flight, p: Position, assign: dict[str, str | None], fmap: dict[str, Flight], by_id: dict[str, Position]) -> bool:
    """Can `f` go on `p` given everyone else's placement, without double-booking or boxing anyone in?"""
    for gid, gpid in assign.items():
        if gid == f.flight_id or gpid is None or not overlap(f, fmap[gid]):
            continue
        if gpid == p.id:
            return False
        q = by_id[gpid]
        if p.kind == "stand" and q.kind == "stand" and (q.row, q.column) == (p.row, p.column):
            g = fmap[gid]
            if not (can_be_behind(g, f) if q.depth > p.depth else can_be_behind(f, g)):
                return False
    return True


def safe_start(flights: list[Flight], positions: list[Position], previous: dict[str, str | None], changed: set[str],
               pins: dict[str, str]) -> dict[str, str | None]:
    """A plan that obeys every hard rule: the previous plan minus the changed jets, pins applied, then each
    displaced jet put back wherever it fits (or overflowed). Removing jets never breaks a rule, so this is
    always valid; the solver can only improve on it."""
    by_id = {p.id: p for p in positions}
    fmap = {f.flight_id: f for f in flights}
    assign = {fid: pid for fid, pid in previous.items() if fid in fmap and fid not in changed and fid not in pins}
    assign.update(pins)
    evicted = {gid for gid, gpid in assign.items() if gid not in pins and gpid is not None and any(
        gpid == pins[fid] and overlap(fmap[gid], fmap[fid]) for fid in pins)}
    to_place = sorted((f for f in flights if f.flight_id not in pins and
                       (f.flight_id in changed or f.flight_id in evicted or f.flight_id not in previous)),
                      key=lambda f: (f.landed, f.flight_id))
    for f in to_place:
        assign[f.flight_id] = None
    for f in to_place:
        for p in sorted(candidates(f, positions), key=lambda p: (placement_cost(f, p), p.max_wingspan_ft - span(f), p.id)):
            if _fits(f, p, assign, fmap, by_id):
                assign[f.flight_id] = p.id
                break
    return {f.flight_id: assign.get(f.flight_id) for f in flights}


def resolve(flights: list[Flight], positions: list[Position], previous: dict[str, str | None], changed: set[str],
            pins: dict[str, str] | None = None, budget: float | None = None) -> StandSolution:
    """Incremental re-solve after a change (a pin, or new ETAs/departures for `changed` flights).

    Only jets whose stay overlaps a changed jet are re-planned; every other placement is kept as it was.
    """
    t0 = time.time()
    by_id = {p.id: p for p in positions}
    pins = {fid: pid for fid, pid in (pins or {}).items() if pid in by_id}
    flights = sorted(flights, key=lambda f: (f.landed, f.flight_id))
    touched = [f for f in flights if f.flight_id in changed]
    free = {f.flight_id for f in flights if f.flight_id not in pins and
            (f.flight_id in changed or any(overlap(f, g) for g in touched) or f.flight_id not in previous)}
    if cp_model is None or not free:
        out = {**previous, **pins}
        return StandSolution(out, "greedy" if cp_model is None else "unchanged", "OK", _count_over(flights, out), time.time() - t0)
    fixed = {**{f.flight_id: previous.get(f.flight_id) for f in flights if f.flight_id not in free}, **pins}
    live = [f for f in flights if f.flight_id in free or any(overlap(f, g) for g in flights if g.flight_id in free)]
    start = safe_start(flights, positions, previous, changed, pins)
    m, x, over, cands = _model(live, positions, fixed, free, start, previous)
    sv = cp_model.CpSolver()
    sv.parameters.num_workers = 1
    sv.parameters.random_seed = 2027
    sv.parameters.max_deterministic_time = budget or float(os.environ.get("RAMPCAST_STANDS_DET_TIME", 2))
    st = sv.Solve(m)
    out = {f.flight_id: fixed.get(f.flight_id) for f in flights}
    if st in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        out.update(_read(sv, [f for f in live if f.flight_id in free], x, over, cands))
        if _count_over(flights, out) > _count_over(flights, start):
            out = start   # never hand back something worse than the valid starting plan
    else:
        out = start
    return StandSolution(out, "cp-sat-incremental", sv.StatusName(st), _count_over(flights, out),
                         round(time.time() - t0, 2), [{"re_planned": len(free)}])


def violations(flights: list[Flight], positions: list[Position], assignment: dict[str, str | None]) -> list[dict]:
    """Every boxed-in event in an assignment (for checks and for counting tows)."""
    by_id = {p.id: p for p in positions}
    cols: dict[tuple, list[tuple[Flight, Position]]] = {}
    for f in flights:
        pid = assignment.get(f.flight_id)
        if pid and by_id[pid].kind == "stand":
            cols.setdefault((by_id[pid].row, by_id[pid].column), []).append((f, by_id[pid]))
    out = []
    for mates in cols.values():
        for g, q in mates:
            for h, r in mates:
                if r.depth < q.depth and overlap(g, h) and not can_be_behind(g, h):
                    out.append({"back": g.flight_id, "back_position": q.id, "front": h.flight_id, "front_position": r.id})
    return out
