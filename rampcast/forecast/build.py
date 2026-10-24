"""Precompute every scenario into the disk cache and print a summary.

Run from the repo root:  server/.venv/bin/python -m rampcast.forecast.build
"""
from __future__ import annotations

import time

import numpy as np

from . import data_io as io
from .cache import load_or_simulate
from .uplift import SCENARIOS


def main() -> None:
    cap = float(io.assumptions()["fbo"]["capacity_large_equiv"])
    print(f"data source: {io.data_source()} | capacity: {cap:g} large-cabin equivalents")
    for s in SCENARIOS:
        t0 = time.perf_counter()
        r = load_or_simulate(s, refresh=True)
        p50 = np.percentile(r.occupancy, 50, axis=0)
        p_over = (r.occupancy > cap).mean(axis=0)
        week = np.percentile(r.daily_counts.sum(axis=1), [10, 50, 90])
        print(f"{s:6s} daily p50 {np.percentile(r.daily_counts, 50, axis=0).astype(int).tolist()} "
              f"| week p10/p50/p90 {week.astype(int).tolist()} | peak occupancy p50 {p50.max():.1f} "
              f"| hours with P(over) >= 0.5: {int((p_over >= 0.5).sum())} | {time.perf_counter() - t0:.1f}s")


if __name__ == "__main__":
    main()
