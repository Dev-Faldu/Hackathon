"""M1 baseline: ordinary-week arrivals per weekday, at KVNY and at our FBO.

Today the only ordinary days are the seven reconstructed days 2022-01-15..21 (one per weekday). The only Monday
is MLK Day, a federal holiday; 2027's Monday in the window is Presidents' Day, so the holiday effect is consistent
but cannot be estimated separately. With a real multi-year pull, widen forecast.baseline_dates.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import pandas as pd

from . import data_io as io


@dataclass(frozen=True)
class Baseline:
    airport_by_weekday: tuple[float, ...]   # mean arrivals at the airport, Monday=0 .. Sunday=6
    fbo_share: float                         # fbo.share_of_airport_arrivals
    traffic_level: float                     # forecast.traffic_level_2027
    n_days: int                              # ordinary days used
    source: str

    def airport_mean(self, day: date) -> float:
        return self.airport_by_weekday[day.weekday()] * self.traffic_level

    def fbo_mean(self, day: date) -> float:
        return self.airport_mean(day) * self.fbo_share


def fit_baseline(before: date | None = None) -> Baseline:
    """Mean ordinary-day arrivals by weekday. `before` drops every day on or after that date (no leakage)."""
    p = io.forecast_params()
    start, end = (date.fromisoformat(x) for x in p["baseline_dates"])
    df = io.load_daily_counts(p["airport"])
    ok = df["event_name"].isna() & df["arrivals"].notna() & (df["date_local"] >= start) & (df["date_local"] <= end)
    if before is not None:
        ok &= df["date_local"] < before
    rows = df[ok]
    if rows.empty:
        raise ValueError("no ordinary days available to fit the baseline")
    by_weekday = pd.Series(rows["arrivals"].to_numpy(), index=[d.weekday() for d in rows["date_local"]])
    means = by_weekday.groupby(level=0).mean()
    overall = float(rows["arrivals"].mean())
    return Baseline(
        airport_by_weekday=tuple(float(means.get(i, overall)) for i in range(7)),
        fbo_share=float(io.assumptions()["fbo"]["share_of_airport_arrivals"]),
        traffic_level=float(p["traffic_level_2027"]),
        n_days=len(rows),
        source=io.data_source(),
    )
