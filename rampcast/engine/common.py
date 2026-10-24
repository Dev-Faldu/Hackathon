"""Shared helpers: hourly occupancy, capacity, time windows (customs, curfew) and drive times."""
from __future__ import annotations

import hashlib
import math
from dataclasses import replace
from datetime import datetime, timedelta

import numpy as np

from rampcast_server import config as C
from rampcast_server.data import KVNY, Flight

A = C.assumptions


def hours_from_start(t: datetime) -> float:
    return (t - C.window_start_local()).total_seconds() / 3600


def minutes_from_start(t: datetime) -> int:
    return int((t - C.window_start_local()).total_seconds() // 60)


def occupancy_hourly(flights: list[Flight]) -> np.ndarray:
    """Large-cabin equivalents on the ramp at the middle of each hour of the window."""
    mids = np.arange(C.n_hours()) + 0.5
    occ = np.zeros(C.n_hours())
    for f in flights:
        lo, hi = hours_from_start(f.landed), hours_from_start(f.departed_vny)
        occ += f.footprint * ((mids >= lo) & (mids < hi))
    return occ


def movements_hourly(flights: list[Flight]) -> np.ndarray:
    moves = np.zeros(C.n_hours())
    for f in flights:
        for t in (f.landed, f.departed_vny):
            h = int(hours_from_start(t))
            if 0 <= h < C.n_hours():
                moves[h] += 1
    return moves


def capacity() -> float:
    from rampcast_server.store import get_settings
    return float(get_settings().get("capacity") or A()["fbo"]["capacity_large_equiv"])


def as_drop_and_go(f: Flight) -> Flight:
    return replace(f, departed_vny=f.landed + timedelta(minutes=90), stay_type="drop_and_go")


def staff(flights: list[Flight], extra: int = 0) -> tuple[int, int]:
    """Line techs at the busiest hour: two per three movements, plus a base crew of two."""
    moves = movements_hourly(flights)
    peak = int(moves.max()) if len(moves) else 0
    return math.ceil(peak / 3) * 2 + 2 + extra, peak


def eta_band_min(minutes_to_go: float) -> float:
    """P90 arrival-time spread. Reference shape; the ML module calibrates it on 2022 tracks."""
    return min(45.0, 4 + 0.08 * max(0.0, minutes_to_go))


def _hhmm(day: datetime, s: str) -> datetime:
    h, m = map(int, s.split(":"))
    return day.replace(hour=h, minute=m, second=0, microsecond=0)


def customs_close(day: datetime, override: dict | None = None) -> datetime:
    hours = dict(A()["customs_kvny"]["hours_local"])
    if override:
        hours.update(override)
    key = day.strftime("%a").lower()
    return _hhmm(day.astimezone(C.LA), hours.get(key, ["09:00", "20:30"])[1])


# ---------- night curfew ----------

CURFEW_LABEL = {"stage2_jets": "Stage 2 jet", "older_stage3_jets": "older Stage 3 jet"}


def curfew_class(f: Flight) -> str | None:
    """Which VNY curfew rule binds this aircraft, or None if none does.

    Uses the flight's own `curfew_class` when the data pipeline supplies one (from the FAA registry noise stage).
    Otherwise it is assigned from the hashed tail ID at the shares in assumptions.yaml: stable per aircraft,
    labelled an assumption, never random per request.
    """
    own = getattr(f, "curfew_class", None)
    if own is not None:
        return own or None
    shares = A()["curfew_kvny"].get("flagged_share_assumption", {})
    u = int(hashlib.sha1(f.tail_hash.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    acc = 0.0
    for cls, share in shares.items():
        acc += float(share)
        if u < acc:
            return cls
    return None


def curfew_window(day: datetime, cls: str) -> tuple[datetime, datetime]:
    """The curfew window that starts on `day` (local), e.g. 22:00 to 07:00 the next morning."""
    start_s, end_s = A()["curfew_kvny"][cls]
    start = _hhmm(day.astimezone(C.LA), start_s)
    end = _hhmm(start + timedelta(days=1), end_s)
    return start, end


def in_curfew(t: datetime, cls: str) -> tuple[datetime, datetime] | None:
    """The curfew window containing local time t for this rule, if any."""
    for d in (t - timedelta(days=1), t):
        s, e = curfew_window(d, cls)
        if s <= t < e:
            return s, e
    return None


# ---------- geography ----------

def drive_minutes(airport: str, zone: str) -> int:
    return int(A()["drive_minutes"].get(airport, A()["drive_minutes"]["KVNY"]).get(zone, 45))


AIRPORT_LL = {"KBUR": (34.2007, -118.3585), "KWHP": (34.2593, -118.4134), "KCMA": (34.2137, -119.0943),
              "KLGB": (33.8177, -118.1516), "KONT": (34.0560, -117.6012), "KLAX": (33.9425, -118.4081), "KVNY": KVNY}


def airport_ll(icao: str) -> tuple[float, float]:
    return AIRPORT_LL.get(icao, KVNY)
