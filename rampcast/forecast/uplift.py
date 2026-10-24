"""M2 event uplift: arrival multiplier by day offset from game day, for low, medium and high demand.

Level: published WingX ratios (forecast.analogs, use: level), all describing roughly the Thu..Sun before the game.
Scenarios come from the spread across analogs (min / mean / max). Shape: the day-to-day pattern of Role 1's rebuilt
2022 KVNY week, scaled so its Thu..Sun mean equals the scenario level. The Monday after the game keeps the same
multiplier in every scenario (scenarios differ in the departure wave, not in Monday arrivals).
"""
from __future__ import annotations

import numpy as np

from . import data_io as io
from .baseline import Baseline, fit_baseline

SCENARIOS = ("low", "medium", "high")


def offsets() -> list[int]:
    lo, hi = io.forecast_params()["window_offsets"]
    return list(range(int(lo), int(hi) + 1))


def event_shape(baseline: Baseline | None = None, event: str = "SB_LVI_2022") -> dict[int, float]:
    """Event-day arrivals divided by the ordinary mean for the same weekday, per day offset."""
    p = io.forecast_params()
    b = baseline or fit_baseline()
    df = io.load_daily_counts(p["airport"])
    rows = df[(df["event_name"] == event) & df["arrivals"].notna()]
    shape = {int(r.day_offset): float(r.arrivals) / b.airport_by_weekday[r.date_local.weekday()]
             for r in rows.itertuples() if int(r.day_offset) in offsets()}
    missing = sorted(set(offsets()) - set(shape))
    if missing:
        raise ValueError(f"event shape is missing day offsets {missing}")
    return shape


def scenario_levels(exclude_event: str | None = None) -> dict[str, float]:
    """Thu..Sun arrival multiplier per scenario from the published analogs, optionally leaving one event out."""
    a = io.load_analogs(exclude_event)
    levels = a[(a["use"] == "level") & (a["metric"] == "arrivals_ratio")]["value"].astype(float)
    if levels.empty:
        raise ValueError("no published arrival ratios left to set the scenario levels")
    agg = {"min": float(levels.min()), "mean": float(levels.mean()), "max": float(levels.max())}
    rule = io.forecast_params()["uplift"]["scenario_rule"]
    return {s: agg[rule[s]] for s in SCENARIOS}


def curve(level: float, shape: dict[int, float]) -> dict[int, float]:
    """Scale the shape's excess over 1 so the anchor-window mean equals `level`."""
    u = io.forecast_params()["uplift"]
    lo, hi = u["anchor_offsets"]
    anchor_mean = float(np.mean([shape[d] for d in range(int(lo), int(hi) + 1)]))
    if anchor_mean <= 1.0:
        raise ValueError("the event shape has no uplift in the anchor window")
    k = (level - 1.0) / (anchor_mean - 1.0)
    fixed = {int(d) for d in u["fixed_offsets"]}
    return {d: (r if d in fixed else max(0.0, 1.0 + (r - 1.0) * k)) for d, r in sorted(shape.items())}


def scenario_curves(exclude_event: str | None = None, baseline: Baseline | None = None) -> dict[str, dict[int, float]]:
    shape = event_shape(baseline)
    levels = scenario_levels(exclude_event)
    return {s: curve(levels[s], shape) for s in SCENARIOS}
