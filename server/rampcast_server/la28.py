"""LA28 stretch goal: the same forecast and parking engine on an Olympic opening-week profile.

The week runs in the engine's Tue..Mon frame and is relabelled to Tue 11 - Mon 17 July 2028, so customs
hours, curfew and staffing rules line up by weekday. Every number is an assumption-driven estimate: there is
no Olympic analog at VNY to validate against, and the UI says so.
"""
from __future__ import annotations

import functools
from datetime import date, timedelta

import numpy as np

from . import config as C, engine, forecast, parking
from .data import ORIGINS, Dataset, Profile, daily_arrivals, generate_sample

START = date(2028, 7, 11)  # Tuesday; Opening Ceremony Friday 14 July 2028
EVENT = {"name": "LA28 Olympic Games · opening week", "ceremony_date": "2028-07-14",
         "window": ["2028-07-11", "2028-07-17"], "games": ["2028-07-14", "2028-07-30"]}

# Heads of state, NOC and sponsor delegations: more international, larger cabins, longer stays.
LA28_ORIGINS = tuple(ORIGINS) + (
    ("RJTT", "Tokyo Haneda", 35.552, 139.780, 3, True),
    ("OMDW", "Dubai Al Maktoum", 24.896, 55.161, 3, True),
    ("EDDB", "Berlin", 52.362, 13.501, 2, True),
    ("YSSY", "Sydney", -33.946, 151.177, 2, True),
    ("SBGR", "Sao Paulo", -23.435, -46.473, 2, True),
    ("LIRA", "Rome Ciampino", 41.799, 12.595, 2, True),
)

PROFILE = Profile(
    name="la28",
    base=(22, 23, 25, 26, 17, 16, 21),           # an ordinary July week runs ~10% above February
    uplift=(1.25, 1.4, 1.65, 1.8, 1.35, 1.3, 1.25),  # broad, sustained lift; peak on ceremony day
    event_day=3, quiet_hours=(15, 22),           # NSSE TFRs around the ceremony venues in the evening
    size_mix=(("large", 0.45), ("super_mid", 0.25), ("mid", 0.18), ("light", 0.12)),
    pre_window=30, pre_dep_days=(7, 15),         # early delegations already parked, staying through the Games
    dg_share_event=0.30, long_stay_share=0.62,
    origins=LA28_ORIGINS,
    note="LA28 sample: seeded flights from stated assumptions (no Olympic analog at VNY). Not real movements.",
)

ASSUMPTIONS = [
    "Window Tue 11 - Mon 17 Jul 2028; Opening Ceremony Fri 14 Jul (SoFi Stadium and LA Memorial Coliseum).",
    "Ordinary July week ~10% above February; medium lift peaks at 1.8x on ceremony day (Super Bowl: 2.1x).",
    "62% of non-drop-and-go arrivals stay 3-12 days; 30 delegation jets already parked when the week opens.",
    "Larger cabins (45% large) and more long-haul international origins than the Super Bowl.",
    "Security perimeters (NSSE) slow arrivals in the evening around venues on ceremony day.",
    "Same FBO, stands, fees, customs hours and partner airports as the Super Bowl plan.",
]


def _label(d: date) -> str:
    return (START + (d - C.window()[0])).isoformat()


