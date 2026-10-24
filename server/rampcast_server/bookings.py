"""Booking desk: instant parking answers and one inbox for every channel.

Today a trip request reaches the FBO through FlightBridge, a scheduler export, email or the phone. FlightBridge
syncs service items (fuel, hangar, GPU, lav, water) into several FBO systems, some in batch once a request is
confirmed, but nothing checks the request against live ramp space. A person does that by hand, so for an event
week FBOs sell parking weeks ahead and keep a buffer. Here a request is checked against the live parking plan
and the ramp forecast in well under a second, and only the requests that need judgement reach a person.

Requests in the inbox are rebuilt from the replay week's flights. Channel mix, lead times, duplicates and
aircraft swaps are stated assumptions (contracts/assumptions.yaml, bookings).
"""
from __future__ import annotations

import hashlib
import math
import random
import time
from collections import defaultdict
from datetime import datetime, timedelta

from . import config as C
from .data import Dataset, Flight, _short_id
from .engine import customs_close
from .parking import Plan, Position, _column_cost, _ideal_depth, span

A = C.assumptions

# ICAO type designators of jets common at VNY, with the parking size class each uses.
AIRCRAFT_TYPES = {
    "E55P": ("Phenom 300", "light"), "C25B": ("Citation CJ3", "light"), "C25C": ("Citation CJ4", "light"),
    "LJ75": ("Learjet 75", "mid"), "C56X": ("Citation XLS", "mid"), "C68A": ("Citation Latitude", "mid"),
    "CL35": ("Challenger 350", "super_mid"), "C700": ("Citation Longitude", "super_mid"), "G280": ("Gulfstream G280", "super_mid"),
    "GLF5": ("Gulfstream G550", "large"), "GLF6": ("Gulfstream G650", "large"), "GLEX": ("Global 6000", "large"),
    "GL7T": ("Global 7500", "large"), "FA7X": ("Falcon 7X", "large"),
}
SIZE_LABEL = {"light": "Light jet", "mid": "Midsize", "super_mid": "Super-mid", "large": "Large cabin", "other": "Other"}
SERVICES = ("Fuel", "GPU", "Lav", "Water", "Catering", "Hangar", "Customs", "Car to the aircraft")


def _h(*parts: object) -> float:
    """Stable pseudo-random number in [0, 1) from the inputs."""
    return int(hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:8], 16) / 0x100000000


def _req_id(*parts: object) -> str:
    return "RQ-" + hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:5].upper()


def _in_event(t0: datetime, t1: datetime) -> bool:
    w0, w1 = C.window()
    return t0.date() <= w1 and t1.date() >= w0


def _occupants(ds: Dataset, plan: Plan) -> dict[str, list[Flight]]:
    by_pos: dict[str, list[Flight]] = defaultdict(list)
    for f in ds.flights:
        pid = plan.assignment.get(f.flight_id)
        if pid:
            by_pos[pid].append(f)
    return by_pos


def _fits(f: Flight, p: Position, by_pos: dict[str, list[Flight]], plan: Plan, buf: timedelta) -> bool:
    if p.max_wingspan_ft < span(f):
        return False
    if p.kind == "hot" and (f.departed_vny - f.landed).total_seconds() / 3600 > A()["parking"]["hot_spot_max_hours"]:
        return False
    if p.kind == "temp" and not plan.temp_zone:
        return False
    return not any(g.landed < f.departed_vny + buf and f.landed < g.departed_vny + buf for g in by_pos[p.id])


def _best_position(f: Flight, plan: Plan, by_pos: dict[str, list[Flight]]) -> tuple[Position, int] | None:
    """Free position for the whole stay with the fewest tows; the engine's own column rule decides the tows."""
    buf = timedelta(minutes=A()["bookings"]["stay_buffer_min"])
    stay_h = (f.departed_vny - f.landed).total_seconds() / 3600
    columns: dict[tuple[str, int], list[Position]] = defaultdict(list)
    for p in plan.positions:
        if p.kind == "stand":
            columns[(p.row, p.column)].append(p)
    best: tuple[float, Position, int] | None = None
    for p in plan.positions:
        if not _fits(f, p, by_pos, plan, buf):
            continue
        tows = 0
        if p.kind == "stand":
            members = [(g, q) for q in columns[(p.row, p.column)] for g in by_pos[q.id]]
            tows = _column_cost(f, p, members) * A()["parking"]["tows_per_block"]
        score = tows * 10 + (abs(p.depth - _ideal_depth(f)) if p.kind == "stand" else 0) \
            + (-5 if p.kind == "hot" and stay_h <= A()["parking"]["hot_spot_max_hours"] else 0) + (3 if p.kind == "temp" else 0)
        if best is None or score < best[0]:
            best = (score, p, tows)
    return (best[1], best[2]) if best else None


