"""Role 2 plug-in for the RAMPCAST server.

server/rampcast_server/adapters.py calls get_forecast(scenario) and get_occupancy(scenario); both return the JSON
shapes in contracts/README.md, plus a few additive fields. Numbers are arrivals and occupancy at our FBO.
"""
from __future__ import annotations

import functools
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

import numpy as np

from . import data_io as io
from .cache import load_or_simulate
from .ramp_sim import SimResult
from .uplift import SCENARIOS, scenario_levels

MODEL_NAME = "rampcast.forecast v1 (analog uplift + ramp Monte Carlo)"
LA = ZoneInfo("America/Los_Angeles")


def _check(scenario: str) -> str:
    if scenario not in SCENARIOS:
        raise ValueError(f"scenario must be one of {SCENARIOS}")
    return scenario


@functools.lru_cache(maxsize=8)
def _result(scenario: str) -> SimResult:
    return load_or_simulate(scenario)


@functools.lru_cache(maxsize=8)
def _occupancy_quantiles(scenario: str) -> tuple[np.ndarray, np.ndarray]:
    occ = _result(scenario).occupancy
    return np.percentile(occ, 50, axis=0), np.percentile(occ, 90, axis=0)


def _capacity() -> float:
    """Current ramp capacity: the manager's Event setup value if the server is running, else assumptions.yaml."""
    try:
        from rampcast_server.engine import capacity
        return float(capacity())
    except Exception:
        return float(io.assumptions()["fbo"]["capacity_large_equiv"])


def _notes() -> list[str]:
    a = io.assumptions()
    lv = scenario_levels()
    return [
        f"Arrivals at our FBO: KVNY arrivals x {a['fbo']['share_of_airport_arrivals']} (fbo.share_of_airport_arrivals).",
        f"Baseline from ordinary days in Role 1's files (data source: {io.data_source()}).",
        f"Thu-Sun arrival multiplier: low {lv['low']}, medium {lv['medium']}, high {lv['high']}, "
        "from published WingX ratios for Super Bowl LVIII (2024) and LX (2026).",
    ]


def get_forecast(scenario: str) -> dict:
    r = _result(_check(scenario))
    q = np.percentile(r.daily_counts, [10, 50, 90], axis=0)
    share = float(io.assumptions()["fbo"]["share_of_airport_arrivals"])
    days = []
    for i, d in enumerate(r.days):
        p10, p50, p90 = (int(round(float(x))) for x in q[:, i])
        days.append({"date": d.isoformat(), "baseline_p50": int(round(float(r.baseline_fbo[i]))),
                     "p10": p10, "p50": p50, "p90": p90,
                     "expected": round(float(r.expected_fbo[i]), 1),
                     "multiplier": round(float(r.multiplier[i]), 3),
                     "airport_expected": round(float(r.expected_fbo[i]) / share, 1)})
    real = io.is_real(io.data_source())
    return {
        "scenario": scenario, "airport": "KVNY", "level": "fbo", "model": MODEL_NAME,
        "data_source": io.data_source(), "days": days,
        "validation": {
            "event_held_out": None, "mape_pct": None, "interval_coverage_pct": None,
            "validation_note": ("Daily accuracy is not reported: the 2022 week in data/processed is reconstructed "
                                "from published counts, so a backtest on it would test assumptions, not the model."
                                if not real else "Real data detected; run rampcast.forecast validation."),
        },
        "notes": _notes(),
    }


def get_occupancy(scenario: str) -> dict:
    r = _result(_check(scenario))
    cap = _capacity()
    p50, p90 = _occupancy_quantiles(scenario)
    p_over = (r.occupancy > cap).mean(axis=0)
    start = datetime.combine(r.days[0], time(0), tzinfo=LA)
    hours = [{"t_local": (start + timedelta(hours=h)).isoformat(timespec="minutes"),
              "p50": round(float(p50[h]), 1), "p90": round(float(p90[h]), 1),
              "p_over_capacity": round(float(p_over[h]), 3)} for h in range(r.occupancy.shape[1])]
    return {"scenario": scenario, "capacity": cap, "runs": r.runs, "model": MODEL_NAME,
            "data_source": io.data_source(), "hours": hours}
