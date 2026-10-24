"""Make the repo root (rampcast) and server/ (rampcast_server) importable; never call Claude in tests."""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
os.environ.setdefault("RAMPCAST_DISABLE_CLAUDE", "1")
for p in (ROOT, ROOT / "server"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))
