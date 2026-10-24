"""Disk cache for simulation results, keyed by the assumptions, the data files and this package's code."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

from . import data_io as io
from .ramp_sim import SimResult, simulate, window_days

PKG = Path(__file__).resolve().parent
CACHE_DIR = PKG / ".cache"


def cache_key() -> str:
    a = io.assumptions()
    h = hashlib.sha256()
    h.update(json.dumps({k: a.get(k) for k in ("event", "fbo", "large_equiv_factor", "tfr_game_day", "forecast")},
                        sort_keys=True, default=str).encode())
    for name in ("daily_counts.csv", "flights.parquet"):
        f = io.PROCESSED / name
        h.update(f"{name}:{f.stat().st_size if f.exists() else 0}".encode())
        if f.exists():
            h.update(hashlib.sha256(f.read_bytes()).digest())
    for src in sorted(PKG.glob("*.py")):
        h.update(src.read_bytes())
    return h.hexdigest()[:16]


def load_or_simulate(scenario: str, refresh: bool = False) -> SimResult:
    path = CACHE_DIR / f"{scenario}-{cache_key()}.npz"
    if path.exists() and not refresh:
        z = np.load(path)
        return SimResult(scenario, window_days(), z["baseline_fbo"], z["expected_fbo"], z["multiplier"],
                         z["daily_counts"], z["occupancy"], int(z["runs"]), int(z["seed"]),
                         z["aircraft"] if "aircraft" in z.files else None)
    r = simulate(scenario)
    try:
        CACHE_DIR.mkdir(exist_ok=True)
        np.savez_compressed(path, baseline_fbo=r.baseline_fbo, expected_fbo=r.expected_fbo, multiplier=r.multiplier,
                            daily_counts=r.daily_counts, occupancy=r.occupancy, aircraft=r.aircraft,
                            runs=r.runs, seed=r.seed)
    except OSError:
        pass  # a read-only checkout still works, just without the disk cache
    return r
