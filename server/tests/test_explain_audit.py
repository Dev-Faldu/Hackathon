"""Claude layer and audit log."""
import pytest

from rampcast.engine import audit, explain
from rampcast.engine.models import AuditRow, Explanation


def test_claude_layer_uses_the_spec_model_and_falls_back_offline():
    assert explain.MODEL == "claude-sonnet-5-5"
    assert "ONLY" in explain.SYSTEM.upper() and "approv" in explain.SYSTEM.lower()
    facts = {"facts": [{"id": "B.kpis.co2_t", "value": 25.0, "text": "strategy B co2_t"}], "recommended": "B"}
    out = explain.explain("briefing", facts, "test:briefing")
    Explanation.model_validate(out)
    assert out["fallback"] is True and out["model"] == "template"


def test_audit_log_is_append_only_and_logs_proposals_once():
    n = len(audit.entries())
    audit.append({"action": "approve", "target": "strategy:B", "actor_role": "FBO general manager"})
    assert audit.propose("strategy:A", "A: 24 overflow", key="unit:A") is not None
    assert audit.propose("strategy:A", "A: 24 overflow", key="unit:A") is None
    rows = audit.entries()
    assert len(rows) == n + 2
    for r in rows:
        AuditRow.model_validate(r)
    assert audit.approved_strategy() == "B"


def test_audit_rejects_unknown_actions():
    with pytest.raises(ValueError):
        audit.append({"action": "delete", "target": "strategy:A"})
