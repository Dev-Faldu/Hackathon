"""Live-mode state at any replay time: aircraft in the air, the ramp, recent events."""
from __future__ import annotations

import math
from datetime import datetime, timedelta

from . import config as C
from .data import KVNY, Dataset
from .engine import assign_stands, capacity, eta_band_min


def _interp(lat1: float, lon1: float, lat2: float, lon2: float, frac: float) -> tuple[float, float]:
    """Point at `frac` along the great circle. Paths are interpolated, not real tracks."""
    p1, l1, p2, l2 = map(math.radians, (lat1, lon1, lat2, lon2))
    d = 2 * math.asin(math.sqrt(math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin((l2 - l1) / 2) ** 2))
    if d == 0:
        return lat1, lon1
    a, b = math.sin((1 - frac) * d) / math.sin(d), math.sin(frac * d) / math.sin(d)
    x = a * math.cos(p1) * math.cos(l1) + b * math.cos(p2) * math.cos(l2)
    y = a * math.cos(p1) * math.sin(l1) + b * math.cos(p2) * math.sin(l2)
    z = a * math.sin(p1) + b * math.sin(p2)
    return math.degrees(math.atan2(z, math.hypot(x, y))), math.degrees(math.atan2(y, x))


class Replay:
    def __init__(self, ds: Dataset):
        self.ds = ds
        self.plan = assign_stands(ds.flights, ds.stands)
        self.conflicts = sum(p["conflicts"] for p in self.plan.values())

    def state(self, t: datetime) -> dict:
        ds = self.ds
        airborne, ground, recent, upcoming = [], [], [], []
        overflow = 0
        for f in ds.flights:
            if f.departed_origin <= t < f.landed:
                total = (f.landed - f.departed_origin).total_seconds()
                frac = (t - f.departed_origin).total_seconds() / total if total else 1
                lat, lon = _interp(f.origin_lat, f.origin_lon, *KVNY, frac)
                mins_to = (f.landed - t).total_seconds() / 60
                airborne.append({"flight_id": f.flight_id, "booking_code": f.booking_code, "size_class": f.size_class,
                                 "origin": f.origin, "origin_name": f.origin_name, "origin_lat": f.origin_lat,
                                 "origin_lon": f.origin_lon, "lat": round(lat, 3), "lon": round(lon, 3),
                                 "progress": round(frac, 3), "eta_local": C.iso_local(f.landed),
                                 "eta_p90_local": C.iso_local(f.landed + timedelta(minutes=eta_band_min(mins_to))),
                                 "minutes_to_go": round(mins_to), "is_international": f.is_international})
            if f.landed <= t < f.departed_vny:
                p = self.plan.get(f.flight_id, {})
                if p.get("stand_id") is None:
                    overflow += 1
                ground.append({"flight_id": f.flight_id, "booking_code": f.booking_code, "size_class": f.size_class,
                               "stand_id": p.get("stand_id"), "conflicts": p.get("conflicts", 0),
                               "landed_local": C.iso_local(f.landed), "departs_local": C.iso_local(f.departed_vny),
                               "stay_type": f.stay_type, "footprint": f.footprint})
            if t - timedelta(minutes=45) <= f.landed <= t:
                recent.append({"t_local": C.iso_local(f.landed), "event": "landed", "flight_id": f.flight_id,
                               "origin": f.origin, "size_class": f.size_class})
            if t - timedelta(minutes=45) <= f.departed_vny <= t:
                recent.append({"t_local": C.iso_local(f.departed_vny), "event": "departed", "flight_id": f.flight_id,
                               "origin": f.origin, "size_class": f.size_class})
            if t < f.landed <= t + timedelta(hours=2):
                upcoming.append({"flight_id": f.flight_id, "booking_code": f.booking_code, "eta_local": C.iso_local(f.landed),
                                 "eta_p90_local": C.iso_local(f.landed + timedelta(minutes=eta_band_min((f.landed - t).total_seconds() / 60))),
                                 "origin": f.origin, "origin_name": f.origin_name, "size_class": f.size_class,
                                 "is_international": f.is_international})
        occ = sum(g["footprint"] for g in ground)
        day_start = t.replace(hour=0, minute=0, second=0, microsecond=0)
        recent.sort(key=lambda r: r["t_local"], reverse=True)
        upcoming.sort(key=lambda r: r["eta_local"])
        return {
            "t_local": C.iso_local(t), "source": ds.source, "notes": ds.notes,
            "capacity": capacity(), "occupancy": round(occ, 1), "occupancy_pct": round(occ / capacity() * 100),
            "aircraft_on_ground": len(ground), "overflow_now": overflow, "airborne_count": len(airborne),
            "arrivals_today": sum(1 for f in ds.flights if day_start <= f.landed <= t),
            "departures_today": sum(1 for f in ds.flights if day_start <= f.departed_vny <= t),
            "stand_conflicts_week": self.conflicts,
            "airborne": airborne, "ground": ground, "recent": recent[:12], "upcoming": upcoming,
            "stands": ds.stands, "paths_interpolated": True,
        }
