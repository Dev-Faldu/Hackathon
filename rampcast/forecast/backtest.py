"""P2: blind daily backtest on real FAA TFMSC business-jet counts.

Run from the repo root:  server/.venv/bin/python -m rampcast.forecast.backtest

Two leave-one-event-out tests, both under the P2 rules: the held-out event's rows, ratios and shape never enter the
fit that predicts it, and every baseline uses only ordinary days before the held-out week.
1. KVNY, Super Bowl LVI (2022): KVNY ordinary days before that week x day-offset multipliers from the other six host
   regions. This is the level the product forecasts (FBO = KVNY x a fixed share, so percentage errors are the same).
2. Host regions: each event's regional total from its own earlier ordinary days x multipliers from the other events.
Each is compared with two naive rules: "ordinary week" (x1.0) and "copy the previous host's multipliers".
Intervals use the ramp simulation's noise model (week factor + negative binomial) around the medium scenario.
No model selection happens here (the method is fixed in advance), so no held-out week can leak into a choice.
Writes reports/backtest_daily.csv and reports/backtest_summary.csv.
"""
from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import pandas as pd

from . import data_io as io
from .uplift import SCENARIOS, offsets
from .validate import REPORTS, write_csv

KVNY_EVENT = "SB_LVI_2022"
KVNY_CODE = "VNY"
DAILY_COLUMNS = ["test", "subject", "date", "day_offset", "method", "n_events_used", "predicted", "p10", "p90",
                 "actual", "abs_pct_error", "in_p10_p90"]
SUMMARY_COLUMNS = ["test", "subject", "method", "n_days", "n_events_used", "mape_pct", "interval_coverage_pct",
                   "note"]


def _year(event: str) -> int:
    return int(str(event).rsplit("_", 1)[-1])


def _third_monday(year: int, month: int) -> date:
    first = date(year, month, 1)
    return first + timedelta(days=(0 - first.weekday()) % 7 + 14)


def holidays(year: int) -> set[date]:
    """New Year's Day and the return day after it, MLK Day, Presidents' Day: the holidays inside the pulled windows."""
    return {date(year, 1, 1), date(year, 1, 2), _third_monday(year, 1), _third_monday(year, 2)}


def is_ordinary(d: date, scope: str) -> bool:
    if d in holidays(d.year):
        return False
    for x in io.forecast_params()["real_data"]["exclude"]:
        if x["scope"] in ("all", scope) and date.fromisoformat(x["from"]) <= d <= date.fromisoformat(x["to"]):
            return False
    return True


def weekday_baseline(series: pd.Series, game: date, scope: str) -> tuple[dict[int, float], int]:
    """Mean arrivals per weekday over ordinary days at real_data.baseline_offsets, all before the event window."""
    lo, hi = io.forecast_params()["real_data"]["baseline_offsets"]
    if int(hi) >= min(offsets()):
        raise ValueError("baseline days must end before the event window")
    first, last = game + timedelta(days=int(lo)), game + timedelta(days=int(hi))
    s = series[[first <= d <= last and is_ordinary(d, scope) for d in series.index]]
    if s.empty:
        raise ValueError(f"no ordinary baseline days for {scope}")
    by_weekday = s.groupby([d.weekday() for d in s.index]).mean()
    overall = float(s.mean())
    return {i: float(by_weekday.get(i, overall)) for i in range(7)}, len(s)


def region_ratios() -> dict[str, dict]:
    """Per event: game date, regional arrivals by date, weekday baseline, and arrivals / baseline per day offset."""
    out: dict[str, dict] = {}
    for event, g in io.load_faa_event_daily().groupby("event"):
        game = g["game_date"].iloc[0]
        series = g.groupby("date")["arrivals"].sum()  # TFMSC omits zero rows, so a missing airport-day adds 0
        base, n_base = weekday_baseline(series, game, event)
        ratios = {}
        for o in offsets():
            d = game + timedelta(days=o)
            ratios[o] = float(series.get(d, np.nan)) / base[d.weekday()]
        out[event] = {"game": game, "region": g["region"].iloc[0], "series": series, "baseline": base,
                      "n_baseline_days": n_base, "ratios": ratios}
    return out


def uplift_without(event: str, ratios: dict[str, dict]) -> tuple[dict[str, dict[int, float]], list[str]]:
    """Scenario multipliers by day offset from every event except `event` (forecast.uplift.scenario_rule)."""
    used = [e for e in ratios if e != event]  # the held-out event never enters its own fit
    if not used:
        raise ValueError("no other events to learn the uplift from")
    agg = {"min": np.nanmin, "mean": np.nanmean, "max": np.nanmax}
    rule = io.forecast_params()["uplift"]["scenario_rule"]
    curves = {s: {o: float(agg[rule[s]]([ratios[e]["ratios"][o] for e in used])) for o in offsets()}
              for s in SCENARIOS}
    return curves, used


def previous_host(event: str, ratios: dict[str, dict]) -> str | None:
    earlier = sorted((e for e in ratios if _year(e) < _year(event)), key=_year)
    return earlier[-1] if earlier else None


def count_quantiles(mu: np.ndarray, key: int) -> np.ndarray:
    """P10 / P50 / P90 of daily counts under the simulation's noise model (week factor x negative binomial)."""
    p = io.forecast_params()
    rng = np.random.default_rng([int(p["seed"]), key])
    runs = int(p["monte_carlo_runs"])
    lam = mu[None, :] * rng.lognormal(0.0, float(p["week_level_sd"]), size=runs)[:, None]
    phi = float(p["count_dispersion"])
    if phi > 1.0:
        n = lam / (phi - 1.0)
        counts = rng.negative_binomial(n, n / (n + lam))
    else:
        counts = rng.poisson(lam)
    return np.percentile(counts, [10, 50, 90], axis=0)


