"""Alerts engine. Each alert has a severity, a message, a recommended action and the role that owns it.

Rules:
- ramp_capacity: the ramp passes 90% of capacity within the next 2 hours;
- customs_window: an international arrival's P90 ETA falls after VNY customs closes;
- curfew: a departure planned inside the night curfew for an aircraft that rule binds (Stage 2 or older Stage 3);
- car_wrong_airport: a party's car is staged at a different airport from the one their jet is expected to land at
  (a diversion the operator has told us about, or a disrupted flight whose best option is another airport);
- runway: a runway closure that affects our inbound jets (what-if).
"""
from __future__ import annotations

from datetime import datetime, timedelta

from rampcast_server import config as C
from rampcast_server.data import Dataset

from .common import A, CURFEW_LABEL, capacity, curfew_class, customs_close, eta_band_min, in_curfew, occupancy_hourly

CAR_LOOKAHEAD_H = 4
LIKELY_DIVERT_DELAY_MIN = 45   # a disrupted jet this late whose best option is elsewhere may land there


def expected_airports(ds: Dataset, modifiers: dict) -> dict[str, tuple[str, str]]:
    """flight_id -> (airport the jet is expected to land at, why), for jets not expected at KVNY."""
    out: dict[str, tuple[str, str]] = {}
    for x in modifiers.get("affected_flights", []):
        if x.get("cause") != "runway_closure":
            continue  # a jet delayed at its origin still flies to VNY; only a closure here can send it elsewhere
        best = next((o for o in x.get("options", []) if o["airport"] != "KVNY"), None)
        hold = next((o for o in x.get("options", []) if o["airport"] == "KVNY"), None)
        if best and x.get("delay_min", 0) >= LIKELY_DIVERT_DELAY_MIN and (hold is None or best["score"] < hold["score"]):
            out[x["flight_id"]] = (best["airport"], f"may divert to {best['airport']} ({x['delay_min']} min delay)")
    for fid, icao in (modifiers.get("diversions") or {}).items():
        out[fid] = (icao, f"operator reports it will land at {icao}")
    return out


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

    horizon = timedelta(hours=a["curfew_kvny"].get("curfew_alert_lookahead_h", 10))
    for f in ds.flights:
        if not (t < f.departed_vny <= t + horizon):
            continue
        rule = curfew_class(f)
        win = in_curfew(f.departed_vny, rule) if rule else None
        if not win:
            continue
        soon = f.departed_vny - t <= timedelta(hours=2)
        out.append({"id": f"AL-CURFEW-{f.flight_id}", "severity": "high" if soon else "watch", "kind": "curfew",
                    "message": f"{f.flight_id} ({CURFEW_LABEL[rule]}) is planned to depart {f.departed_vny:%a %H:%M}, "
                               f"inside the {win[0]:%H:%M}-{win[1]:%H:%M} VNY curfew",
                    "recommended_action": "Ask the operator to move the departure before the curfew or to the next morning",
                    "owner_role": "Line supervisor", "t_local": C.iso_local(f.departed_vny), "flight_id": f.flight_id})

    expected = expected_airports(ds, modifiers)
    by_id = {f.flight_id: f for f in ds.flights}
    for fid, (icao, why) in expected.items():
        f = by_id.get(fid)
        b = ds.bookings.get((f.booking_code if f else None) or "")
        if f is None or b is None or b.car_staged_at == icao:
            continue
        if not (t - timedelta(hours=1) <= f.landed <= t + timedelta(hours=CAR_LOOKAHEAD_H)) and fid not in (modifiers.get("diversions") or {}):
            continue
        out.append({"id": f"AL-CAR-{b.booking_code}", "severity": "watch", "kind": "car_wrong_airport",
                    "message": f"Car for {b.booking_code} is staged at {b.car_staged_at}, but {fid} {why}",
                    "recommended_action": "Ground dispatcher re-stages the car once the operator confirms the airport",
                    "owner_role": "Ground dispatcher", "t_local": C.iso_local(f.landed), "flight_id": fid})

    order = {"high": 0, "watch": 1, "info": 2}
    out.sort(key=lambda x: (order[x["severity"]], x["t_local"]))
    return {"t_local": C.iso_local(t), "alerts": out}
