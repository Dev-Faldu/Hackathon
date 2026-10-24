"""Manager settings and the append-only audit log."""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone

from . import config as C

_lock = threading.Lock()
SETTINGS_PATH = C.LOG_DIR / "settings.json"
AUDIT_PATH = C.LOG_DIR / "audit.jsonl"


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
    row = {"t_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "actor_role": entry.get("actor_role", "FBO general manager"),
           "action": entry["action"], "target": entry["target"], "note": entry.get("note", ""),
           "replay_t_local": entry.get("replay_t_local")}
    with _lock:
        C.LOG_DIR.mkdir(exist_ok=True)
        with open(AUDIT_PATH, "a") as f:
            f.write(json.dumps(row) + "\n")
    return row


def audit_list() -> list[dict]:
    if not AUDIT_PATH.exists():
        return []
    return [json.loads(line) for line in AUDIT_PATH.read_text().splitlines() if line.strip()]


def approved_strategy() -> str | None:
    for row in reversed(audit_list()):
        if row["target"].startswith("strategy:") and row["action"] in ("approve", "edit"):
            return row["target"].split(":", 1)[1]
    return None
