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
    assert q["order"] == ["fixed_time", "medical_access", "hard_deadline", "wait"]  # strict order (tests/test_priority.py)
    assert [i["rank"] for i in q["items"]] == list(range(1, len(q["items"]) + 1))
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


def test_parking_optimized_needs_fewer_tows_than_whiteboard(client):
    opt = client.get("/parking/plan?method=optimized").json()
    assert opt["metrics"]["tows"] < opt["compare"]["tows"]
    assert opt["compare"]["method"] == "first_come"
    ids = {p["id"] for p in opt["positions"]}
    assert {"A1", "D12", "H1"} <= ids
    for row in opt["gantt"]:
        bars = sorted(row["bars"], key=lambda b: b["start"])
        if row["position"] != "OVERFLOW":
            assert all(a["end"] <= b["start"] for a, b in zip(bars, bars[1:])), f"double-booked {row['position']}"


def test_parking_reservations_explain_every_placement(client):
    items = client.get("/parking/reservations?day=2027-02-12").json()["items"]
    assert items and all(i["reasons"] for i in items)


def test_parking_assign_validates_before_pinning(client):
    plan = client.get("/parking/plan").json()
    big = next(b for r in plan["gantt"] if r["position"] != "OVERFLOW" for b in r["bars"] if b["size_class"] == "large")
    small_stand = next(p["id"] for p in plan["positions"] if p["max_wingspan_ft"] == 60)
    r = client.post("/parking/assign", json={"flight_id": big["flight_id"], "position_id": small_stand, "confirm": True}).json()
    assert not r["ok"] and not r["confirmed"] and any("Wingspan" in i for i in r["issues"])


def test_arrival_delay_compresses_the_afternoon(client):
    mods = {"arrival_delay": {"from": "2027-02-12T09:00:00-08:00", "to": "2027-02-12T13:00:00-08:00", "minutes": 180}}
    r = client.post("/whatif", json={"scenario": "medium", "modifiers": mods}).json()
    assert r["affected_flights"] and all(f["delay_min"] == 180 for f in r["affected_flights"])
    assert all(f["decided_by"].startswith("Operator dispatcher") for f in r["affected_flights"])
    b = r["kpi_diff"]["B"]["peak_movements_per_hour"]
    assert b[1] >= b[0]
    assert "[whatif.peak_moves_after]" in r["explanation"]["text"]


def test_offline_answers_cite_facts(client):
    r = client.post("/explain", json={"question": "why is B suggested over C?"}).json()
    assert r["fallback"] is True and "[B.kpis.hours_over_capacity]" in r["text"]
    assert "decides" in r["text"]


def test_la28_profile_differs_from_super_bowl(client):
    r = client.get("/la28?scenario=medium").json()
    assert r["event"]["ceremony_date"] == "2028-07-14"
    assert [d["date"] for d in r["days"]][0] == "2028-07-11" and len(r["hours"]) == 168
    assert all(d["p10"] <= d["p50"] <= d["p90"] for d in r["days"])
    # Long Olympic stays: far more jets still parked when the week ends than after the Super Bowl.
    assert r["la28"]["parked_at_week_end"] > r["super_bowl"]["parked_at_week_end"]
    assert r["week_by_scenario"]["low"] < r["week_by_scenario"]["medium"] < r["week_by_scenario"]["high"]
    assert all(x["approver"] for x in r["recommendations"])


def test_booking_quote_answers_with_position_or_alternatives(client):
    quiet = client.post("/bookings/quote", json={"aircraft_type": "GLF6", "arrive_local": "2027-02-17T10:00",
                                                 "depart_local": "2027-02-18T09:00"}).json()
    assert quiet["decision"] in ("confirmed", "approval") and quiet["position"] is not None
    assert quiet["price_usd"] == 500 and not quiet["event_rates"]          # one night, large cabin, outside the event week
    assert quiet["trip_sheet"]["parking"]["position"] == quiet["position"]["id"]
    peak = client.post("/bookings/quote", json={"size_class": "large", "arrive_local": "2027-02-12T15:00",
                                                "depart_local": "2027-02-15T11:00"}).json()
    if peak["decision"] == "full":
        assert peak["position"] is None and any(a["kind"] == "partner" for a in peak["alternatives"])
    else:
        assert peak["decision"] == "approval"                              # the ramp is over capacity that weekend
    bad = client.post("/bookings/quote", json={"aircraft_type": "XXXX", "arrive_local": "2027-02-12T15:00", "depart_local": "2027-02-12T16:00"})
    assert bad.status_code == 422


def test_booking_quote_flags_customs_and_curfew(client):
    q = client.post("/bookings/quote", json={"size_class": "mid", "international": True, "arrive_local": "2027-02-10T10:00",
                                             "depart_local": "2027-02-10T23:30"}).json()
    failed = {c["label"] for c in q["checks"] if not c["ok"]}
    assert {"Customs", "Noise curfew"} <= failed                          # CBP opens 15:00 on Wednesdays; 23:30 is curfew
    assert q["decision"] != "confirmed"


