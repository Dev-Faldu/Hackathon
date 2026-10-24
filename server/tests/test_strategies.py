"""Strategy generator (CP-SAT): three distinct plans, under the cap, partner spaces respected, repeatable."""
from rampcast.engine import strategies as S
from rampcast.engine.models import StrategiesResponse
from rampcast_server import config as C
from rampcast_server.data import generate_sample


def _plans(scenario="medium"):
    return S.strategies(generate_sample(scenario, seed=61))


def test_contract_shape_and_c_needs_faa():
    out = _plans()
    StrategiesResponse.model_validate(out)
    assert out["strategies"][2]["approvers"] == ["FBO general manager", "Airport operations", "FAA"]
    assert all(c["solver"] == "cp-sat" for c in out["strategies"])


def test_every_plan_clears_the_overflow():
    for sc in ("low", "medium", "high"):
        out = _plans(sc)
        assert all(c["kpis"]["hours_over_capacity"] == 0 for c in out["strategies"]), sc


def test_plans_differ_on_at_least_two_kpis():
    s = _plans()["strategies"]
    differing = [k for k in ("co2_t", "overflow_aircraft", "peak_line_staff", "risk", "empty_legs")
                 if len({c["kpis"][k] for c in s}) > 1]
    assert len(differing) >= 2


def test_partner_overflow_cuts_co2_and_uses_real_distances():
    a, b, c = _plans()["strategies"]
    assert b["kpis"]["co2_t"] < a["kpis"]["co2_t"]
    assert c["kpis"]["overflow_aircraft"] <= b["kpis"]["overflow_aircraft"]
    nm = S._partner_nm()
    assert nm["KWHP"] < nm["KBUR"] < nm["KCMA"]  # Whiteman is next door, Camarillo across the valley


def test_partner_spaces_are_never_exceeded():
    ds = generate_sample("high", seed=61)
    cap = S.capacity() * (1 - C.assumptions()["fbo"]["reservation_buffer_pct"] / 100)
    overflow, dest = S.choose(ds.flights, cap, S._partner_nm())
    spaces = C.assumptions()["overflow"]["partner_spaces"]
    by_id = {f.flight_id: f for f in overflow}
    for k, room in spaces.items():
        jets = [by_id[fid] for fid, d in dest.items() if d == k]
        times = sorted({f.landed for f in jets})
        for t in times:
            used = sum(f.footprint for f in jets if f.landed <= t < f.departed_vny)
            assert used <= room + 1e-9, f"{k} over its {room} spaces at {t}"


def test_same_input_same_plans():
    assert _plans() == _plans()
