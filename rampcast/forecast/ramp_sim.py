"""M3 ramp simulator: Monte Carlo of hourly occupancy at our FBO, in large-cabin equivalents.

One run is one plausible week. Per run: a week-wide demand factor, daily arrival counts (negative binomial around
baseline x uplift), an arrival hour from the event-week profile (damped during the game-day TFR), a size class,
and a stay: drop-and-go (55-120 min), stay through the game (leave Sunday night or Monday), or an ordinary
1-2 night visit. Aircraft already parked when the window opens are added. Occupancy is counted at the middle of
each hour. Every parameter comes from contracts/assumptions.yaml.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

import numpy as np

from . import data_io as io
from .baseline import Baseline, fit_baseline
from .uplift import SCENARIOS, scenario_curves


def window_days() -> list[date]:
    start, end = (date.fromisoformat(x) for x in io.assumptions()["event"]["window"])
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


def game_date() -> date:
    return date.fromisoformat(io.assumptions()["event"]["game_date"])


@dataclass
class SimResult:
    scenario: str
    days: list[date]
    baseline_fbo: np.ndarray    # (days,) expected ordinary-week arrivals at our FBO
    expected_fbo: np.ndarray    # (days,) expected scenario arrivals at our FBO
    multiplier: np.ndarray      # (days,) event multiplier used
    daily_counts: np.ndarray    # (runs, days) simulated arrivals at our FBO
    occupancy: np.ndarray       # (runs, hours) large-cabin equivalents at the middle of each hour
    runs: int
    seed: int
    aircraft: np.ndarray | None = None  # (runs, hours) aircraft on the ramp at the middle of each hour


def _game_day_profile(profile: np.ndarray) -> np.ndarray:
    a = io.assumptions()
    start, end = a["tfr_game_day"]["window_local"]
    h0, h1 = int(start[:2]), int(end[:2])
    out = profile.copy()
    out[h0:h1 + 1] *= float(io.forecast_params()["game_day_arrival_damping"])
    return out / out.sum()


def simulate(scenario: str, runs: int | None = None, seed: int | None = None,
             baseline: Baseline | None = None, curves: dict[str, dict[int, float]] | None = None) -> SimResult:
    if scenario not in SCENARIOS:
        raise ValueError(f"scenario must be one of {SCENARIOS}")
    a, p = io.assumptions(), io.forecast_params()
    st = p["stays"]
    runs = int(runs or p["monte_carlo_runs"])
    seed = int(p["seed"] if seed is None else seed)
    rng = np.random.default_rng([seed, SCENARIOS.index(scenario)])
    b = baseline or fit_baseline()
    mult_by_offset = (curves or scenario_curves(baseline=b))[scenario]

    days = window_days()
    offs = np.array([(d - game_date()).days for d in days])
    n_days, n_hours = len(days), 24 * len(days)
    base = np.array([b.fbo_mean(d) for d in days])
    mult = np.array([mult_by_offset[int(o)] for o in offs])
    mu = base * mult

    # 1. Daily arrivals: week-wide factor x negative binomial noise (variance = dispersion x mean).
    week = rng.lognormal(0.0, float(p["week_level_sd"]), size=runs)
    lam = mu[None, :] * week[:, None]
    phi = float(p["count_dispersion"])
    if phi > 1.0:
        shape_n = lam / (phi - 1.0)
        counts = rng.negative_binomial(shape_n, shape_n / (shape_n + lam))
    else:
        counts = rng.poisson(lam)

    # 2. One row per arriving aircraft (ordered run by run, day by day).
    run_idx = np.repeat(np.arange(runs), counts.sum(axis=1))
    day_idx = np.repeat(np.tile(np.arange(n_days), runs), counts.ravel())
    m = len(day_idx)
    off_arr = offs[day_idx]

    profile = io.arrival_hour_profile()
    u = rng.random(m)
    hour = np.where(off_arr == 0,
                    np.searchsorted(np.cumsum(_game_day_profile(profile)), u, side="right"),
                    np.searchsorted(np.cumsum(profile), u, side="right"))
    t_arr = day_idx * 24.0 + np.minimum(hour, 23) + rng.random(m)

    mix = io.size_mix()
    probs = np.array(list(mix.values()))
    probs = probs / probs.sum()
    footprint_by_class = np.array([float(a["large_equiv_factor"][c]) for c in mix])
    footprint = footprint_by_class[rng.choice(len(probs), m, p=probs)]

    # 3. Stays.
    t_dep = np.empty(m)
    dg = rng.random(m) < float(st["drop_and_go_share"])
    dg_lo, dg_hi = st["drop_and_go_minutes"]
    t_dep[dg] = t_arr[dg] + rng.uniform(dg_lo, dg_hi, int(dg.sum())) / 60.0

    game_i = int(np.where(offs == 0)[0][0])
    through = ~dg & (off_arr >= int(st["stay_through_game_from_offset"])) & (off_arr <= 0)
    after_lo, after_hi = st["after_game_hours"]
    mon_lo, mon_hi = st["monday_departure_hours"]
    leave_after = rng.random(m) < float(st["leave_after_game_share"])
    t_through = np.where(leave_after,
                         game_i * 24.0 + rng.uniform(after_lo, after_hi, m),
                         (game_i + 1) * 24.0 + rng.uniform(mon_lo, mon_hi, m))
    t_dep[through] = t_through[through]

    ordinary = ~dg & ~through
    n_lo, n_hi = st["ordinary_nights"]
    dh_lo, dh_hi = st["ordinary_departure_hours"]
    nights = rng.integers(int(n_lo), int(n_hi) + 1, m)
    t_ord = (day_idx + nights) * 24.0 + rng.uniform(dh_lo, dh_hi, m)
    t_dep[ordinary] = t_ord[ordinary]
    t_dep = np.maximum(t_dep, t_arr + 50.0 / 60.0)

    # 4. Aircraft already on the ramp when the window opens.
    n_pre = int(p["pre_window_aircraft"])
    pre_run = np.repeat(np.arange(runs), n_pre)
    pre_fp = footprint_by_class[rng.choice(len(probs), runs * n_pre, p=probs)]
    d_lo, d_hi = p["pre_window_departure_days"]
    pre_dep = rng.integers(int(d_lo), int(d_hi) + 1, runs * n_pre) * 24.0 + rng.uniform(dh_lo, dh_hi, runs * n_pre)

    # 5. Occupancy at the middle of each hour h (h + 0.5), via +footprint at arrival and -footprint at departure.
    all_run = np.concatenate([run_idx, pre_run])
    all_arr = np.concatenate([t_arr, np.full(runs * n_pre, -1.0)])
    all_dep = np.concatenate([t_dep, pre_dep])
    all_fp = np.concatenate([footprint, pre_fp])
    first = np.clip(np.ceil(all_arr - 0.5), 0, n_hours).astype(np.int64)
    stop = np.clip(np.ceil(all_dep - 0.5), 0, n_hours).astype(np.int64)
    keep = first < stop
    width = n_hours + 1
    size = runs * width
    idx_in = all_run[keep] * width + first[keep]
    idx_out = all_run[keep] * width + stop[keep]
    delta = (np.bincount(idx_in, weights=all_fp[keep], minlength=size)
             - np.bincount(idx_out, weights=all_fp[keep], minlength=size))
    occupancy = np.round(np.cumsum(delta.reshape(runs, width), axis=1)[:, :n_hours], 6).astype(np.float32)
    # Same count in aircraft (each jet = 1), for comparison with FBO reports given in aircraft.
    count_delta = np.bincount(idx_in, minlength=size) - np.bincount(idx_out, minlength=size)
    aircraft = np.cumsum(count_delta.reshape(runs, width), axis=1)[:, :n_hours].astype(np.int16)

    return SimResult(scenario, days, base, mu, mult, counts.astype(np.int32), occupancy, runs, seed, aircraft)
