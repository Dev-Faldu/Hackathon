"""What-if engine: apply scenario modifiers and re-run the whole plan (strategies, alerts, priority queue).

Modifiers: runway_closed {from, to}, arrival_delay {from, to, minutes}, demand_multiplier, customs_hours,
diversions {flight_id: ICAO}. The demand multiplier is applied by the caller when it builds `changed`.
Must finish in under 5 seconds.
"""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta

from rampcast_server import config as C
from rampcast_server.data import Dataset

from .alerts import alerts
from .alternates import alternates
from .common import customs_close, drive_minutes
from . import stands
from .priority import priority_queue
from .strategies import strategies


def _affected_row(ds: Dataset, f, new_landed: datetime, cause: str) -> dict:
    b = ds.bookings.get(f.booking_code or "")
    zone = b.hotel_zone if b else "Beverly Hills"
    delay = int((new_landed - f.landed).total_seconds() // 60)
    return {"flight_id": f.flight_id, "booking_code": f.booking_code, "size_class": f.size_class,
            "origin": f.origin, "origin_name": f.origin_name, "is_international": f.is_international,
            "eta_local": C.iso_local(f.landed), "new_eta_local": C.iso_local(new_landed),
            "delay_min": delay, "hotel_zone": zone, "cause": cause,
            "customs_missed": bool(f.is_international and new_landed > customs_close(new_landed)),
            "options": alternates(f, zone, delay),
            "decided_by": "Operator dispatcher and pilot in command"}


def apply_runway_closure(ds: Dataset, rc: dict) -> tuple[Dataset, list[dict]]:
    """Inbounds during the closure land after it, three minutes apart."""
    r_from, r_to = C.parse_t(rc["from"]), C.parse_t(rc["to"])
    hit = sorted([f for f in ds.flights if r_from <= f.landed <= r_to], key=lambda f: f.landed)
    new_landed = {f.flight_id: max(f.landed, r_to + timedelta(minutes=3 * i)) for i, f in enumerate(hit)}
    flights = [replace(f, landed=new_landed[f.flight_id],
                       departed_vny=max(f.departed_vny, new_landed[f.flight_id] + timedelta(minutes=50)))
               if f.flight_id in new_landed else f for f in ds.flights]
    affected = [_affected_row(ds, f, new_landed[f.flight_id], "runway_closure") for f in hit]
    return Dataset(ds.source, ds.scenario, sorted(flights, key=lambda f: f.landed), ds.bookings, ds.stands, ds.notes), affected


def apply_arrival_delay(ds: Dataset, ad: dict) -> tuple[Dataset, list[dict]]:
    """A bank of inbound jets lands late (weather at origin, a ground delay program): same jets, later times."""
    a_from, a_to, mins = C.parse_t(ad["from"]), C.parse_t(ad["to"]), int(ad.get("minutes", 120))
    hit = sorted([f for f in ds.flights if f.stay_type != "pre_window" and a_from <= f.landed <= a_to], key=lambda f: f.landed)
    late = {f.flight_id for f in hit}
    flights = [replace(f, departed_origin=f.departed_origin + timedelta(minutes=mins), landed=f.landed + timedelta(minutes=mins),
                       departed_vny=max(f.departed_vny, f.landed + timedelta(minutes=mins + 50)))
               if f.flight_id in late else f for f in ds.flights]
    affected = [_affected_row(ds, f, f.landed + timedelta(minutes=mins), "arrival_delay") for f in hit]
    return Dataset(ds.source, ds.scenario, sorted(flights, key=lambda f: f.landed), ds.bookings, ds.stands, ds.notes), affected


def apply_disruptions(ds: Dataset, mods: dict) -> tuple[Dataset, list[dict]]:
    """Runway closure and/or arrival delay applied to a dataset; returns the new dataset and affected rows."""
    affected: list[dict] = []
    if mods.get("runway_closed"):
        ds, affected = apply_runway_closure(ds, mods["runway_closed"])
    if mods.get("arrival_delay"):
        ds, late = apply_arrival_delay(ds, mods["arrival_delay"])
        affected += late
    return ds, affected


def restand(before: Dataset, after: Dataset, previous: dict[str, str | None], positions: list,
            pins: dict[str, str] | None = None, budget: float = 1.0) -> dict:
    """Re-solve the stand plan after ETAs/departures change: only the jets that moved, and those they touch."""
    old = {f.flight_id: (f.landed, f.departed_vny) for f in before.flights}
    changed = {f.flight_id for f in after.flights if old.get(f.flight_id) != (f.landed, f.departed_vny)}
    if not changed:
        return {"changed_times": 0, "re_planned": 0, "moves": [], "overflow_before": stands._count_over(before.flights, previous),
                "overflow_after": stands._count_over(before.flights, previous), "boxed_in": 0, "solver": "unchanged"}
    sol = stands.resolve(after.flights, positions, previous, changed, pins, budget=budget)
    moves = [{"flight_id": fid, "from": previous.get(fid), "to": pid, "time_changed": fid in changed}
             for fid, pid in sol.assignment.items() if previous.get(fid) != pid]
    return {"changed_times": len(changed), "re_planned": sol.windows[0]["re_planned"] if sol.windows else 0,
            "moves": sorted(moves, key=lambda m: (not m["time_changed"], m["flight_id"])),
            "overflow_before": stands._count_over(before.flights, previous),
            "overflow_after": sol.overflow,
            "boxed_in": len(stands.violations(after.flights, positions, sol.assignment)),
            "solver": sol.method}


def run(base: Dataset, changed: Dataset, mods: dict, weights: dict) -> dict:
    """Re-run strategies, alerts and the priority queue under the modifiers. `changed` already has the demand change."""
    changed, affected = apply_disruptions(changed, mods)
    t = C.parse_t(mods.get("at"))
    if mods.get("runway_closed"):
        t = C.parse_t(mods["runway_closed"]["from"])
    if mods.get("arrival_delay"):
        t = C.parse_t(mods["arrival_delay"]["from"])
    mods_alert = {**mods, "affected_count": len(affected), "affected_flights": affected}

    before, after = strategies(base), strategies(changed)
    kpi_diff = {b["id"]: {k: [b["kpis"][k], a["kpis"][k]] for k in b["kpis"] if k != "risk"}
                for b, a in zip(before["strategies"], after["strategies"])}
    alerts_before = {x["id"] for x in alerts(base, t)["alerts"]}
    alerts_after = alerts(changed, t, mods_alert)["alerts"]

    q_before = priority_queue(base, t, weights)
    q_after = priority_queue(changed, t, weights, mods.get("customs_hours"))
    rank_before = {i["booking_code"]: i["rank"] for i in q_before["items"]}
    queue_changes = [{"booking_code": i["booking_code"], "flight_id": i["flight_id"],
                      "rank_before": rank_before.get(i["booking_code"]), "rank_after": i["rank"], "reasons": i["reasons"]}
                     for i in q_after["items"] if rank_before.get(i["booking_code"]) != i["rank"]]

    customs_risk = [x for x in alerts_after if x["kind"] == "customs_window"]
    facts = [
        {"id": "whatif.affected", "value": len(affected), "text": "inbound jets affected"},
        {"id": "whatif.max_delay_min", "value": max([x["delay_min"] for x in affected], default=0), "text": "max delay"},
        {"id": "whatif.customs_at_risk", "value": max(len(customs_risk), sum(1 for x in affected if x.get("customs_missed"))),
         "text": "international arrivals at customs risk"},
        {"id": "whatif.hours_before", "value": before["status_quo"]["hours_over_capacity"], "text": "hours over capacity before"},
        {"id": "whatif.hours_after", "value": after["status_quo"]["hours_over_capacity"], "text": "hours over capacity after"},
        {"id": "whatif.queue_reordered", "value": len(queue_changes), "text": "ground-handling queue positions that changed"},
    ]
    if mods.get("arrival_delay"):
        # Fixed-time commitments the delay now breaks: the deadline was reachable before, not after.
        broken = 0
        for x in affected:
            bk = base.bookings.get(x["booking_code"] or "")
            if bk and bk.deadline_local:
                drive = timedelta(minutes=drive_minutes("KVNY", bk.hotel_zone) + 25)
                if C.parse_t(x["eta_local"]) + drive <= bk.deadline_local < C.parse_t(x["new_eta_local"]) + drive:
                    broken += 1
        kb, ka = before["strategies"][1]["kpis"], after["strategies"][1]["kpis"]
        facts += [
            {"id": "whatif.peak_moves_before", "value": kb["peak_movements_per_hour"], "text": "movements in the peak hour before"},
            {"id": "whatif.peak_moves_after", "value": ka["peak_movements_per_hour"], "text": "movements in the peak hour after"},
            {"id": "whatif.staff_before", "value": kb["peak_line_staff"], "text": "line techs at the peak, strategy B, before"},
            {"id": "whatif.staff_after", "value": ka["peak_line_staff"], "text": "line techs at the peak, strategy B, after"},
            {"id": "whatif.commitments_at_risk", "value": broken, "text": "fixed-time commitments now at risk"},
        ]
    return {"modifiers": mods, "kpi_diff": kpi_diff,
            "status_quo": {"before": before["status_quo"], "after": after["status_quo"]},
            "new_alerts": [x for x in alerts_after if x["id"] not in alerts_before],
            "affected_flights": affected, "strategies": after["strategies"],
            "queue": q_after["items"][:10], "queue_changes": queue_changes, "t_local": C.iso_local(t),
            "facts": facts}
