"""Manager settings. The append-only audit log lives in rampcast/engine/audit.py."""
from __future__ import annotations

import json
import threading

from rampcast.engine import audit

from . import config as C

_lock = threading.Lock()
SETTINGS_PATH = C.LOG_DIR / "settings.json"


def default_settings() -> dict:
    a = C.assumptions()
    return {
        "event": a["event"]["name"],
        "game_date": a["event"]["game_date"],
        "airport": a["fbo"]["airport"],
        "fbo_name": a["fbo"]["name"],
        "capacity": a["fbo"]["capacity_large_equiv"],
        "staff_on_shift": a["fbo"]["staff_on_shift"],
        "fuel_trucks": a["fbo"]["fuel_trucks"],
        "weights": dict(a["priority_weights_default"]),
    }


def get_settings() -> dict:
    s = default_settings()
    if SETTINGS_PATH.exists():
        s.update(json.loads(SETTINGS_PATH.read_text()))
    return s


def put_settings(patch: dict) -> dict:
    allowed = {"capacity", "staff_on_shift", "fuel_trucks", "weights"}
    with _lock:
        s = get_settings()
        for k, v in patch.items():
            if k in allowed:
                s[k] = v
        C.LOG_DIR.mkdir(exist_ok=True)
        SETTINGS_PATH.write_text(json.dumps({k: s[k] for k in allowed}, indent=2))
    return s


def audit_append(entry: dict) -> dict:
    return audit.append(entry)


def audit_list() -> list[dict]:
    return audit.entries()


def approved_strategy() -> str | None:
    return audit.approved_strategy()
