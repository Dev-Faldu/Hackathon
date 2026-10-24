"""Need-based priority queue for ground handling (cars, curb, stand order).

Ranking is strict, in this order: fixed-time commitment slack, then medical/accessibility, then hard
deadlines (customs closing, night curfew), then minutes waited, then first-come. The manager's weights set
that order (heaviest first; the defaults give exactly the order above; a criterion weighted 0 is ignored)
and the weighted score is shown next to each rank for reference. Every rank carries plain-language reasons.

Slack counts once it is tight (assumptions.yaml priority_rules.tight_slack_min, 60 min by default). Tight
commitments are ranked by their actual slack, so a party already 65 min late goes ahead of one 20 min late,
and a party with three hours to spare does not jump ahead of a medical request.

The scorer only ever sees a PriorityInput. It has no field for name, status, tier, loyalty or payment,
and a test fails if one is added.
"""
from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from datetime import datetime, timedelta

import numpy as np

from rampcast_server import config as C
from rampcast_server.data import Booking, Dataset, Flight

from .common import A, CURFEW_LABEL, curfew_class, curfew_window, customs_close, drive_minutes, eta_band_min

ORDER = ("fixed_time", "medical_access", "hard_deadline", "wait")   # the spec's order, used to break weight ties
BANNED_FIELDS = {"name", "passenger_name", "status", "tier", "loyalty", "payment", "price", "vip_level",
                 "membership", "card", "spend"}
CURFEW_PRESSURE_H = 3          # a curfew start this close to a planned departure is a hard deadline


@dataclass(frozen=True)
class PriorityInput:
    """Everything the scorer may read. Need-based only."""
    booking_code: str
    phase: str                    # inbound | on_ground
    eta: datetime
    eta_p90: datetime
    departs: datetime
    commitment_type: str          # fixed_time | medical_access | none
    deadline: datetime | None
    hotel_zone: str
    drive_min: int
    is_international: bool
    customs_close: datetime | None
    curfew_rule: str | None       # stage2_jets | older_stage3_jets | None
    minutes_waited: float


def to_input(f: Flight, b: Booking, t: datetime, customs_override: dict | None = None) -> PriorityInput:
    mins_to = (f.landed - t).total_seconds() / 60
    return PriorityInput(
        booking_code=b.booking_code,
        phase="inbound" if mins_to > 0 else "on_ground",
        eta=f.landed,
        eta_p90=f.landed + timedelta(minutes=eta_band_min(mins_to)),
        departs=f.departed_vny,
        commitment_type=b.commitment_type,
        deadline=b.deadline_local,
        hotel_zone=b.hotel_zone,
        drive_min=drive_minutes("KVNY", b.hotel_zone),
        is_international=f.is_international,
        customs_close=customs_close(f.landed, customs_override) if f.is_international else None,
        curfew_rule=curfew_class(f),
        minutes_waited=max(0.0, -mins_to),
    )


