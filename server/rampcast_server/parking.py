"""Parking control: where every aircraft parks, what must be towed, and how full the ramp gets.

The ramp is stacked: each column of stands is three deep and only depth 1 touches the taxilane.
A jet parked deeper can only leave once the jets in front of it have gone, and it can only get in
if nobody is parked in front of it yet. Every violation costs a tow out and back.

Two layouts share this engine:
- "stands": the 48 marked stands, three deep, used in an ordinary week.
- "tandem": game-day packing. Boxes sized to the largest jet allowed plus 3 m, columns three deep for large
  cabins and four deep for the rest, six drop-and-go hot spots, and an overflow pad. Slot ids and the column
  pattern match app/src/three/compact.ts, which draws the same slots in 3D.

Two arrangements are produced so the difference can be measured:
- "first_come": the whiteboard method, first free stand that fits, front stands first.
- "optimized":  RAMPCAST's arrangement, which knows each jet's planned departure and parks long
                stays deep, short stays in front, drop-and-go on hot spots, minimising tows.
Both are suggestions. The line supervisor approves every tow and marshals every aircraft.
"""
from __future__ import annotations

import dataclasses
import hashlib
import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from . import config as C
from .data import Dataset, Flight

A = C.assumptions


@dataclass
class Position:
    id: str
    kind: str                 # stand | hot | temp
    row: str
    column: int
    depth: int
    max_wingspan_ft: int

    def to_dict(self) -> dict:
        return {"id": self.id, "kind": self.kind, "row": self.row, "column": self.column, "depth": self.depth,
                "max_wingspan_ft": self.max_wingspan_ft}


@dataclass
class Plan:
    method: str
    temp_zone: bool
    layout: str
    positions: list[Position] = field(default_factory=list)
    assignment: dict[str, str | None] = field(default_factory=dict)   # flight_id -> position id (None = overflow)
    tows: list[dict] = field(default_factory=list)
    blocks: list[dict] = field(default_factory=list)
    notes: dict[str, list[str]] = field(default_factory=dict)  # flight_id -> reasons for the placement


# Game-day tandem layout. Keep in step with COLUMN_PATTERN, L_DEPTH, M_DEPTH, LANE_CLEAR in app/src/three/compact.ts.
TANDEM_PATTERN = (True, False, True, False, False, True, False)   # True = large-cabin column (max 100 ft span)
TANDEM_L_DEPTH, TANDEM_M_DEPTH, TANDEM_LANE_CLEAR, TANDEM_BAND = 33, 24, 18, 150
COLUMN_KINDS = ("stand", "temp", "pad")                         # positions stacked in columns off a lane


