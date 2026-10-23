"""Swap in the team's trained modules when they exist, keep the reference engine otherwise.

A module plugs in by exposing these functions (all return contract-shaped dicts):
  rampcast.forecast.api:  get_forecast(scenario) and get_occupancy(scenario)
  rampcast.engine.api:    get_strategies(scenario, modifiers)
If an import or a call fails, the reference implementation answers and the response says so.
"""
from __future__ import annotations

import importlib
import logging
import sys

from . import config as C

log = logging.getLogger("rampcast.adapters")
if str(C.ROOT) not in sys.path:
    sys.path.insert(0, str(C.ROOT))


def _load(module: str, fn: str):
    try:
        return getattr(importlib.import_module(module), fn)
    except Exception:
        return None


def call(module: str, fn: str, fallback, *args):
    impl = _load(module, fn)
    if impl is not None:
        try:
            out = impl(*args)
            out.setdefault("model", module)
            return out
        except Exception as e:
            log.warning("%s.%s failed (%s); using reference", module, fn, e)
    return fallback(*args)


def status() -> dict:
    return {"forecast": _load("rampcast.forecast.api", "get_forecast") is not None,
            "occupancy": _load("rampcast.forecast.api", "get_occupancy") is not None,
            "strategies": _load("rampcast.engine.api", "get_strategies") is not None}
