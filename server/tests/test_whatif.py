"""What-if engine: modifiers re-run strategies, alerts and the priority queue, end to end, in under 5 s."""
import time

from rampcast.engine import whatif
from rampcast_server.data import generate_sample

WEIGHTS = {"fixed_time": 0.4, "medical_access": 0.3, "hard_deadline": 0.2, "wait": 0.1}
CLOSED = {"from": "2027-02-12T13:05:00-08:00", "to": "2027-02-12T13:55:00-08:00"}


def _base():
    return generate_sample("medium", seed=61)


def test_runway_closure_reruns_everything_fast():
    base = _base()
    t0 = time.time()
    out = whatif.run(base, base, {"runway_closed": CLOSED}, WEIGHTS)
    assert time.time() - t0 < 5
    assert out["affected_flights"] and all(x["options"] for x in out["affected_flights"])
    assert {"kpi_diff", "new_alerts", "strategies", "queue", "queue_changes"} <= set(out)
    assert any(a["kind"] == "runway" for a in out["new_alerts"])


def test_demand_up_means_more_hours_over_capacity():
    out = whatif.run(_base(), generate_sample("medium", seed=61, demand_multiplier=1.2), {"demand_multiplier": 1.2}, WEIGHTS)
    assert out["status_quo"]["after"]["hours_over_capacity"] > out["status_quo"]["before"]["hours_over_capacity"]


def test_earlier_customs_close_raises_customs_risk():
    base = _base()
    normal = whatif.run(base, base, {"at": "2027-02-12T11:00:00-08:00"}, WEIGHTS)
    early = whatif.run(base, base, {"at": "2027-02-12T11:00:00-08:00", "customs_hours": {"fri": ["09:00", "11:30"]}}, WEIGHTS)
    risk = lambda o: next(f["value"] for f in o["facts"] if f["id"] == "whatif.customs_at_risk")  # noqa: E731
    assert risk(early) >= risk(normal)


def test_closed_runway_jets_land_after_the_closure():
    ds, affected = whatif.apply_runway_closure(_base(), CLOSED)
    for x in affected:
        assert x["new_eta_local"] >= "2027-02-12T13:55"


def test_new_etas_resolve_the_stand_plan_with_few_moves():
    from rampcast.engine import stands
    from rampcast_server import parking
    base = _base()
    pos = parking.positions(base.stands, False)
    plan = stands.solve(base.flights, pos).assignment
    late = {"arrival_delay": {"from": "2027-02-12T09:00:00-08:00", "to": "2027-02-12T13:00:00-08:00", "minutes": 180}}
    after, _ = whatif.apply_disruptions(base, late)
    r = whatif.restand(base, after, plan, pos)
    assert r["changed_times"] > 0 and r["boxed_in"] == 0
    assert r["overflow_after"] <= r["overflow_before"] + r["changed_times"]
    assert all(m["time_changed"] for m in r["moves"]) or len(r["moves"]) <= 2 * r["changed_times"]
