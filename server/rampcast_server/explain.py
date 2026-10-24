"""Compatibility shim: the Claude layer lives in rampcast/engine/explain.py."""
from rampcast.engine.explain import *  # noqa: F401,F403
from rampcast.engine.explain import MODEL, SYSTEM, claude_available, explain, template  # noqa: F401
