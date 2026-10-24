"""Reference forecast and ramp Monte Carlo. The ML module replaces these through adapters.py."""
from __future__ import annotations

import functools
from datetime import timedelta

import numpy as np

from . import config as C
from .data import BASE_ARRIVALS, daily_arrivals, generate_sample
from .engine import capacity, occupancy_hourly


def forecast(scenario: str) -> dict:
    p50 = daily_arrivals(scenario)
    days = []
    for day, base, mid in zip(C.window_days(), BASE_ARRIVALS, p50):
        lift = mid - base
        days.append({"date": day.isoformat(), "baseline_p50": base,
                     "p10": max(0, round(base + lift * 0.65 - 2)), "p50": mid,
                     "p90": round(base + lift * 1.4 + 3)})
    return {"scenario": scenario, "airport": "KVNY", "model": "reference", "days": days,
            "validation": {"event_held_out": None, "mape_pct": None, "interval_coverage_pct": None},
            "notes": ["Reference curve shaped by 2022 LA and 2026 Bay Area analogs; replaced by the trained model."]}


def occupancy(scenario: str) -> dict:
    return _occupancy(scenario, capacity())


@functools.lru_cache(maxsize=16)
def _occupancy(scenario: str, cap: float, runs: int = 120) -> dict:
    sims = _sims(scenario, runs)
    start = C.window_start_local()
    hours = []
    for h in range(C.n_hours()):
        col = sims[:, h]
        hours.append({"t_local": C.iso_local(start + timedelta(hours=h)),
                      "p50": round(float(np.percentile(col, 50)), 1),
                      "p90": round(float(np.percentile(col, 90)), 1),
                      "p_over_capacity": round(float((col > cap).mean()), 2)})
    return {"scenario": scenario, "capacity": cap, "runs": runs, "model": "reference", "hours": hours}


@functools.lru_cache(maxsize=4)
def _sims(scenario: str, runs: int) -> np.ndarray:
    return np.stack([occupancy_hourly(generate_sample(scenario, seed=1000 + i, count_noise=0.12).flights) for i in range(runs)])
