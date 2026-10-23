"""API contract and safeguard tests. Run: cd server && .venv/bin/pytest -q"""
import dataclasses
import os

os.environ["RAMPCAST_DISABLE_CLAUDE"] = "1"

import pytest
from fastapi.testclient import TestClient

from rampcast_server.data import Booking
from rampcast_server.main import app

T = "2027-02-12T13:10:00-08:00"
CLOSURE = {"runway_closed": {"from": "2027-02-12T11:05:00-08:00", "to": "2027-02-12T11:55:00-08:00"}}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_forecast_quantiles_ordered(client):
    for sc in ("low", "medium", "high"):
        days = client.get(f"/forecast?scenario={sc}").json()["days"]
        assert len(days) == 7
        assert all(d["p10"] <= d["p50"] <= d["p90"] for d in days)


def test_scenarios_increase_demand(client):
    peaks = [client.post("/plan/strategies", json={"scenario": sc}).json()["status_quo"]["peak_demand"]
             for sc in ("low", "medium", "high")]
    assert peaks[0] < peaks[1] < peaks[2]


def test_three_distinct_strategies_with_approvers(client):
    s = client.post("/plan/strategies", json={"scenario": "medium"}).json()["strategies"]
    assert [c["id"] for c in s] == ["A", "B", "C"]
    for c in s:
        assert c["approvers"] and c["explanation_facts"]
    assert "FAA" in s[2]["approvers"]
    differing = [k for k in ("co2_t", "overflow_aircraft", "peak_line_staff", "risk")
                 if len({c["kpis"][k] for c in s}) > 1]
    assert len(differing) >= 2


def test_priority_inputs_exclude_identity_and_payment():
    fields = {f.name for f in dataclasses.fields(Booking)}
    banned = {"name", "passenger_name", "status", "tier", "loyalty", "payment", "price", "vip_level"}
    assert not fields & banned


def test_priority_queue_sorted_with_reasons(client):
    q = client.get(f"/priority/queue?t={T}").json()
    scores = [i["score"] for i in q["items"]]
    assert scores == sorted(scores, reverse=True)
    assert all(i["reasons"] for i in q["items"])
    assert all(i["booking_code"].startswith("RC-") for i in q["items"])


def test_whatif_runway_closure_end_to_end(client):
    w = client.post("/whatif", json={"scenario": "medium", "modifiers": CLOSURE}).json()
    assert set(w["kpi_diff"]) == {"A", "B", "C"}
    assert any(a["kind"] == "runway" for a in w["new_alerts"])
    for f in w["affected_flights"]:
        assert f["delay_min"] >= 0
        assert f["decided_by"].startswith("Operator")
        assert f["options"][0]["airport"]
    assert w["explanation"]["text"]


def test_replay_and_afteraction(client):
    r = client.get(f"/replay/state?t={T}").json()
    assert r["capacity"] > 0 and r["paths_interpolated"] is True
    a = client.get("/afteraction?scenario=medium").json()
    assert a["interval_coverage_pct"] is not None and len(a["days"]) == 7


def test_audit_rejects_unknown_action(client):
    assert client.post("/audit", json={"action": "land", "target": "flight:x"}).status_code == 422