def predict_event(test: str, subject: str, series: pd.Series, game: date, scope: str,
                  methods: dict[str, tuple[dict[int, float], dict[int, float], dict[int, float], int]],
                  key: int) -> list[dict]:
    """methods: name -> (curve for P50, curve for the P10 edge, curve for the P90 edge, events used)."""
    base, _ = weekday_baseline(series, game, scope)
    days = [game + timedelta(days=o) for o in offsets()]
    rows = []
    for m_i, (method, (mid, lo_c, hi_c, n_used)) in enumerate(methods.items()):
        mu = {name: np.array([base[d.weekday()] * c[o] for d, o in zip(days, offsets())])
              for name, c in (("mid", mid), ("lo", lo_c), ("hi", hi_c))}
        q_mid = count_quantiles(mu["mid"], key * 10 + m_i)
        q10 = count_quantiles(mu["lo"], key * 10 + m_i)[0] if lo_c is not mid else q_mid[0]
        q90 = count_quantiles(mu["hi"], key * 10 + m_i)[2] if hi_c is not mid else q_mid[2]
        for i, (d, o) in enumerate(zip(days, offsets())):
            actual = series.get(d)
            if actual is None or not np.isfinite(actual) or actual <= 0:
                continue
            pred = float(q_mid[1, i])
            rows.append({"test": test, "subject": subject, "date": d.isoformat(), "day_offset": o,
                         "method": method, "n_events_used": n_used, "predicted": round(pred, 1),
                         "p10": round(float(q10[i]), 1), "p90": round(float(q90[i]), 1), "actual": int(actual),
                         "abs_pct_error": round(abs(pred - actual) / actual * 100, 1),
                         "in_p10_p90": bool(q10[i] <= actual <= q90[i])})
    return rows


def _methods(event: str, ratios: dict[str, dict]) -> dict:
    curves, used = uplift_without(event, ratios)
    ordinary = {o: 1.0 for o in offsets()}
    m = {"rampcast_medium": (curves["medium"], curves["medium"], curves["medium"], len(used)),
         "rampcast_low_high_envelope": (curves["medium"], curves["low"], curves["high"], len(used)),
         "naive_ordinary_week": (ordinary, ordinary, ordinary, 0)}
    prev = previous_host(event, ratios)
    if prev is not None:
        c = ratios[prev]["ratios"]
        m["naive_previous_host"] = (c, c, c, 1)
    return m


def summarise(rows: list[dict]) -> list[dict]:
    df = pd.DataFrame(rows)
    out = []
    for (test, method), g in df.groupby(["test", "method"], sort=False):
        groups = [("all events" if test == "host_regions" else g["subject"].iloc[0], g)]
        if test == "host_regions":
            groups += list(g.groupby("subject"))
        for subject, h in groups:
            out.append({"test": test, "subject": subject, "method": method, "n_days": len(h),
                        "n_events_used": int(h["n_events_used"].max()),
                        "mape_pct": round(float(h["abs_pct_error"].mean()), 1),
                        "interval_coverage_pct": round(float(h["in_p10_p90"].mean()) * 100, 1),
                        "note": "P50 error; coverage of the P10-P90 band (target 80%)"})
    return out


def run() -> dict:
    """Both tests. Returns daily rows, the summary and the KVNY headline (medium scenario)."""
    ratios = region_ratios()
    rows: list[dict] = []
    vny = io.load_faa_airport_daily(KVNY_CODE).set_index("date")["arrivals"]
    rows += predict_event("kvny_2022", f"KVNY {KVNY_EVENT}", vny, ratios[KVNY_EVENT]["game"], KVNY_CODE,
                          _methods(KVNY_EVENT, ratios), key=0)
    for k, event in enumerate(sorted(ratios, key=_year), start=1):
        r = ratios[event]
        rows += predict_event("host_regions", event, r["series"], r["game"], event, _methods(event, ratios), key=k)
    summary = summarise(rows)
    head = next(s for s in summary if s["test"] == "kvny_2022" and s["method"] == "rampcast_medium")
    return {"daily": rows, "summary": summary, "kvny_headline": head, "ratios": ratios}


def main() -> dict:
    REPORTS.mkdir(parents=True, exist_ok=True)
    out = run()
    write_csv(REPORTS / "backtest_daily.csv", out["daily"], DAILY_COLUMNS)
    write_csv(REPORTS / "backtest_summary.csv", out["summary"], SUMMARY_COLUMNS)
    print("source: faa_tfmsc (real FAA counts). Leave-one-event-out; baselines use only days before each week.")
    for s in out["summary"]:
        print(f"{s['test']:13s} {str(s['subject']):18s} {s['method']:27s} n={s['n_days']:<3} "
              f"events={s['n_events_used']}  MAPE {s['mape_pct']:6.1f}%  P10-P90 coverage {s['interval_coverage_pct']:5.1f}%")
    print("multipliers by day offset (arrivals / same-weekday baseline):")
    for e, r in sorted(out["ratios"].items(), key=lambda kv: _year(kv[0])):
        print(f"  {e:14s} {r['region']:12s} base days {r['n_baseline_days']:2d}  "
              + " ".join(f"{o:+d}:{v:.2f}" for o, v in r["ratios"].items()))
    print("wrote: backtest_daily.csv, backtest_summary.csv")
    return out


if __name__ == "__main__":
    main()