def score(inp: PriorityInput, weights: dict) -> tuple[dict[str, float], list[str], int | None]:
    """Components in [0, 1], plain-language reasons, and fixed-time slack in minutes."""
    comp = {k: 0.0 for k in ORDER}
    reasons: list[str] = []
    slack = None
    if inp.commitment_type == "fixed_time" and inp.deadline:
        tight = tight_slack_min()
        slack = int((inp.deadline - (inp.eta + timedelta(minutes=20 + inp.drive_min))).total_seconds() // 60)
        comp["fixed_time"] = float(np.clip((tight - slack) / tight, 0, 1))
        where = f"Fixed-time commitment in {inp.hotel_zone} at {inp.deadline:%H:%M}"
        if slack < 0:
            reasons.append(f"{where}; already {-slack} min short after a {inp.drive_min}-min drive")
        elif slack <= tight:
            reasons.append(f"{where}; only {slack} min of slack after a {inp.drive_min}-min drive")
        else:
            reasons.append(f"{where}; {slack} min of slack, not urgent until it drops to {tight}")
    if inp.commitment_type == "medical_access":
        comp["medical_access"] = 1.0
        reasons.append("Medical or accessibility assistance requested")
    if inp.is_international and inp.customs_close:
        if inp.eta_p90 > inp.customs_close:
            comp["hard_deadline"] = 1.0
            reasons.append(f"Customs closes {inp.customs_close:%H:%M}; P90 arrival {inp.eta_p90:%H:%M}")
        else:
            reasons.append("International: customs inspection at Signature West before release")
    if inp.curfew_rule:
        start, _ = curfew_window(inp.departs, inp.curfew_rule)
        if start <= inp.departs:
            start = curfew_window(inp.departs + timedelta(days=1), inp.curfew_rule)[0]
        if timedelta(0) <= start - inp.departs <= timedelta(hours=CURFEW_PRESSURE_H):
            comp["hard_deadline"] = 1.0
            reasons.append(f"{CURFEW_LABEL[inp.curfew_rule].capitalize()}: must depart before the {start:%H:%M} "
                           f"curfew (planned {inp.departs:%H:%M})")
    if inp.phase == "on_ground":
        comp["wait"] = float(min(1.0, inp.minutes_waited / 30))
        reasons.append(f"Waiting {int(inp.minutes_waited)} min since landing")
    if not reasons:
        reasons.append("No time commitment; served in arrival order")
    return comp, reasons, slack


def tight_slack_min() -> int:
    return int(A().get("priority_rules", {}).get("tight_slack_min", 60))


def tier_order(weights: dict) -> list[str]:
    """Criteria from most to least important: heaviest weight first, the spec's order breaking ties.
    A criterion the manager weights 0 is left out."""
    used = [k for k in ORDER if float(weights.get(k, 0)) > 0]
    return sorted(used, key=lambda k: (-float(weights.get(k, 0)), ORDER.index(k)))


def rank_key(comp: dict[str, float], slack: int | None, eta: datetime, tiers: list[str]) -> tuple:
    """Smaller sorts first. Tight fixed-time commitments sort by actual slack; other tiers by their value."""
    key: list = []
    for k in tiers:
        if k == "fixed_time":
            key.append((0, slack) if slack is not None and slack <= tight_slack_min() else (1, 0))
        else:
            key.append((0, -comp[k]))
    return tuple(key) + (eta,)


def priority_queue(ds: Dataset, t: datetime, weights: dict, customs_override: dict | None = None) -> dict:
    tiers = tier_order(weights)
    items = []
    for f in ds.flights:
        b = ds.bookings.get(f.booking_code or "")
        if not b:
            continue
        mins_to = (f.landed - t).total_seconds() / 60
        if not (-35 <= mins_to <= 180):
            continue
        inp = to_input(f, b, t, customs_override)
        comp, reasons, slack = score(inp, weights)
        items.append({"booking_code": b.booking_code, "flight_id": f.flight_id, "status": inp.phase,
                      "eta_local": C.iso_local(f.landed), "eta_p90_local": C.iso_local(inp.eta_p90),
                      "size_class": f.size_class, "origin": f.origin, "is_international": f.is_international,
                      "party_size": b.party_size, "hotel_zone": b.hotel_zone,
                      "score": round(sum(float(weights.get(k, 0)) * v for k, v in comp.items()), 3),
                      "components": comp, "slack_min": slack, "reasons": reasons, "synthetic": b.synthetic,
                      "_key": rank_key(comp, slack, f.landed, tiers)})
    items.sort(key=lambda i: i["_key"])
    for rank, i in enumerate(items, 1):
        i.pop("_key")
        i["rank"] = rank
    order_txt = ", then ".join(k.replace("_", " ") for k in tiers) or "arrival time"
    return {"t_local": C.iso_local(t), "weights": weights, "order": tiers, "items": items,
            "policy": f"Need-based only, ranked strictly by {order_txt}, then first-come. "
                      "Identity, status and payment are never inputs."}


def input_fields() -> set[str]:
    return {f.name for f in dataclasses.fields(PriorityInput)}