def tandem_positions(temp_zone: bool) -> list[Position]:
    t = A()["parking"]["tandem"]
    usable = TANDEM_BAND - 2 * TANDEM_LANE_CLEAR
    out = []
    for row in "ABCD":
        for c, large in enumerate(TANDEM_PATTERN, start=1):
            for d in range(1, usable // (TANDEM_L_DEPTH if large else TANDEM_M_DEPTH) + 1):
                out.append(Position(f"{row}{c}-{d}", "stand", row, c, d, 100 if large else 72))
    out += [Position(f"H{i}", "hot", "H", i, 1, 110) for i in range(1, t["hot_spots"] + 1)]
    if temp_zone:
        out += [Position(f"T{r}-{d}", "temp", "T", r, d, 100) for r in range(1, t["temp_rows"] + 1) for d in range(1, t["temp_depth"] + 1)]
    out += [Position(f"P{c}-{d}", "pad", "P", c, d, 100) for c in range(1, t["pad_columns"] + 1) for d in range(1, t["pad_depth"] + 1)]
    return out


def positions(stands: list[dict], temp_zone: bool, layout: str = "stands") -> list[Position]:
    if layout == "tandem":
        return tandem_positions(temp_zone)
    p = A()["parking"]
    out = [Position(s["stand_id"], "stand", s["row"], int(s.get("column", 1)), int(s["depth"]), int(s["max_wingspan_ft"]))
           for s in stands]
    out += [Position(f"H{i}", "hot", "H", i, 1, 110) for i in range(1, p["hot_spots"] + 1)]
    if temp_zone:
        out += [Position(f"T{i}", "temp", "T", i, 1, 100) for i in range(1, p["temp_zone_stands"] + 1)]
    return out


def span(f: Flight) -> int:
    return C.WINGSPAN_FT.get(f.size_class, 60)


def _stay_h(f: Flight) -> float:
    return (f.departed_vny - f.landed).total_seconds() / 3600


def _ideal_depth(f: Flight) -> int:
    h = _stay_h(f)
    return 3 if h > 20 else 2 if h > 4 else 1


def _as_told(f: Flight) -> Flight:
    """The flight as the planner sees it: departing when the owner said, not when they actually leave.
    Long stays drift most (owners leave when the party ends); the spread is in assumptions.yaml."""
    sig = A()["parking"].get("departure_uncertainty_h", {})
    stay = _stay_h(f)
    sigma = sig.get("over_20h", 0) if stay > 20 else sig.get("over_3h", 0) if stay > 3 else 0
    if not sigma:
        return f
    h = hashlib.sha256(("told|" + f.flight_id).encode()).digest()
    u1 = (int.from_bytes(h[:4], "big") + 1) / 2**32
    u2 = int.from_bytes(h[4:8], "big") / 2**32
    gauss = math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)
    told = max(f.landed + timedelta(minutes=30), f.departed_vny + timedelta(hours=gauss * sigma))
    return dataclasses.replace(f, departed_vny=told)


def _overlap(a: Flight, b: Flight) -> bool:
    return a.landed < b.departed_vny and b.landed < a.departed_vny


def _pair_blocks(back: Flight, front: Flight) -> list[tuple[str, datetime]]:
    """Blocking events between a jet parked deeper (back) and one in front of it, same column."""
    out = []
    if front.landed <= back.landed < front.departed_vny:
        out.append(("arrival", back.landed))          # front jet must be towed so the back jet can get in
    if front.landed <= back.departed_vny < front.departed_vny:
        out.append(("departure", back.departed_vny))  # front jet must be towed so the back jet can leave
    return out


def _column_cost(f: Flight, p: Position, members: list[tuple[Flight, Position]]) -> int:
    n = 0
    for g, q in members:
        if g is f or not _overlap(f, g):
            continue
        if q.depth > p.depth:
            n += len(_pair_blocks(g, f))
        elif q.depth < p.depth:
            n += len(_pair_blocks(f, g))
    return n


