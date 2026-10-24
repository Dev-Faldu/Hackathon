"""Compatibility shim: the decision engine lives in the repo-root package rampcast/engine/.

Server modules keep calling `engine.<name>`; each name below comes from the module that owns it.
"""
from rampcast.engine.alerts import alerts  # noqa: F401
from rampcast.engine.alternates import alternates  # noqa: F401
from rampcast.engine.common import (  # noqa: F401
    A, as_drop_and_go, capacity, customs_close, drive_minutes, eta_band_min, movements_hourly, occupancy_hourly, staff,
)
from rampcast.engine.priority import priority_queue  # noqa: F401
from rampcast.engine.strategies import strategies  # noqa: F401
from rampcast.engine.whatif import apply_arrival_delay, apply_runway_closure  # noqa: F401
