"""Shared test setup: no Claude calls, a short solver budget, and an audit log in a temp folder."""
import os

os.environ["RAMPCAST_DISABLE_CLAUDE"] = "1"
os.environ.setdefault("RAMPCAST_DISABLE_LOCAL_LLM", "1")
os.environ.setdefault("RAMPCAST_STANDS_DET_TIME", "0.3")

import pytest  # noqa: E402

from rampcast.engine import audit  # noqa: E402


@pytest.fixture(autouse=True, scope="session")
def _temp_audit_log(tmp_path_factory):
    path = tmp_path_factory.mktemp("logs") / "audit.jsonl"
    original = audit.AUDIT_PATH
    audit.AUDIT_PATH = path
    audit._proposed.clear()
    yield path
    audit.AUDIT_PATH = original