def _position_label(p: Position) -> str:
    if p.kind == "hot":
        return f"Hot spot {p.column} by the terminal (drop-and-go)"
    if p.kind == "temp":
        return f"Temporary stand {p.id} on the closed taxiway"
    return f"Stand {p.id}: row {p.row}, column {p.column}, {('front', 'middle', 'back')[min(p.depth, 3) - 1]} of the column"


def _ramp_risk(occ: dict, t0: datetime, t1: datetime) -> dict:
    hours = [h for h in occ["hours"] if t0 - timedelta(hours=1) < datetime.fromisoformat(h["t_local"]) <= t1]
    if not hours:
        return {"p90_peak": None, "p_over": 0.0, "peak_at": None, "capacity": occ["capacity"]}
    peak = max(hours, key=lambda h: (h["p_over_capacity"], h["p90"]))
    return {"p90_peak": peak["p90"], "p_over": peak["p_over_capacity"], "peak_at": peak["t_local"], "capacity": occ["capacity"]}


def _price(size: str, stay_h: float, hot: bool, event: bool) -> tuple[int, list[dict]]:
    fees = A()["parking_fees_usd"]
    mult = float(fees["event_multiplier"]) if event else 1.0
    if hot:
        base = float(fees["drop_and_go_flat"])
        lines = [{"label": "Drop-and-go handling", "usd": round(base)}]
    else:
        nights = max(1, math.ceil(stay_h / 24))
        base = float(fees[size]) * nights
        lines = [{"label": f"Parking, {nights} night{'s' if nights > 1 else ''} × ${fees[size]}", "usd": round(base)}]
    if event:
        lines.append({"label": f"Event week × {mult:g}", "usd": round(base * (mult - 1))})
    return round(base * mult), lines


def _rule_checks(f: Flight, international: bool) -> list[dict]:
    """Customs, curfew and the game-day TFR, in plain words."""
    a = A()
    out = []
    if international:
        close = customs_close(f.landed)
        opens = a["customs_kvny"]["hours_local"].get(f.landed.strftime("%a").lower(), ["09:00", "20:30"])[0]
        oh, om = map(int, opens.split(":"))
        open_t = f.landed.replace(hour=oh, minute=om, second=0, microsecond=0)
        ok = open_t <= f.landed <= close - timedelta(minutes=a["customs_kvny"]["landing_rights_tolerance_min"])
        out.append({"ok": ok, "label": "Customs", "detail": (f"CBP at KVNY is open {opens}–{close:%H:%M} {f.landed:%a}; arrival fits."
                    if ok else f"CBP at KVNY is open {opens}–{close:%H:%M} {f.landed:%a}. Arrive earlier, or clear customs at KONT or KLAX first.")})
    dep = f.departed_vny.astimezone(C.LA)
    s, e = a["curfew_kvny"]["stage2_jets"]
    in_curfew = dep.strftime("%H:%M") >= s or dep.strftime("%H:%M") < e
    out.append({"ok": not in_curfew, "label": "Noise curfew",
                "detail": f"Departure {dep:%a %H:%M} is inside VNY's {s}–{e} curfew for Stage 2 jets; quieter Stage 3 jets may go." if in_curfew
                else f"Departure {dep:%a %H:%M} is outside VNY's {s}–{e} curfew."})
    game = datetime.fromisoformat(a["event"]["game_date"]).date()
    t0s, t1s = a["tfr_game_day"]["window_local"]
    tfr0 = datetime.combine(game, datetime.strptime(t0s, "%H:%M").time(), tzinfo=C.LA)
    tfr1 = datetime.combine(game, datetime.strptime(t1s, "%H:%M").time(), tzinfo=C.LA)
    hits = [x for x, t in (("arrival", f.landed), ("departure", f.departed_vny)) if tfr0 <= t <= tfr1]
    out.append({"ok": not hits, "label": "Game-day TFR",
                "detail": f"The {' and '.join(hits)} falls inside the {t0s}–{t1s} TFR on game day; it needs the clearance the NOTAM sets out (waiver or gateway screening)." if hits
                else "Outside the game-day TFR window."})
    return out