def build(ds: Dataset, method: str = "optimized", temp_zone: bool = False, pins: dict[str, str] | None = None,
          layout: str = "stands") -> Plan:
    pins = pins or {}
    a = A()["parking"]
    pos = positions(ds.stands, temp_zone, layout)
    by_id = {p.id: p for p in pos}
    column_of = lambda p: (p.row, p.column)  # noqa: E731
    in_column = lambda p: p.kind in COLUMN_KINDS  # noqa: E731
    col_positions: dict[tuple, list[Position]] = {}
    for p in pos:
        if in_column(p):
            col_positions.setdefault(column_of(p), []).append(p)
    zone_cost = {"stand": 0.0, "temp": 1.5, "pad": 4.0, "hot": 0.0}
    # Placement uses the departure times owners gave; tows are counted from what actually happened.
    told = {f.flight_id: _as_told(f) for f in ds.flights}
    occupant: dict[str, Flight | None] = {p.id: None for p in pos}
    plan = Plan(method, temp_zone, layout, pos, {})
    order = sorted(pos, key=lambda p: ({"stand": 0, "temp": 1, "pad": 2, "hot": 3}[p.kind], p.row, p.column, p.depth))
    events = sorted([(f.landed, 1, f) for f in ds.flights] + [(f.departed_vny, 0, f) for f in ds.flights],
                    key=lambda e: (e[0], e[1]))
    flights = {f.flight_id: f for f in ds.flights}
    # A pinned jet (manual placement or confirmed booking) holds its position for its whole stay.
    held: dict[str, list[Flight]] = {}
    for fid, pid in pins.items():
        if pid in by_id and fid in flights:
            held.setdefault(pid, []).append(flights[fid])
    source: dict[str, str] = {}

    def live_cost(f: Flight, p: Position) -> float:
        """Greedy cost from the jets parked right now (their departures are planned, so we know them)."""
        mates = [(told[occupant[q.id].flight_id], q) for q in col_positions.get(column_of(p), []) if occupant[q.id] is not None] if in_column(p) else []
        ft = told[f.flight_id]
        c = 2.0 * _column_cost(ft, p, mates)
        c += 0.45 * abs(_ideal_depth(ft) - p.depth) + 0.004 * (p.max_wingspan_ft - span(f))
        return c + zone_cost[p.kind]

    # 1. Place each arrival in time order.
    for _, kind, f in events:
        if kind == 0:
            pid = plan.assignment.get(f.flight_id)
            if pid and occupant.get(pid) is f:
                occupant[pid] = None
            continue
        short = f.stay_type == "drop_and_go" or _stay_h(f) <= a["hot_spot_max_hours"]
        free = [p for p in order if occupant[p.id] is None and p.max_wingspan_ft >= span(f) and (p.kind != "hot" or short)
                and not any(g is not f and _overlap(f, g) for g in held.get(p.id, ()))]
        choice = None
        pin = pins.get(f.flight_id)
        if pin in by_id and occupant[pin] is None and by_id[pin].max_wingspan_ft >= span(f):
            choice, source[f.flight_id] = by_id[pin], "pin"
        elif free:
            if method == "first_come":
                choice, source[f.flight_id] = next((p for p in free if p.kind == "stand"), free[0]), "first_come"
            else:
                hot = [p for p in free if p.kind == "hot"]
                if short and hot:
                    choice, source[f.flight_id] = hot[0], "hot"
                else:
                    choice = min((p for p in free if p.kind != "hot"), key=lambda p: (live_cost(f, p), p.id), default=None) or free[0]
                    source[f.flight_id] = "optimized"
        plan.assignment[f.flight_id] = choice.id if choice else None
        if choice:
            occupant[choice.id] = f

    # 2. Optimized only: improve with the whole week in view (move one jet at a time while tows drop).
    if method == "optimized":
        at: dict[str, list[Flight]] = {p.id: [] for p in pos}
        for fid, pid in plan.assignment.items():
            if pid:
                at[pid].append(flights[fid])

        def members(p: Position) -> list[tuple[Flight, Position]]:
            """Jets sharing p's column, as the planner knows them (stated departure times)."""
            if not in_column(p):
                return []
            return [(told[g.flight_id], q) for q in col_positions[column_of(p)] for g in at[q.id]]

        for _ in range(4):
            improved = False
            for fid, pid in list(plan.assignment.items()):
                if not pid or fid in pins or not in_column(by_id[pid]):
                    continue
                f, cur = flights[fid], by_id[pid]
                ft = told[fid]
                cur_cost = _column_cost(ft, cur, members(cur))
                if cur_cost == 0:
                    continue
                best, best_cost = None, cur_cost
                for p in pos:
                    if p.id == pid or p.kind == "hot" or p.max_wingspan_ft < span(f):
                        continue
                    if any(_overlap(f, g) for g in at[p.id]):
                        continue
                    c = _column_cost(ft, p, members(p)) + {"stand": 0, "temp": 0.5, "pad": 1.0}[p.kind]
                    if c < best_cost:
                        best, best_cost = p, c
                if best is not None:
                    at[pid].remove(f)
                    at[best.id].append(f)
                    plan.assignment[fid] = best.id
                    source[fid] = "moved"
                    improved = True
            if not improved:
                break

    # 3. Count blocking events and the tows they need from the final arrangement.
    start = C.window_start_local()
    cols: dict[tuple, list[tuple[Flight, Position]]] = {}
    for fid, pid in plan.assignment.items():
        if pid and in_column(by_id[pid]):
            cols.setdefault(column_of(by_id[pid]), []).append((flights[fid], by_id[pid]))
    for mates in cols.values():
        for g, q in mates:
            for h, r in mates:
                if r.depth >= q.depth or not _overlap(g, h):
                    continue
                for kind, t in _pair_blocks(g, h):
                    if t < start:
                        continue
                    plan.blocks.append({"t_local": C.iso_local(t), "kind": kind, "position": q.id, "flight_id": g.flight_id,
                                        "blocked_by": h.flight_id, "blocker_position": r.id})
                    plan.tows.append({"t_local": C.iso_local(t - timedelta(minutes=10 if kind == "arrival" else 20)),
                                      "flight_id": h.flight_id, "size_class": h.size_class, "from": r.id,
                                      "to": f"{r.id} (out and back)",
                                      "reason": (f"Let {g.flight_id} into {q.id} behind it" if kind == "arrival"
                                                 else f"Release {g.flight_id} from {q.id} for departure"),
                                      "for_flight": g.flight_id, "kind": kind,
                                      "for_flight_t": C.iso_local(t)})
    plan.tows.sort(key=lambda x: x["t_local"])
    plan.blocks.sort(key=lambda x: x["t_local"])

    # 4. Plain-language reason for every placement.
    involved: dict[str, int] = {}
    for b in plan.blocks:
        involved[b["flight_id"]] = involved.get(b["flight_id"], 0) + 1
    for fid, pid in plan.assignment.items():
        f = flights[fid]
        if pid is None:
            plan.notes[fid] = ["No position fits while it is here: drop-and-go, temporary zone, or a partner FBO"]
            continue
        p = by_id[pid]
        src = source.get(fid, "")
        if src == "pin":
            why = ["Placed by the manager (manual assignment)"]
        elif p.kind == "hot":
            why = [f"Short stay ({_stay_h(f):.1f} h): hot spot by the terminal keeps stands free"]
        elif src == "first_come":
            why = ["First free stand that fits (whiteboard method)"]
        elif p.kind == "temp":
            why = [f"Temporary taxiway stand: ramp full, stays {_stay_h(f):.0f} h"]
        elif p.kind == "pad":
            why = [f"Overflow pad: the ramp has no slot that fits for all {_stay_h(f):.0f} h"]
        else:
            where = ({1: "front row, on the taxilane", 2: "middle row", 3: "back row"}[p.depth] if layout == "stands"
                     else "front of the column, on the taxilane" if p.depth == 1
                     else f"{('second', 'third', 'fourth', 'fifth')[min(p.depth, 5) - 2]} in the column")
            why = [f"Stays {_stay_h(f):.0f} h, departs {f.departed_vny:%a %H:%M}: {where}"]
            if src == "moved":
                why.append("Moved by the optimizer after looking at the whole week")
        n = involved.get(fid, 0)
        why.append(f"Needs {n * a['tows_per_block']} tow(s) to get in or out" if n else "No tows: nothing blocks it and it blocks nothing")
        plan.notes[fid] = why
    return plan


