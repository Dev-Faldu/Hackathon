"""Tests for P1 validation: no leakage in leave-one-event-out, range checks, report files."""
import csv

import numpy as np

from rampcast.forecast import data_io as io
from rampcast.forecast.ramp_sim import simulate
from rampcast.forecast.validate import SUMMARY_COLUMNS, loo_ratio_checks, main, plausibility_checks


def _pred(rows, event, metric, method="analog_mean_leave_one_out"):
    return next(r["predicted"] for r in rows if r["subject"] == event and r["metric"] == metric and r["method"] == method)


def test_held_out_event_never_enters_its_own_prediction():
    df = io.load_analogs()
    before = loo_ratio_checks(df)
    changed = df.copy()
    changed.loc[(changed["event"] == "SB_LX_2026") & (changed["metric"] == "arrivals_ratio"), "value"] = 99.0
    after = loo_ratio_checks(changed)
    assert _pred(after, "SB_LX_2026", "arrivals_ratio") == _pred(before, "SB_LX_2026", "arrivals_ratio")
    assert _pred(after, "SB_LVIII_2024", "arrivals_ratio") == 99.0  # the other event does see it


def test_every_event_is_compared_with_the_ordinary_week_rule():
    rows = loo_ratio_checks(io.load_analogs())
    naive = {(r["subject"], r["metric"]) for r in rows if r["method"] == "naive_ordinary_week"}
    assert naive == {(e, m) for e, m in io.load_analogs()[["event", "metric"]].itertuples(index=False)}


def test_plausibility_checks_report_a_range_and_a_status():
    rows = plausibility_checks("medium")
    assert {r["metric"] for r in rows} == {"aircraft_arriving_in_week", "aircraft_on_ramp_at_kickoff"}
    for r in rows:
        assert r["p10"] <= r["predicted"] <= r["p90"]
        assert r["reference_min"] <= r["reference_max"]
        assert r["status"] in {"within", "above", "below"}


def test_aircraft_count_is_at_least_the_equivalents():
    r = simulate("medium", runs=300)
    assert (r.aircraft >= r.occupancy - 1e-6).all() and r.aircraft.min() >= 0


def test_validate_writes_reports(tmp_path):
    main(tmp_path)
    names = {p.name for p in tmp_path.iterdir()}
    assert {"analog_ratios.csv", "validation_summary.csv", "forecast_daily_by_scenario.png",
            "occupancy_medium_vs_capacity.png"} <= names
    with open(tmp_path / "validation_summary.csv") as f:
        assert next(csv.reader(f)) == SUMMARY_COLUMNS
    assert all((tmp_path / n).stat().st_size > 10_000 for n in names if n.endswith(".png"))