def quote(ds: Dataset, plan: Plan, occ: dict, req: dict, now: datetime) -> dict:
    """Instant answer for one trip request: a position, a price, and anything a person must decide."""
    t_start = time.perf_counter()
    a = A()
    size = req.get("size_class") or AIRCRAFT_TYPES.get(req.get("aircraft_type", ""), ("", "mid"))[1]
    arrive, depart = C.parse_t(req["arrive_local"]), C.parse_t(req["depart_local"])
    if depart <= arrive:
        return {"decision": "invalid", "headline": "Departure must be after arrival.", "checks": [], "alternatives": []}
    stay_h = (depart - arrive).total_seconds() / 3600
    f = Flight(flight_id="REQUEST", tail_hash="", size_class=size, origin=req.get("origin") or "", origin_name="",
               origin_lat=0.0, origin_lon=0.0, is_international=bool(req.get("international")), departed_origin=arrive,
               landed=arrive, departed_vny=depart, stay_type="drop_and_go" if stay_h <= 3 else "overnight", source="request")
    by_pos = _occupants(ds, plan)
    found = _best_position(f, plan, by_pos)
    risk = _ramp_risk(occ, arrive, depart)
    checks = [{"ok": found is not None, "label": "Ramp space",
               "detail": f"{_position_label(found[0])} is free for the whole stay." if found else
               "Every position that fits this wingspan is taken for part of the stay."}]
    if found:
        checks.append({"ok": found[1] == 0, "label": "Tows",
                       "detail": "No jet has to be moved to fit it in or let it out." if found[1] == 0 else
                       f"{found[1]} tows: it would box in, or be boxed in by, a jet in the same column."})
    if risk["p90_peak"] is not None:
        checks.append({"ok": risk["p_over"] <= a["bookings"]["auto_confirm_max_p_over"], "label": "Forecast",
                       "detail": f"{round(risk['p_over'] * 100)}% chance the ramp is over capacity around {datetime.fromisoformat(risk['peak_at']):%a %H:%M} "
                                 f"(busy case {risk['p90_peak']:.0f} of {risk['capacity']:.0f} large-jet spaces)."})
    checks += _rule_checks(f, f.is_international)

    event = _in_event(arrive, depart)
    rid = _req_id(req.get("tail"), arrive, depart, size, now)
    alternatives: list[dict] = []
    if found is None:
        # Nearest window that fits without tows, then the drop-and-go and partner options.
        for shift in [1, -1, 2, -2, 3, -3, 4, -4, 6, -6, 8, -8, 12, -12]:
            g = Flight(**{**f.__dict__, "landed": arrive + timedelta(hours=shift), "departed_vny": depart + timedelta(hours=shift),
                          "departed_origin": arrive + timedelta(hours=shift)})
            alt = _best_position(g, plan, by_pos)
            if alt and alt[1] == 0:
                alternatives.append({"kind": "shift", "label": f"Arrive {abs(shift)} h {'later' if shift > 0 else 'earlier'}",
                                     "detail": f"{_position_label(alt[0])}, {g.landed:%a %H:%M} to {g.departed_vny:%a %H:%M}, no tows."})
                break
        hot = next((p for p in plan.positions if p.kind == "hot" and not any(
            x.landed < arrive + timedelta(hours=1) and arrive < x.departed_vny for x in by_pos[p.id])), None)
        if hot:
            alternatives.append({"kind": "drop", "label": "Drop and go",
                                 "detail": f"Drop passengers at hot spot {hot.column}, then park at a partner airport: "
                                           + ", ".join(f"{ap} ({a['alternates'][ap]['name']})" for ap in a["overflow"]["partner_airports"] if ap in a["alternates"]) + "."})
        alternatives.append({"kind": "partner", "label": "Partner airport",
                             "detail": f"Land at {a['overflow']['partner_airports'][0]} and drive {a['drive_minutes'].get(a['overflow']['partner_airports'][0], {}).get('Beverly Hills', 40)} min to Beverly Hills."})
        if not plan.temp_zone:
            alternatives.append({"kind": "temp", "label": "If the temporary zone opens",
                                 "detail": f"{a['parking']['temp_zone_stands']} stands on the closed taxiway (strategy C, needs airport and FAA approval)."})
        decision, headline = "full", "Here is what we can offer instead."
        price, lines = 0, []
    else:
        p, tows = found
        price, lines = _price(size, stay_h, p.kind == "hot", event)
        risky = tows > 0 or risk["p_over"] > a["bookings"]["auto_confirm_max_p_over"]
        decision = "approval" if risky else "confirmed"
        headline = (f"{_position_label(p)}." if not risky else
                    f"Fits on {p.id}, but a supervisor should approve: " + ("it costs tows." if tows else "the ramp may be over capacity then."))
    rule_issues = [c for c in checks if c["label"] in ("Customs", "Noise curfew", "Game-day TFR") and not c["ok"]]
    if decision == "confirmed" and rule_issues:
        decision, headline = "approval", f"Space is free, but check {rule_issues[0]['label'].lower()} before confirming."
    hold = now + timedelta(minutes=a["bookings"]["hold_minutes"])
    services = [s for s in req.get("services", []) if s in SERVICES]
    answer_ms = round((time.perf_counter() - t_start) * 1000, 1)
    return {
        "request_id": rid, "decision": decision, "headline": headline, "size_class": size,
        "position": found[0].to_dict() if found else None, "position_label": _position_label(found[0]) if found else None,
        "tows": found[1] if found else None, "price_usd": price, "price_lines": lines, "event_rates": event,
        "hold_expires_local": C.iso_local(hold) if found else None, "checks": checks, "alternatives": alternatives,
        "risk": risk, "answer_ms": answer_ms,
        # What goes back to the operator's trip sheet and into the FBO system when the request is accepted.
        "trip_sheet": {"request_id": rid, "tail": req.get("tail") or None, "aircraft_type": req.get("aircraft_type") or None,
                       "airport": "KVNY", "fbo": a["fbo"]["name"], "eta_local": C.iso_local(arrive), "etd_local": C.iso_local(depart),
                       "parking": {"status": decision, "position": found[0].id if found else None, "price_usd": price,
                                   "hold_expires_local": C.iso_local(hold) if found else None},
                       "services": [{"item": s, "status": "requested"} for s in services]},
    }


