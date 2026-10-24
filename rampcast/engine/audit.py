"""Append-only audit log (logs/audit.jsonl): every proposal the engine makes and every approval, edit and rejection.

Each line has the UTC time, the actor's role, the action, the target and a note. Lines are only ever appended;
nothing here rewrites or deletes the file.
"""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone

from rampcast_server import config as C

ACTIONS = ("propose", "approve", "edit", "reject")
DECISIONS = ("approve", "edit", "reject")
AUDIT_PATH = C.LOG_DIR / "audit.jsonl"
_lock = threading.Lock()
_proposed: set[str] = set()


def append(entry: dict) -> dict:
    if entry["action"] not in ACTIONS:
        raise ValueError(f"action must be one of {ACTIONS}")
    row = {"t_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "actor_role": entry.get("actor_role", "FBO general manager"),
           "action": entry["action"], "target": entry["target"], "note": entry.get("note", ""),
           "replay_t_local": entry.get("replay_t_local")}
    if entry.get("key"):
        row["key"] = entry["key"]
    with _lock:
        C.LOG_DIR.mkdir(exist_ok=True)
        with open(AUDIT_PATH, "a") as f:
            f.write(json.dumps(row) + "\n")
    return row


def entries() -> list[dict]:
    if not AUDIT_PATH.exists():
        return []
    return [json.loads(line) for line in AUDIT_PATH.read_text().splitlines() if line.strip()]


def propose(target: str, note: str, key: str) -> dict | None:
    """Log a proposal once per distinct key (same plan from the same inputs), however often it is shown."""
    if key in _proposed:
        return None
    if not _proposed:
        _proposed.update(e["key"] for e in entries() if e.get("action") == "propose" and e.get("key"))
        if key in _proposed:
            return None
    _proposed.add(key)
    return append({"action": "propose", "target": target, "note": note, "key": key, "actor_role": "RAMPCAST engine"})


def approved_strategy() -> str | None:
    for row in reversed(entries()):
        if row["target"].startswith("strategy:") and row["action"] in ("approve", "edit"):
            return row["target"].split(":", 1)[1]
    return None
