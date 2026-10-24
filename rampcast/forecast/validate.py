"""P1 validation while the data is reconstructed.

Run from the repo root:  server/.venv/bin/python -m rampcast.forecast.validate

What it does, and why it is not a daily backtest: data/processed is Role 1's reconstruction of the 2022 week, so
a daily MAPE against it would score the model against assumptions it was shaped on. Instead:
1. Leave-one-event-out on the published WingX ratios: predict each event's ratio from the other events only, and
   compare with two naive rules ("ordinary week" = 1.0, and "copy the previous host's ratio").
2. A plausibility range check of the medium scenario against what single FBOs reported in 2022 (AIN poll).
Writes reports/analog_ratios.csv, reports/validation_summary.csv and two PNG charts.
"""
from __future__ import annotations

import csv
from pathlib import Path

import numpy as np
import pandas as pd

from . import data_io as io
from .cache import load_or_simulate
from .ramp_sim import game_date, window_days
from .uplift import SCENARIOS

REPORTS = io.ROOT / "reports"

SUMMARY_COLUMNS = ["check", "metric", "subject", "method", "n_events_used", "predicted", "p10", "p90",
                   "reference", "reference_min", "reference_max", "error", "abs_pct_error", "status", "note"]


def _year(event: str) -> int:
    return int(str(event).rsplit("_", 1)[-1])


def loo_ratio_checks(analogs: pd.DataFrame) -> list[dict]:
    """For each event and metric, predict the event's ratio without using that event."""
    rows: list[dict] = []
    for metric, grp in analogs.groupby("metric"):
        grp = grp.assign(year=grp["event"].map(_year)).sort_values("year")
        for r in grp.itertuples():
            others = grp[grp["event"] != r.event]  # the held-out event never enters its own prediction
            earlier = others[others["year"] < r.year]
            preds = {"naive_ordinary_week": (1.0, 0)}
            if len(others):
                preds["analog_mean_leave_one_out"] = (float(others["value"].mean()), len(others))
            if len(earlier):
                preds["naive_previous_host"] = (float(earlier["value"].iloc[-1]), 1)
            for method, (pred, n_used) in preds.items():
                actual = float(r.value)
                rows.append({
                    "check": "leave_one_event_out", "metric": metric, "subject": r.event, "method": method,
                    "n_events_used": n_used, "predicted": round(pred, 3), "reference": actual,
                    "error": round(pred - actual, 3), "abs_pct_error": round(abs(pred - actual) / actual * 100, 1),
                    "note": f"{len(grp)} published events for this metric",
                })
    return rows


def _kickoff_hour_index() -> int:
    days = window_days()
    hh = int(str(io.assumptions()["event"]["kickoff_local"]).split(":")[0])
    return days.index(game_date()) * 24 + hh  # counted at hh:30, the middle of the hour


def plausibility_checks(scenario: str = "medium") -> list[dict]:
    """Compare the scenario with single-FBO figures reported for 2022. A range check, not accuracy."""
    r = load_or_simulate(scenario)
    reports = pd.DataFrame(io.forecast_params()["fbo_reports_2022"])
    share = float(io.assumptions()["fbo"]["share_of_airport_arrivals"])
    checks = [
        ("aircraft_arriving_in_week", r.daily_counts.sum(axis=1),
         ["aircraft_in_week", "aircraft_in_week_prior"], "arrivals at our FBO over the 7-day window"),
        ("aircraft_on_ramp_at_kickoff", r.aircraft[:, _kickoff_hour_index()],
         ["aircraft_on_ramp_at_kickoff", "jets_on_ramp_game_day"], "aircraft on our ramp at kickoff (Sun 15:30)"),
    ]
    rows = []
    for metric, values, report_metrics, what in checks:
        ref = reports[reports["metric"].isin(report_metrics)]
        lo, hi = float(ref["value"].min()), float(ref["value"].max())
        p10, p50, p90 = (float(x) for x in np.percentile(values, [10, 50, 90]))
        status = "above" if p50 > hi else "below" if p50 < lo else "within"
        share_note = (f"; p50 reaches the top of the range at an FBO share of about {share * hi / p50:.2f} "
                      f"(now {share})" if status == "above" else "")
        rows.append({
            "check": "plausibility_range", "metric": metric, "subject": f"{scenario} scenario",
            "method": "rampcast.forecast v1", "predicted": round(p50, 1), "p10": round(p10, 1), "p90": round(p90, 1),
            "reference": "; ".join(f"{x.fbo} {x.airport} {x.value:g}" for x in ref.itertuples()),
            "reference_min": lo, "reference_max": hi, "status": status,
            "note": f"{what}; AIN informal poll 2022-02-18{share_note}",
        })
    return rows