def test_booking_inbox_counts_add_up(client):
    box = client.get("/bookings/inbox", params={"t": T}).json()
    assert box["auto"] + box["look"] == box["total"] == sum(box["by_channel"].values())
    assert all(i["issues"] for i in box["items"] if i["status"] == "look")
    assert all(i["received_local"] <= T[:16] + "-08:00" for i in box["items"])
    assert sum(box["by_channel"].values()) > 0 and "FlightBridge" in box["by_channel"]


def test_tandem_layout_is_one_plan_for_every_screen(client):
    tandem = client.get("/parking/plan", params={"layout": "tandem"}).json()
    stands = client.get("/parking/plan", params={"layout": "stands"}).json()
    assert tandem["layout"] == "tandem" and len(tandem["positions"]) > len(stands["positions"])
    ids = {p["id"] for p in tandem["positions"]}
    assert {"A1-1", "A1-3", "A2-4", "H6", "P8-5"} <= ids and "A1-4" not in ids   # large columns 3 deep, medium 4 deep
    # Packing wingtip to wingtip takes more jets with fewer tows than a whiteboard on the same slots.
    assert tandem["metrics"]["overflow_aircraft"] <= stands["metrics"]["overflow_aircraft"]
    assert tandem["metrics"]["tows"] < tandem["compare"]["tows"]
    assert all(t["kind"] in ("arrival", "departure") for t in tandem["tows"])
    st = client.get("/parking/state", params={"t": T, "layout": "tandem"}).json()
    assert all(o["position"] in ids for o in st["occupants"] if o["position"])


def test_accepted_booking_joins_the_plan_and_can_be_cancelled(client):
    q = client.post("/bookings/quote", json={"aircraft_type": "CL35", "tail": "N350RC", "arrive_local": "2027-02-10T16:00",
                                             "depart_local": "2027-02-11T10:00", "layout": "tandem"}).json()
    assert q["position"] is not None
    a = client.post("/bookings/accept", json={"trip_sheet": q["trip_sheet"], "layout": "tandem", "channel": "FlightBridge"}).json()
    plan = client.get("/parking/plan", params={"layout": "tandem"}).json()
    where = [g["position"] for g in plan["gantt"] if any(b["flight_id"] == a["flight_id"] for b in g["bars"])]
    assert where == [q["position"]["id"]] and a["flight_id"] in plan["booked"]
    box = client.get("/bookings/inbox", params={"t": "2027-02-10T12:00", "layout": "tandem"}).json()
    assert any(i.get("booked") and i["flight"] == a["flight_id"] for i in box["items"])
    assert client.delete(f"/bookings/accepted/{a['flight_id']}").json()["ok"]
    assert a["flight_id"] not in client.get("/parking/plan", params={"layout": "tandem"}).json()["booked"]
    full = client.post("/bookings/accept", json={"trip_sheet": {"parking": {"position": None}}, "layout": "tandem"})
    assert full.status_code == 409


def test_build_replay_feeds_the_loader(tmp_path, monkeypatch):
    """Raw OpenSky CSVs -> replay_2027.jsonl -> load_processed, without network."""
    import csv as _csv
    import importlib.util
    from datetime import datetime, timezone
    from rampcast_server import config as C
    from rampcast_server.data import load_processed

    spec = importlib.util.spec_from_file_location("build_replay", C.ROOT / "data" / "scripts" / "build_replay.py")
    br = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(br)
    raw = tmp_path / "raw"
    (raw / "opensky").mkdir(parents=True)
    ts = lambda s: int(datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp())
    head = ["tail_hash", "icao24", "callsign", "dep", "arr", "first_seen", "last_seen"]
    with open(raw / "opensky" / "KVNY_arrival_2022-02-11.csv", "w", newline="") as f:
        w = _csv.writer(f); w.writerow(head)
        w.writerow(["aaa", "a1b2c3", "N1", "KTEB", "KVNY", ts("2022-02-11T14:00"), ts("2022-02-11T19:30")])
        w.writerow(["bbb", "d4e5f6", "C-GXYZ", "CYYZ", "KVNY", ts("2022-02-11T15:00"), ts("2022-02-11T20:10")])
    with open(raw / "opensky" / "KVNY_departure_2022-02-14.csv", "w", newline="") as f:
        w = _csv.writer(f); w.writerow(head)
        w.writerow(["aaa", "a1b2c3", "N1", "KVNY", "KTEB", ts("2022-02-14T18:00"), ts("2022-02-14T23:00")])
    with open(raw / "icao24_aircraft.csv", "w", newline="") as f:
        w = _csv.writer(f); w.writerow(["icao24", "manufacturer", "model", "seats", "size_class"])
        w.writerow(["a1b2c3", "GULFSTREAM", "G650", "16", "large"])
    out = tmp_path / "processed" / "replay_2027.jsonl"
    assert br.build(str(raw), str(out)) == 2
    monkeypatch.setattr(C, "PROCESSED", out.parent)
    base = C.assumptions()
    monkeypatch.setattr(C, "assumptions", lambda: {**base, "fbo": {**base["fbo"], "share_of_airport_arrivals": 1.0}})
    ds = load_processed()
    assert ds and ds.source == "opensky_2022_shifted" and len(ds.flights) == 2
    g = next(f for f in ds.flights if f.size_class == "large")
    assert g.landed.date().isoformat() == "2027-02-12" and g.departed_vny.date().isoformat() == "2027-02-15"
    assert next(f for f in ds.flights if f.origin == "CYYZ").is_international