def inbox(ds: Dataset, plan: Plan, t: datetime) -> dict:
    """Every request received by time t, from every channel, each checked against the plan and live tracking."""
    a, b = A(), A()["bookings"]
    channels = list(b["channel_mix"].items())
    rows: list[dict] = []
    for f in ds.flights:
        if _h("walkin", f.flight_id) < b["walk_in_share"]:
            continue
        lo, hi = b["lead_days"].get(f.stay_type, [1, 14])
        lead = timedelta(days=lo + (hi - lo) * _h("lead", f.flight_id), hours=_h("hour", f.flight_id) * 10)
        received = f.landed - lead
        if received > t:
            continue
        u, acc, channel = _h("channel", f.flight_id), 0.0, channels[-1][0]
        for name, share in channels:
            acc += share
            if u < acc:
                channel = name
                break
        rnd = random.Random(f.flight_id)
        sigma = 15 if lead < timedelta(days=1) else 45
        asked_eta = f.landed + timedelta(minutes=round(rnd.gauss(0, sigma)))
        asked_size = f.size_class
        if _h("swap", f.flight_id) < b["aircraft_change_share"] and f.size_class in ("mid", "super_mid", "large"):
            asked_size = {"mid": "light", "super_mid": "mid", "large": "super_mid"}[f.size_class]
        pid = plan.assignment.get(f.flight_id)
        issues = []
        notes = []
        tracked = t >= f.landed - timedelta(hours=b["tracking_horizon_h"])
        drift = (f.landed - asked_eta).total_seconds() / 60
        if tracked and abs(drift) > b["eta_change_flag_min"]:
            moved = f"Live ETA {'+' if drift > 0 else '−'}{abs(round(drift))} min ({f.landed:%H:%M}, request said {asked_eta:%H:%M})"
            if abs(drift) > b["eta_change_look_min"]:
                issues.append({"kind": "eta", "text": f"{moved}. Big change: confirm with the crew and the car service."})
            else:
                notes.append(f"{moved}. Plan updated automatically" + (f"; {pid} still free." if pid else "."))
        if asked_size != f.size_class:
            issues.append({"kind": "aircraft", "text": f"Aircraft changed: request says {SIZE_LABEL[asked_size]}, tracking shows {SIZE_LABEL[f.size_class]}. Needs a {span(f)} ft slot."})
        if pid is None:
            issues.append({"kind": "space", "text": "No stand in the plan for this stay. Offer drop-and-go or a partner airport."})
        if f.is_international:
            close = customs_close(f.landed)
            if f.landed > close - timedelta(minutes=a["customs_kvny"]["landing_rights_tolerance_min"]):
                issues.append({"kind": "customs", "text": f"International arrival {f.landed:%a %H:%M} after customs closes {close:%H:%M}."})
        rid = _req_id(f.flight_id)
        row = {"request_id": rid, "received_local": C.iso_local(received), "channel": channel, "flight": _short_id(f.flight_id),
               "flight_id": f.flight_id, "size_class": asked_size, "origin": f.origin, "eta_local": C.iso_local(asked_eta),
               "etd_local": C.iso_local(f.departed_vny), "position": pid, "lead_days": round(lead.total_seconds() / 86400, 1),
               "status": "look" if issues else "auto", "issues": issues, "notes": notes}
        rows.append(row)
        if _h("dup", f.flight_id) < b["duplicate_share"]:
            dup_t = received + timedelta(hours=2 + 20 * _h("duph", f.flight_id))
            if dup_t <= t:
                other = "Email" if channel != "Email" else "Phone"
                rows.append({**row, "request_id": _req_id("dup", f.flight_id), "received_local": C.iso_local(dup_t), "channel": other,
                             "status": "look", "notes": [], "issues": [{"kind": "duplicate", "text": f"Same trip as {rid} via {channel}. Merge, don't book twice."}]})
    rows.sort(key=lambda r: r["received_local"], reverse=True)
    by_channel: dict[str, int] = defaultdict(int)
    for r in rows:
        by_channel[r["channel"]] += 1
    look = [r for r in rows if r["status"] == "look"]
    leads = sorted(r["lead_days"] for r in rows if r["issues"] == [] or r["issues"][0]["kind"] != "duplicate")
    return {"t_local": C.iso_local(t), "total": len(rows), "auto": len(rows) - len(look), "look": len(look),
            "by_channel": dict(by_channel), "by_issue": {k: sum(1 for r in look for i in r["issues"] if i["kind"] == k)
                                                          for k in ("eta", "aircraft", "space", "customs", "duplicate")},
            "median_lead_days": leads[len(leads) // 2] if leads else None,
            "items": rows[:80], "note": "Requests rebuilt from the replay week's flights; channel mix, lead times, duplicates and aircraft swaps are assumptions."}


CONNECTIONS = [
    {"name": "FlightBridge", "kind": "Trip services", "flow": "Trip requests in; RAMPCAST's answer and confirmed services back on the trip sheet",
     "status": "Needs partner credentials", "today": "FlightBridge syncs service items (fuel, hangar, GPU, lav, water) into several FBO systems, some in batch after a request is confirmed. Nothing checks ramp space first.",
     "with_rampcast": "The request is checked against the live ramp plan and forecast before anyone confirms; the answer goes back on the same trip."},
    {"name": "FL3XX · Avianis · Avinode Trip Manager · Airplane Manager", "kind": "Operator scheduling", "flow": "Tail, legs, ETA and ETD, usually through FlightBridge",
     "status": "Through FlightBridge or a trip-sheet file", "today": "A tail swap or new ETA in the scheduler may reach the FBO late, or by phone.",
     "with_rampcast": "Changes come in as an update to the same request and re-run the check: a bigger aircraft needs a bigger slot."},
    {"name": "Total FBO · FBO One · FBO Director · X-1FBO", "kind": "FBO management", "flow": "Confirmed parking position and services written back as a reservation",
     "status": "Export file ready (JSON)", "today": "Staff key the parking position in by hand, or not at all.",
     "with_rampcast": "One accepted answer becomes the reservation, with the position and tows already planned."},
    {"name": "FlightAware · ADS-B", "kind": "Flight tracking", "flow": "Live ETA for every inbound jet",
     "status": "Replay of the 2022 week in this build", "today": "The ramp learns about an early or late arrival when it calls on unicom.",
     "with_rampcast": "A live ETA that moves more than 30 min flags the request and re-plans the stand."},
    {"name": "RAMPCAST inbound endpoint", "kind": "Open interface", "flow": "POST /api/bookings/inbound with a trip request; the instant answer comes back",
     "status": "Live in this build", "today": "—", "with_rampcast": "Any tool that can send JSON gets an answer in under a second."},
]
