"""Alerts engine: ramp, customs, per-aircraft curfew and car-at-the-wrong-airport rules."""
from datetime import timedelta

from rampcast.engine.alerts import alerts
from rampcast.engine.models import AlertsResponse
from rampcast_server.data import generate_sample

from factory import at, booking, dataset, flight


def _kinds(out):
    AlertsResponse.model_validate(out)
    return [a["kind"] for a in out["alerts"]]


def test_curfew_alert_only_for_aircraft_the_rule_binds():
    t = at(3, 18)
    flagged = flight("STG2", at(3, 9), at(3, 22, 40), curfew="stage2_jets")
    quiet = flight("QUIET", at(3, 9), at(3, 22, 50), curfew="")
    out = alerts(dataset([flagged, quiet]), t)
    curfew = [a for a in out["alerts"] if a["kind"] == "curfew"]
    assert [a["flight_id"] for a in curfew] == ["STG2"]
    assert "Stage 2" in curfew[0]["message"]


def test_older_stage3_rule_starts_at_23():
    t = at(3, 18)
    f = flight("OLD3", at(3, 9), at(3, 22, 30), curfew="older_stage3_jets")
    assert "curfew" not in _kinds(alerts(dataset([f]), t))   # 22:30 is before its 23:00 curfew


def test_car_alert_when_jet_diverts_away_from_its_car():
    t = at(3, 12)
    f = flight("DIV", t + timedelta(hours=1), t + timedelta(hours=30), booking="RC-DIVT")
    ds = dataset([f], [booking("RC-DIVT", "DIV", car_at="KVNY")])
    out = alerts(ds, t, {"diversions": {"DIV": "KBUR"}})
    car = [a for a in out["alerts"] if a["kind"] == "car_wrong_airport"]
    assert car and "KBUR" in car[0]["message"] and car[0]["owner_role"] == "Ground dispatcher"


def test_no_car_alert_when_the_car_is_already_there():
    t = at(3, 12)
    f = flight("DIV", t + timedelta(hours=1), t + timedelta(hours=30), booking="RC-DIVT")
    ds = dataset([f], [booking("RC-DIVT", "DIV", car_at="KBUR")])
    assert "car_wrong_airport" not in _kinds(alerts(ds, t, {"diversions": {"DIV": "KBUR"}}))


def test_late_departure_at_origin_is_not_a_diversion():
    t = at(3, 12)
    f = flight("LATE", t + timedelta(hours=2), t + timedelta(hours=30), booking="RC-LATE")
    ds = dataset([f], [booking("RC-LATE", "LATE")])
    late = {"flight_id": "LATE", "delay_min": 180, "cause": "arrival_delay",
            "options": [{"airport": "KBUR", "score": 20}, {"airport": "KVNY", "score": 180}]}
    closed = {**late, "cause": "runway_closure"}
    assert "car_wrong_airport" not in _kinds(alerts(ds, t, {"affected_flights": [late]}))
    assert "car_wrong_airport" in _kinds(alerts(ds, t, {"affected_flights": [closed]}))


def test_customs_and_ramp_rules_on_a_busy_week():
    ds = generate_sample("high", seed=61)
    kinds = set()
    for day in range(1, 6):
        for hh in (8, 11, 13):
            kinds |= set(_kinds(alerts(ds, at(day, hh))))
    assert "ramp_capacity" in kinds