@pytest.mark.parametrize("mods", [
    {"customs_hours": {"fri": ["09:00", "25:99"]}},
    {"customs_hours": {"friday": ["09:00", "14:30"]}},
    {"customs_hours": {"fri": ["14:30", "09:00"]}},
    {"runway_closed": {"from": "2027-02-12T14:00:00-08:00", "to": "2027-02-12T10:00:00-08:00"}},
    {"runway_closed": {"from": "2031-01-01T10:00:00-08:00", "to": "2031-01-01T11:00:00-08:00"}},
    {"runway_closed": {"from": "not a time", "to": "2027-02-12T11:00:00-08:00"}},
    {"demand_multiplier": 50},
    {"diversions": {"VNY-0001": "burbank"}},
])
def test_whatif_rejects_bad_modifiers(client, mods):
    r = client.post("/whatif", json={"scenario": "medium", "modifiers": mods})
    assert r.status_code == 422, r.text


def test_bad_replay_time_is_a_422(client):
    assert client.get("/alerts?t=yesterday").status_code == 422
    assert client.get("/priority/queue?t=2027-13-40T99:00").status_code == 422


def test_whatif_reports_the_stand_replan(client):
    r = client.post("/whatif", json={"scenario": "medium", "modifiers": CLOSURE}).json()
    assert r["stand_plan"]["boxed_in"] == 0


URGENCY_RANK = {"now": 0, "today": 1, "this week": 2}


def test_ai_copilot_suggestions_cite_models_numbers_and_approvers(client):
    recs = client.get("/ai/recommendations?layout=tandem&t=2027-02-12T13:10:00-08:00").json()
    model_ids = {m["id"] for m in client.get("/ai/models?layout=tandem").json()["models"]}
    assert recs["items"], "the busy Friday afternoon should need something"
    for it in recs["items"]:
        assert it["why"] and it["approver"] and it["models"]
        assert set(it["models"]) <= model_ids
    ranks = [URGENCY_RANK[it["urgency"]] for it in recs["items"]]
    assert ranks == sorted(ranks)
    assert recs["counts"]["now"] == sum(1 for it in recs["items"] if it["urgency"] == "now")


def test_ai_model_cards_are_complete_and_label_their_inputs(client):
    d = client.get("/ai/models").json()
    assert len(d["models"]) >= 10
    for m in d["models"]:
        assert m["question"] and m["method"] and m["outputs"] and m["limits"] and m["code"]
        assert {i["label"] for i in m["inputs"]} <= {"published", "reconstructed", "assumption", "live"}
    fc = next(m for m in d["models"] if m["id"] == "forecast")
    assert fc["evidence"] and fc["status"] == "live"
    assert any(r["check"] == "leave_one_event_out" for r in d["validation"])


def test_benchmark_runs_three_parking_methods_on_one_week(client):
    b = client.get("/ai/benchmark?layout=tandem").json()
    rows = {r["method"]: r for r in b["rows"]}
    assert list(rows) == ["first_come", "optimized", "cpsat"]
    assert rows["optimized"]["tows"] < rows["first_come"]["tows"]
    assert rows["cpsat"]["tows"] < rows["first_come"]["tows"]
    assert b["best"] in ("optimized", "cpsat")


def test_exact_solver_never_double_books_a_slot(client):
    plan = client.get("/parking/plan?method=cpsat&layout=tandem").json()
    assert plan["metrics"]["solver"].startswith("cp-sat")
    for row in plan["gantt"]:
        if row["position"] != "OVERFLOW":
            bars = sorted(row["bars"], key=lambda b: b["start"])
            assert all(a["end"] <= b["start"] for a, b in zip(bars, bars[1:])), f"double-booked {row['position']}"


def test_afteraction_reports_the_out_of_sample_check(client):
    d = client.get("/afteraction").json()
    assert d["out_of_sample"]["model_pct"] < d["out_of_sample"]["naive_pct"]
