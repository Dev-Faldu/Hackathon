"""Precomputed answers for the slow routes, so a fresh start answers in milliseconds.

The forecast's Monte Carlo, the three strategies, LA28, the exact-solver plans and the co-pilot's model cards take
seconds to minutes to compute on a laptop, and they only change when the data, the assumptions or the code change.
So they are computed once and saved in server/snapshot/<key>.json.gz, where <key> is a fingerprint of every input:
data/processed, contracts/assumptions.yaml, reports/*.csv and the Python code (line endings normalised, so a
Windows checkout matches). The repo ships a snapshot for its own code; `make snapshot` rebuilds it after a change,
and a server whose fingerprint has no snapshot computes once and saves one.

Answers that depend on what a person changed (settings, a moved jet, an accepted booking) are served from the
snapshot only while that state is still the default; after a change the live engine answers, as before.
"""
from __future__ import annotations

import copy
import gzip
import hashlib
import json
import logging
import os
import threading
from pathlib import Path

from . import config as C

log = logging.getLogger("rampcast.snapshot")
DIR = C.ROOT / "server" / "snapshot"
_FORMAT = 1

_data: dict[str, object] = {}
_lock = threading.Lock()
_loaded_key: str | None = None
_dirty = False


def enabled() -> bool:
    return not os.environ.get("RAMPCAST_NO_SNAPSHOT")  # tests set it, to exercise the live engine


def _inputs() -> list[Path]:
    root = C.ROOT
    files = [p for p in (root / "data" / "processed").glob("*")
             if p.is_file() and p.suffix in (".csv", ".parquet", ".json", ".jsonl")]  # not desktop.ini, .DS_Store
    files += [root / "contracts" / "assumptions.yaml"]
    files += list((root / "reports").glob("*.csv"))
    for pkg in (root / "server" / "rampcast_server", root / "rampcast"):
        files += [p for p in pkg.rglob("*.py") if "tests" not in p.parts]
    return sorted(f for f in files if f.exists())


def key() -> str:
    h = hashlib.sha256(f"format {_FORMAT}".encode())
    for f in _inputs():
        h.update(f.relative_to(C.ROOT).as_posix().encode())
        h.update(f.read_bytes().replace(b"\r\n", b"\n"))
    return h.hexdigest()[:16]


def path(k: str | None = None) -> Path:
    return DIR / f"{k or key()}.json.gz"


def load() -> bool:
    """Read the snapshot for the current inputs, if there is one. Returns whether it was found."""
    global _loaded_key
    if not enabled():
        return False
    k = key()
    _loaded_key = k
    p = path(k)
    if not p.exists():
        log.info("no snapshot for inputs %s; the server computes once and saves one", k)
        return False
    try:
        with gzip.open(p, "rt", encoding="utf-8") as f:
            payload = json.load(f)
        with _lock:
            _data.clear()
            _data.update(payload.get("entries", {}))
        log.info("loaded snapshot %s (%d answers)", k, len(_data))
        return True
    except (OSError, ValueError) as e:
        log.warning("snapshot %s unreadable (%s); computing instead", p, e)
        return False


def get(name: str):
    if not enabled():
        return None
    with _lock:
        if name not in _data:
            return None
        return copy.deepcopy(_data[name])


def put(name: str, value) -> None:
    """Remember an answer computed in the default state, for the next save."""
    global _dirty
    if not enabled():
        return
    try:
        json.dumps(value)
    except (TypeError, ValueError):
        return  # not plain JSON: never snapshot it
    with _lock:
        if name not in _data:
            _data[name] = copy.deepcopy(value)
            _dirty = True


def save(force: bool = False) -> Path | None:
    """Write the snapshot for the current inputs (only if something new was computed)."""
    global _dirty
    if not enabled() or not (_dirty or force):
        return None
    k = _loaded_key or key()
    DIR.mkdir(parents=True, exist_ok=True)
    with _lock:
        payload = {"format": _FORMAT, "key": k, "entries": _data}
        tmp = path(k).with_suffix(".tmp")
        with gzip.open(tmp, "wt", encoding="utf-8") as f:
            json.dump(payload, f, separators=(",", ":"))
        tmp.replace(path(k))
        _dirty = False
    for old in DIR.glob("*.json.gz"):  # one snapshot per checkout: drop the ones for older inputs
        if old.name != path(k).name:
            try:
                old.unlink()
            except OSError:
                pass
    log.info("saved snapshot %s (%d answers)", k, len(_data))
    return path(k)


if __name__ == "__main__":  # python -m rampcast_server.snapshot : rebuild the shipped snapshot
    import logging as _l
    _l.basicConfig(level=_l.INFO)
    from . import main
    main.build_snapshot()