def _label_hour(h: int) -> str:
    day = START + timedelta(days=h // 24)
    return f"{day.isoformat()}T{h % 24:02d}:00"


def dataset(scenario: str, seed: int = 2028, noise: float = 0.12) -> Dataset:
    return generate_sample(scenario, seed=seed, count_noise=noise, profile=PROFILE)


@functools.lru_cache(maxsize=4)
def _occupancy(scenario: str, runs: int = 40) -> tuple[list[float], list[float]]:
    sims = np.stack([engine.occupancy_hourly(dataset(scenario, seed=2800 + i).flights) for i in range(runs)])
    return ([round(float(x), 1) for x in np.percentile(sims, 50, axis=0)],
            [round(float(x), 1) for x in np.percentile(sims, 90, axis=0)])


@functools.lru_cache(maxsize=4)
def report(scenario: str) -> dict:
    cap = engine.capacity()
    # Forecast: ordinary July week vs LA28 week, same banding rule as the Super Bowl reference forecast.
    p50 = daily_arrivals(scenario, PROFILE)
    days = []
    for d, base, mid in zip(C.window_days(), PROFILE.base, p50):
        lift = mid - base
        days.append({"date": _label(d), "baseline_p50": base, "p10": max(0, round(base + lift * 0.65 - 2)),
                     "p50": mid, "p90": round(base + lift * 1.4 + 3)})
    by_scenario = {s: sum(daily_arrivals(s, PROFILE)) for s in C.SCENARIOS}

    occ50, occ90 = _occupancy(scenario)
    sb_hours = forecast.occupancy(scenario)["hours"]
    hours = [{"t_local": _label_hour(h), "la28_p50": occ50[h], "la28_p90": occ90[h], "sb_p50": sb_hours[h]["p50"]}
             for h in range(C.n_hours())]
    over = [h for h, v in enumerate(occ50) if v > cap]

    ds = dataset(scenario)
    sb = generate_sample(scenario, seed=2027, count_noise=0.12)
    end = C.window_start_local() + timedelta(hours=C.n_hours())

    def profile_stats(x: Dataset) -> dict:
        arr = [f for f in x.flights if f.stay_type != "pre_window"]
        stays = [(f.departed_vny - f.landed).total_seconds() / 3600 for f in arr if f.stay_type != "drop_and_go"]
        on_ramp_end = [f for f in x.flights if f.landed < end <= f.departed_vny]
        late_intl = [f for f in arr if f.is_international and f.landed > engine.customs_close(f.landed)]
        wb = parking.metrics(x, parking.build(x, "first_come"))
        opt = parking.metrics(x, parking.build(x, "optimized"))
        st = engine.strategies(x)
        occ = engine.occupancy_hourly(x.flights)
        return {
            "arrivals": len(arr),
            "median_stay_h": round(float(np.median(stays)), 1) if stays else 0,
            "parked_at_week_end": len(on_ramp_end),
            "international_pct": round(sum(f.is_international for f in arr) / max(1, len(arr)) * 100),
            "intl_after_customs_close": len(late_intl),
            "large_pct": round(sum(f.size_class == "large" for f in arr) / max(1, len(arr)) * 100),
            "peak_demand": round(float(occ.max()), 1),
            "hours_over_capacity": st["status_quo"]["hours_over_capacity"],
            "tows_whiteboard": wb["tows"], "tows_rampcast": opt["tows"],
            "overflow_rampcast": opt["overflow_aircraft"],
            "strategies": [{"id": c["id"], "name": c["name"], "kpis": c["kpis"], "approvers": c["approvers"]}
                           for c in st["strategies"]],
        }

    la, sbs = profile_stats(ds), profile_stats(sb)
    first_over = _label_hour(over[0]) if over else None
    b = next(c for c in la["strategies"] if c["id"] == "B")["kpis"]
    recs = [
        {"title": "Sell stays by the night, from day one",
         "detail": f"{la['parked_at_week_end']} jets are still on the ramp when the week ends (Super Bowl: {sbs['parked_at_week_end']}). "
                   f"Cap overnight bookings and book partner-airport long-term parking before "
                   f"{date.fromisoformat(first_over[:10]).strftime('%a %d %b') if first_over else 'the ceremony'}, when the ramp first fills.",
         "approver": "FBO general manager"},
        {"title": "Plan staff for 17 days, not 5",
         "detail": f"Strategy B needs {b['peak_line_staff']} line techs at the peak hour and the demand does not clear on Monday. "
                   f"Build rotations that last through 30 July.",
         "approver": "Line supervisor"},
        {"title": "Ask CBP for longer customs hours early",
         "detail": f"{la['international_pct']}% of arrivals are international (Super Bowl: {sbs['international_pct']}%); "
                   f"{la['intl_after_customs_close']} land after VNY customs closes. A person sends the request to CBP.",
         "approver": "Customer service lead"},
        {"title": "Reserve wide stands for large cabins",
         "detail": f"{la['large_pct']}% of arrivals are large cabins. Keep the deep 100-110 ft stands for them and move "
                   f"light jets to the hot spots and partner fields.",
         "approver": "FBO general manager"},
        {"title": "Fuel for a longer, flatter peak",
         "detail": f"Plan {b['fuel_gal_week']:,} gal for the week under strategy B and confirm resupply for the second week of the Games.",
         "approver": "Fuel manager"},
    ]
    return {
        "event": EVENT, "scenario": scenario, "capacity": cap, "source": ds.source, "notes": ds.notes,
        "assumptions": ASSUMPTIONS, "days": days, "week_by_scenario": by_scenario, "hours": hours,
        "first_hour_over_capacity": first_over, "hours_over_capacity_p50": len(over),
        "la28": la, "super_bowl": sbs, "recommendations": recs,
        "never": "RAMPCAST never decides who gets a stand by who they are, and never coordinates with the Secret Service, "
                 "FAA or CBP on its own: a person does.",
    }