def write_csv(path: Path, rows: list[dict], columns: list[str]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        w.writeheader()
        for row in rows:
            w.writerow({c: row.get(c, "") for c in columns})


# ---------- charts (matplotlib is imported only here, so the server never needs it) ----------

INK, INK_2, MUTED = "#0b0b0b", "#52514e", "#898781"
SURFACE, GRID, AXIS = "#fcfcfb", "#e1e0d9", "#c3c2b7"
SCENARIO_COLORS = {"low": "#86b6ef", "medium": "#2a78d6", "high": "#104281"}  # ordinal blue ramp, validated


def _style(ax) -> None:
    ax.set_facecolor(SURFACE)
    ax.grid(axis="y", color=GRID, linewidth=1, linestyle="-")
    ax.set_axisbelow(True)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color(AXIS)
    ax.tick_params(colors=MUTED, labelcolor=INK_2, length=0, labelsize=10)


def _title(fig, title: str, subtitle: str) -> None:
    fig.text(0.06, 0.95, title, fontsize=15, fontweight="bold", color=INK, va="top")
    fig.text(0.06, 0.895, subtitle, fontsize=10, color=INK_2, va="top")


def make_charts(out_dir: Path) -> list[Path]:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    days = window_days()
    labels = [f"{d:%a} {d.day}" + ("\ngame day" if d == game_date() else "") for d in days]
    x = np.arange(len(days))
    results = {s: load_or_simulate(s) for s in SCENARIOS}
    paths = []

    # Chart 1: daily arrivals by scenario.
    fig, ax = plt.subplots(figsize=(10, 5.625), dpi=160)
    fig.patch.set_facecolor(SURFACE)
    fig.subplots_adjust(left=0.07, right=0.93, top=0.74, bottom=0.14)
    _style(ax)
    med = np.percentile(results["medium"].daily_counts, [10, 90], axis=0)
    ax.fill_between(x, med[0], med[1], color=SCENARIO_COLORS["medium"], alpha=0.10, linewidth=0,
                    label="Medium P10–P90")
    ax.plot(x, results["medium"].baseline_fbo, color=MUTED, linewidth=2, solid_capstyle="round",
            label="Ordinary week")
    peak_i = int(np.argmax(np.percentile(results["high"].daily_counts, 50, axis=0)))
    for s in SCENARIOS:
        p50 = np.percentile(results[s].daily_counts, 50, axis=0)
        ax.plot(x, p50, color=SCENARIO_COLORS[s], linewidth=2, solid_capstyle="round", solid_joinstyle="round",
                marker="o", markersize=8, markeredgecolor=SURFACE, markeredgewidth=2, label=f"{s.capitalize()} P50")
        ax.annotate(f"{s.capitalize()} {p50[peak_i]:.0f}", (x[peak_i], p50[peak_i]), xytext=(12, 0),
                    textcoords="offset points", va="center", fontsize=10, color=INK_2)
    ax.set_xticks(x, labels)
    ax.set_ylim(0, None)
    ax.set_ylabel("Arrivals per day at our FBO", color=INK_2, fontsize=10)
    ax.legend(loc="upper left", frameon=False, fontsize=10, ncol=5, bbox_to_anchor=(0, 1.1), labelcolor=INK_2,
              handlelength=2.4)
    _title(fig, "Super Bowl LXI week: daily arrivals at our FBO",
           "P50 by scenario; band = medium P10–P90 over 5,000 simulated weeks.\n"
           "Inputs: Role 1's reconstructed 2022 week and published WingX ratios.")
    p = out_dir / "forecast_daily_by_scenario.png"
    fig.savefig(p, facecolor=SURFACE)
    plt.close(fig)
    paths.append(p)

    # Chart 2: medium-scenario ramp occupancy against capacity.
    occ = results["medium"].occupancy
    q10, q50, q90 = np.percentile(occ, [10, 50, 90], axis=0)
    cap = float(io.assumptions()["fbo"]["capacity_large_equiv"])
    hours = np.arange(occ.shape[1]) + 0.5
    fig, ax = plt.subplots(figsize=(10, 5.625), dpi=160)
    fig.patch.set_facecolor(SURFACE)
    fig.subplots_adjust(left=0.07, right=0.93, top=0.8, bottom=0.14)
    _style(ax)
    ax.fill_between(hours, q10, q90, color=SCENARIO_COLORS["medium"], alpha=0.10, linewidth=0)
    ax.plot(hours, q50, color=SCENARIO_COLORS["medium"], linewidth=2, solid_capstyle="round", solid_joinstyle="round")
    ax.axhline(cap, color=INK_2, linewidth=1.5)
    ax.text(hours[-1], cap, f"Capacity {cap:g}", ha="right", va="bottom", fontsize=10, color=INK_2)
    k = _kickoff_hour_index()
    ax.axvline(k + 0.5, color=AXIS, linewidth=1)
    ax.text(k + 1.0, 1.5, "Kickoff Sun 15:30", ha="left", va="bottom", fontsize=10, color=INK_2)
    peak_h = int(np.argmax(q50))
    ax.annotate(f"P50 peak {q50[peak_h]:.0f}", (hours[peak_h], q50[peak_h]), xytext=(-8, 10),
                textcoords="offset points", ha="right", fontsize=10, color=INK_2)
    band_h = 2 * 24 + 12  # Thursday noon: the band is clear of other labels there
    ax.annotate("P10–P90", (hours[band_h], q90[band_h]), xytext=(0, 6), textcoords="offset points",
                ha="center", fontsize=10, color=INK_2)
    ax.set_xticks(np.arange(0, occ.shape[1] + 1, 24), [f"{d:%a} {d.day}" for d in days] + [""])
    ax.set_xlim(0, occ.shape[1])
    ax.set_ylim(0, None)
    ax.set_ylabel("Large-cabin equivalents on our ramp", color=INK_2, fontsize=10)
    over = int(((occ > cap).mean(axis=0) >= 0.5).sum())
    _title(fig, "Medium scenario: ramp occupancy against capacity",
           f"Hourly P50 and P10–P90 over 5,000 simulated weeks; {over} hours have at least a 50% chance of "
           f"exceeding capacity.")
    p = out_dir / "occupancy_medium_vs_capacity.png"
    fig.savefig(p, facecolor=SURFACE)
    plt.close(fig)
    paths.append(p)
    return paths


def main(out_dir: Path = REPORTS) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    analogs = io.load_analogs()
    write_csv(out_dir / "analog_ratios.csv", analogs.to_dict("records"),
              ["event", "region", "metric", "value", "use", "window", "source", "url"])
    loo = loo_ratio_checks(analogs)
    plaus = plausibility_checks("medium")
    write_csv(out_dir / "validation_summary.csv", loo + plaus, SUMMARY_COLUMNS)
    charts = make_charts(out_dir)
    print(f"data source: {io.data_source()} (no daily accuracy is reported on reconstructed data)")
    for r in loo:
        print(f"LOO  {r['metric']:24s} {r['subject']:14s} {r['method']:26s} pred {r['predicted']:<6} "
              f"actual {r['reference']:<5} |err| {r['abs_pct_error']}%")
    for r in plaus:
        print(f"PLAUS {r['metric']:28s} p50 {r['predicted']} (p10 {r['p10']}, p90 {r['p90']}) vs reported "
              f"{r['reference_min']:g}-{r['reference_max']:g}: {r['status']}")
    print("wrote:", ", ".join(p.name for p in [out_dir / "analog_ratios.csv", out_dir / "validation_summary.csv", *charts]))
    return {"loo": loo, "plausibility": plaus, "charts": charts}


if __name__ == "__main__":
    main()