def metrics(ds: Dataset, plan: Plan) -> dict:
    a = A()
    fees = a["parking_fees_usd"]
    start = C.window_start_local()
    end = start + timedelta(hours=C.n_hours())
    stands = [p for p in plan.positions if p.kind == "stand"]
    stand_hours = 0.0
    revenue = 0.0
    hot_uses = temp_uses = pad_uses = 0
    overflow = [f for f in ds.flights if plan.assignment.get(f.flight_id) is None]
    by_id = {p.id: p for p in plan.positions}
    hourly = [0] * C.n_hours()
    for f in ds.flights:
        pid = plan.assignment.get(f.flight_id)
        if pid is None:
            continue
        p = by_id[pid]
        lo, hi = max(f.landed, start), min(f.departed_vny, end)
        if hi > lo and p.kind == "stand":
            stand_hours += (hi - lo).total_seconds() / 3600
            for h in range(int((lo - start).total_seconds() // 3600), min(C.n_hours(), int((hi - start).total_seconds() // 3600) + 1)):
                hourly[h] += 1
        if p.kind == "hot":
            hot_uses += 1
        if p.kind == "temp":
            temp_uses += 1
        if p.kind == "pad":
            pad_uses += 1
        if f.stay_type == "pre_window":
            continue
        if f.stay_type == "drop_and_go" or p.kind == "hot":
            revenue += fees["drop_and_go_flat"] * fees["event_multiplier"]
        else:
            nights = max(1, round(_stay_h(f) / 24))
            revenue += nights * fees.get(f.size_class, fees["other"]) * fees["event_multiplier"]
    return {
        "method": plan.method, "temp_zone": plan.temp_zone, "layout": plan.layout, "pad_uses": pad_uses,
        "positions": sum(1 for p in plan.positions if p.kind != "hot"),
        "tows": len(plan.tows) * a["parking"]["tows_per_block"],
        "boxed_in_events": len(plan.blocks),
        "overflow_aircraft": len([f for f in overflow if f.stay_type != "pre_window"]),
        "hot_spot_uses": hot_uses, "temp_zone_uses": temp_uses,
        "peak_stands_used": max(hourly) if hourly else 0, "stands": len(stands),
        "utilization_pct": round(stand_hours / (len(stands) * C.n_hours()) * 100, 1) if stands else 0,
        "revenue_est_usd": round(revenue, -2),
        "aircraft_parked": sum(1 for v in plan.assignment.values() if v),
    }


def gantt(ds: Dataset, plan: Plan, bookings: dict) -> list[dict]:
    rows: dict[str, list] = {p.id: [] for p in plan.positions}
    rows["OVERFLOW"] = []
    blocked = {b["flight_id"] for b in plan.blocks} | {b["blocked_by"] for b in plan.blocks}
    for f in ds.flights:
        pid = plan.assignment.get(f.flight_id) or "OVERFLOW"
        rows[pid].append({"flight_id": f.flight_id, "booking_code": f.booking_code, "size_class": f.size_class,
                          "start": C.iso_local(f.landed), "end": C.iso_local(f.departed_vny), "stay_type": f.stay_type,
                          "origin": f.origin, "tow_involved": f.flight_id in blocked})
    pos = {p.id: p for p in plan.positions}
    return [{"position": pid, "kind": pos[pid].kind if pid in pos else "overflow", "bars": bars} for pid, bars in rows.items()]


def recommendations(ds: Dataset, plan: Plan, day: str) -> list[dict]:
    pos = {p.id: p for p in plan.positions}
    out = []
    for f in ds.flights:
        if f.stay_type == "pre_window" or C.iso_local(f.landed)[:10] != day:
            continue
        pid = plan.assignment.get(f.flight_id)
        p = pos.get(pid) if pid else None
        if p is None:
            action, label = "overflow", "Overflow: drop-and-go or partner FBO"
        elif p.kind == "hot":
            action, label = "hot_spot", f"Hot spot {p.id} · drop-and-go"
        elif p.kind == "temp":
            action, label = "temp", f"Temporary stand {p.id} (needs strategy C)"
        elif p.kind == "pad":
            action, label = "overflow", f"Overflow pad {p.id}"
        else:
            action, label = "stand", f"Stand {p.id} · depth {p.depth}"
        out.append({"flight_id": f.flight_id, "booking_code": f.booking_code, "size_class": f.size_class,
                    "origin": f.origin, "origin_name": f.origin_name, "arrive_local": C.iso_local(f.landed),
                    "depart_local": C.iso_local(f.departed_vny), "stay_h": round(_stay_h(f), 1),
                    "stay_type": f.stay_type, "position": pid, "action": action, "label": label,
                    "reasons": plan.notes.get(f.flight_id, []),
                    "tows": A()["parking"]["tows_per_block"] * sum(1 for t in plan.tows if t["for_flight"] == f.flight_id)})
    out.sort(key=lambda r: r["arrive_local"])
    return out


def state(ds: Dataset, plan: Plan, t: datetime) -> dict:
    pos = {p.id: p for p in plan.positions}
    occ = []
    for f in ds.flights:
        if f.landed <= t < f.departed_vny:
            pid = plan.assignment.get(f.flight_id)
            occ.append({"flight_id": f.flight_id, "booking_code": f.booking_code, "size_class": f.size_class,
                        "wingspan_ft": span(f), "position": pid, "kind": pos[pid].kind if pid else "overflow",
                        "arrive_local": C.iso_local(f.landed), "depart_local": C.iso_local(f.departed_vny),
                        "origin": f.origin, "origin_name": f.origin_name, "stay_type": f.stay_type,
                        "reasons": plan.notes.get(f.flight_id, [])})
    t_iso, t3 = C.iso_local(t), C.iso_local(t + timedelta(hours=3))
    arrivals = [{"flight_id": f.flight_id, "booking_code": f.booking_code, "size_class": f.size_class,
                 "arrive_local": C.iso_local(f.landed), "position": plan.assignment.get(f.flight_id), "origin": f.origin}
                for f in ds.flights if t < f.landed <= t + timedelta(hours=3)]
    departures = [{"flight_id": f.flight_id, "size_class": f.size_class, "depart_local": C.iso_local(f.departed_vny),
                   "position": plan.assignment.get(f.flight_id)}
                  for f in ds.flights if t < f.departed_vny <= t + timedelta(hours=3)]
    return {"t_local": t_iso, "occupants": occ,
            "tows_next_3h": [x for x in plan.tows if t_iso <= x["t_local"] <= t3],
            "arrivals_next_3h": sorted(arrivals, key=lambda x: x["arrive_local"]),
            "departures_next_3h": sorted(departures, key=lambda x: x["depart_local"]),
            "stands_used": sum(1 for o in occ if o["kind"] == "stand"),
            "hot_used": sum(1 for o in occ if o["kind"] == "hot"),
            "temp_used": sum(1 for o in occ if o["kind"] == "temp"),
            "pad_used": sum(1 for o in occ if o["kind"] == "pad"),
            "overflow_now": sum(1 for o in occ if o["kind"] == "overflow")}


def validate_move(ds: Dataset, plan: Plan, flight_id: str, position_id: str) -> list[str]:
    """Plain-language problems with putting a flight on a position, before the manager confirms."""
    f = next((x for x in ds.flights if x.flight_id == flight_id), None)
    p = next((x for x in plan.positions if x.id == position_id), None)
    if f is None or p is None:
        return ["Unknown aircraft or position"]
    issues = []
    if p.max_wingspan_ft < span(f):
        issues.append(f"Wingspan {span(f)} ft does not fit {p.id} (max {p.max_wingspan_ft} ft)")
    if p.kind == "hot" and _stay_h(f) > A()["parking"]["hot_spot_max_hours"]:
        issues.append(f"Hot spots are for stays up to {A()['parking']['hot_spot_max_hours']} h; this stay is {_stay_h(f):.0f} h")
    for g in ds.flights:
        if g.flight_id != f.flight_id and plan.assignment.get(g.flight_id) == p.id \
                and g.landed < f.departed_vny and f.landed < g.departed_vny:
            issues.append(f"{p.id} is taken by {g.flight_id} from {g.landed:%a %H:%M} to {g.departed_vny:%a %H:%M}")
            break
    return issues


def pins_key(pins: dict[str, str]) -> str:
    return hashlib.sha1(json.dumps(pins, sort_keys=True).encode()).hexdigest()[:10]
