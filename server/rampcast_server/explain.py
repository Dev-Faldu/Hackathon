"""Compatibility shim: the explanation layer (Claude, a local LLM, or the built-in writer) lives in
rampcast/engine/explain.py."""
from rampcast.engine.explain import *  # noqa: F401,F403
from rampcast.engine.explain import (  # noqa: F401
    MODEL, SYSTEM, _call_local_llm, _normalize_local_url, claude_available, explain, get_local_model_name, httpx,
    local_llm_available, template,
)
