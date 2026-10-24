"""P2 backtest on real FAA TFMSC counts: real-data labels, data completeness, and no leakage."""
import pytest

from rampcast.forecast import data_io as io

needs_faa = pytest.mark.skipif(not io.faa_available(), reason="FAA TFMSC files not present")


def test_only_whitelisted_labels_count_as_real():
    assert io.is_real("faa_tfmsc")
    for label in ("reconstructed_2022", "published_wingx", "published", "assumed", "synthetic", "unknown"):
        assert not io.is_real(label)


@needs_faa
def test_faa_files_are_complete():
    assert len(io.load_faa_airport_daily("VNY")) == 632
    e = io.load_faa_event_daily()
    assert e["event"].nunique() == 7 and len(e) == 2950
    assert set(e["source"]) == {"faa_tfmsc"}


@needs_faa
def test_held_out_event_never_enters_its_own_fit():
    from rampcast.forecast import backtest as bt
    ratios = bt.region_ratios()
    for event in ratios:
        _, used = bt.uplift_without(event, ratios)
        assert event not in used and len(used) == len(ratios) - 1


@needs_faa
def test_baselines_end_before_the_event_window():
    from rampcast.forecast import backtest as bt
    lo, hi = io.forecast_params()["real_data"]["baseline_offsets"]
    assert lo < hi < min(bt.offsets())


@needs_faa
def test_backtest_runs_and_reports_n():
    from rampcast.forecast import backtest as bt
    out = bt.run()
    head = out["kvny_headline"]
    assert head["n_days"] == 7 and head["n_events_used"] == 6
    assert 0 <= head["interval_coverage_pct"] <= 100
