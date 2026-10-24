"""Role 2 tests. Run from the repo root: server/.venv/bin/python -m pytest -q rampcast/forecast/tests"""
import time
from datetime import date

import numpy as np
import pytest

from rampcast.forecast import api, data_io as io
from rampcast.forecast.baseline import fit_baseline
from rampcast.forecast.ramp_sim import simulate, window_days
from rampcast.forecast.uplift import SCENARIOS, scenario_curves, scenario_levels

ARTIFACT_ZEROS = ["2022-01-22", "2022-01-23", "2022-01-24", "2022-02-16", "2022-02-17", "2022-02-18"]


def test_artifact_zeros_are_missing_not_zero():
    df = io.load_daily_counts("KVNY")
    assert (df["arrivals"].dropna() > 0).all()
    missing = {d.isoformat() for d in df[df["arrivals"].isna()]["date_local"]}
    assert set(ARTIFACT_ZEROS) <= missing


def test_data_source_is_labelled():
    assert io.data_source() == "reconstructed_2022"
    assert not io.is_real(io.data_source())


def test_baseline_uses_only_ordinary_days_and_respects_cutoff():
    assert fit_baseline().n_days == 7
    assert fit_baseline(before=date(2022, 1, 18)).n_days == 3  # nothing on or after the cutoff


def test_uplift_levels_and_anchor():
    levels = scenario_levels()
    assert levels == {"low": 1.5, "medium": 1.75, "high": 2.0}
    curves = scenario_curves()
    lo, hi = io.forecast_params()["uplift"]["anchor_offsets"]
    for s in SCENARIOS:
        assert np.mean([curves[s][d] for d in range(lo, hi + 1)]) == pytest.approx(levels[s])
    assert curves["low"][1] == curves["medium"][1] == curves["high"][1]  # Monday fixed across scenarios


def test_leave_one_event_out_drops_that_event():
    assert scenario_levels(exclude_event="SB_LX_2026") == {"low": 1.5, "medium": 1.5, "high": 1.5}
    assert scenario_levels(exclude_event="SB_LVIII_2024") == {"low": 2.0, "medium": 2.0, "high": 2.0}
    assert "SB_LVIII_2024" not in set(io.load_analogs("SB_LVIII_2024")["event"])


def test_simulation_is_deterministic():
    a, b = simulate("medium", runs=300), simulate("medium", runs=300)
    assert np.array_equal(a.daily_counts, b.daily_counts)
    assert np.array_equal(a.occupancy, b.occupancy)


@pytest.mark.parametrize("scenario", SCENARIOS)
def test_forecast_contract(scenario):
    fc = api.get_forecast(scenario)
    assert fc["scenario"] == scenario and fc["airport"] == "KVNY" and fc["model"] == api.MODEL_NAME
    assert [d["date"] for d in fc["days"]] == [d.isoformat() for d in window_days()]
    assert [d["date"] for d in fc["days"]][0] == "2027-02-09" and len(fc["days"]) == 7
    for d in fc["days"]:
        assert isinstance(d["p50"], int) and isinstance(d["baseline_p50"], int)
        assert 0 <= d["p10"] <= d["p50"] <= d["p90"]
    assert set(fc["validation"]) >= {"event_held_out", "mape_pct", "interval_coverage_pct"}
    assert fc["validation"]["mape_pct"] is None  # never report accuracy on reconstructed data


@pytest.mark.parametrize("scenario", SCENARIOS)
def test_occupancy_contract(scenario):
    oc = api.get_occupancy(scenario)
    assert oc["capacity"] > 0 and oc["runs"] == io.forecast_params()["monte_carlo_runs"]
    hours = oc["hours"]
    assert len(hours) == 168 and hours[0]["t_local"] == "2027-02-09T00:00-08:00"
    assert hours[-1]["t_local"] == "2027-02-15T23:00-08:00"
    for h in hours:
        assert 0 <= h["p50"] <= h["p90"]
        assert 0.0 <= h["p_over_capacity"] <= 1.0


def test_scenarios_are_ordered():
    peak_day = [max(d["p50"] for d in api.get_forecast(s)["days"]) for s in SCENARIOS]
    peak_hour = [max(h["p50"] for h in api.get_occupancy(s)["hours"]) for s in SCENARIOS]
    assert peak_day == sorted(peak_day) and peak_day[0] < peak_day[-1]
    assert peak_hour == sorted(peak_hour) and peak_hour[0] < peak_hour[-1]


def test_p_over_capacity_follows_capacity(monkeypatch):
    def p_over(cap):
        monkeypatch.setattr(api, "_capacity", lambda: cap)
        return np.array([h["p_over_capacity"] for h in api.get_occupancy("medium")["hours"]])
    tight, loose = p_over(30.0), p_over(60.0)
    assert (tight >= loose).all() and tight.sum() > loose.sum()


def test_warm_calls_are_fast():
    api.get_forecast("medium"), api.get_occupancy("medium")
    t0 = time.perf_counter()
    api.get_forecast("medium"), api.get_occupancy("medium")
    assert time.perf_counter() - t0 < 0.3


def test_server_uses_this_module():
    from fastapi.testclient import TestClient
    from rampcast_server import adapters
    from rampcast_server.main import app

    assert adapters.status()["forecast"] and adapters.status()["occupancy"]
    client = TestClient(app)  # no context manager: skips the startup warm-up thread
    assert client.get("/forecast?scenario=medium").json()["model"] == api.MODEL_NAME
    assert client.get("/ramp/occupancy?scenario=high").json()["model"] == api.MODEL_NAME
