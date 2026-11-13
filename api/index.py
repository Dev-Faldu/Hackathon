"""Vercel entry point: the RAMPCAST FastAPI server as one Python function behind /api.

The React app in app/ is built to app/dist and served as static files; every /api/* request is rewritten here
(vercel.json). The function answers from the precomputed snapshot in server/snapshot, so a cold instance replies
in milliseconds once Python has started. Only /tmp is writable on Vercel, so the audit log and settings go there.
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("RAMPCAST_SERVERLESS", "1")
os.environ.setdefault("RAMPCAST_LOG_DIR", "/tmp/rampcast-logs")
for p in (ROOT, ROOT / "server"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from rampcast_server.main import app, serverless_boot  # noqa: E402

serverless_boot()  # also run here: the platform may not send ASGI lifespan events

__all__ = ["app"]
