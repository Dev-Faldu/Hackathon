"""Entry points the server's adapters look for (server/rampcast_server/adapters.py)."""
from __future__ import annotations

from rampcast_server.data import generate_sample

from .strategies import strategies
from .whatif import apply_runway_closure

PLAN_SEED = 61   # the planning week every screen shares


def get_strategies(scenario: str, modifiers: dict | None = None) -> dict:
    """POST /plan/strategies: three CP-SAT plans for a scenario, with an optional runway closure applied."""
    modifiers = modifiers or {}
    ds = generate_sample(scenario, seed=PLAN_SEED, demand_multiplier=float(modifiers.get("demand_multiplier", 1.0)))
    if modifiers.get("runway_closed"):
        ds, _ = apply_runway_closure(ds, modifiers["runway_closed"])
    out = strategies(ds)
    out["model"] = "rampcast.engine (OR-Tools CP-SAT)"
    return out
