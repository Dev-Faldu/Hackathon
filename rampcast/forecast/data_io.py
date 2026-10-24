"""The only module that reads data files.

Every other module gets data through these functions, so switching from Role 1's reconstructed files to a real
pull changes nothing outside this file. Only aggregates leave this module: no tail hashes or flight ids.
"""
from __future__ import annotations

import functools
import json
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

ROOT = Path(__file__).resolve().parents[2]
PROCESSED = ROOT / "data" / "processed"
ASSUMPTIONS_PATH = ROOT / "contracts" / "assumptions.yaml"
LA_TZ = "America/Los_Angeles"

# Source labels that mean observed data. Everything else (reconstructed, synthetic, sample, published, assumed,
# unknown, ...) counts as not real: a whitelist, so a new label can never be mistaken for real data.
REAL_PREFIXES = ("faa_", "opensky", "observed", "real")


@functools.lru_cache(maxsize=1)
def assumptions() -> dict:
    with open(ASSUMPTIONS_PATH) as f:
        return yaml.safe_load(f)


def forecast_params() -> dict:
    return assumptions()["forecast"]


def is_real(label: str) -> bool:
    return str(label).startswith(REAL_PREFIXES)


@functools.lru_cache(maxsize=1)
def data_source() -> str:
    """'real', 'mixed', or the label Role 1 put on the files (today: 'reconstructed_2022')."""
    counts = PROCESSED / "daily_counts.csv"
    if counts.exists() and "source" in pd.read_csv(counts, nrows=0).columns:
        labels = sorted({str(x) for x in pd.read_csv(counts, usecols=["source"])["source"].dropna()})
        if labels and all(is_real(x) for x in labels):
            return "real"
        if any(is_real(x) for x in labels):
            return "mixed"
        return labels[0] if labels else "unknown"
    replay = PROCESSED / "replay_2027.jsonl"
    if replay.exists():
        with open(replay) as f:
            first = f.readline().strip()
        if first:
            return str(json.loads(first).get("source", "unknown"))
    return "unknown"


@functools.lru_cache(maxsize=1)
def _daily_counts() -> pd.DataFrame:
    df = pd.read_csv(PROCESSED / "daily_counts.csv").rename(columns={"date": "date_local"})
    df["date_local"] = pd.to_datetime(df["date_local"]).dt.date
    if "source" not in df.columns:
        df["source"] = data_source()
    # A busy airport never sees zero business-jet arrivals in a day. Zeros in Role 1's files are window-edge
    # artifacts (arrivals outside the pulled window), so they are kept as missing, never as 0.
    df["arrivals"] = df["arrivals"].astype(float).where(df["arrivals"] > 0)
    return df[["date_local", "airport", "arrivals", "departures", "event_name", "day_offset", "source"]]


def load_daily_counts(airport: str | None = None) -> pd.DataFrame:
    """Daily arrivals and departures by local date. Missing days are NaN."""
    df = _daily_counts()
    return (df[df["airport"] == airport] if airport else df).copy()


def load_analogs(exclude_event: str | None = None) -> pd.DataFrame:
    """Published Super Bowl figures (assumptions.yaml forecast.analogs); one event can be left out."""
    df = pd.DataFrame(forecast_params()["analogs"])
    if exclude_event:
        df = df[df["event"] != exclude_event]
    return df.reset_index(drop=True)


@functools.lru_cache(maxsize=1)
def _event_arrivals() -> pd.DataFrame | None:
    path = PROCESSED / "flights.parquet"
    if not path.exists():
        return None
    f = pd.read_parquet(path, columns=["airport", "direction", "size_class", "last_seen_utc", "event_name"])
    a = f[(f["airport"] == forecast_params()["airport"]) & (f["direction"] == "arrival") & f["event_name"].notna()].copy()
    a["hour"] = pd.to_datetime(a["last_seen_utc"], utc=True).dt.tz_convert(LA_TZ).dt.hour
    return a[["size_class", "hour"]]


def arrival_hour_profile() -> np.ndarray:
    """Share of event-week arrivals by local hour (24 values summing to 1)."""
    a = _event_arrivals()
    if a is None or a.empty:
        prof = np.zeros(24)
        prof[6:22] = 1.0  # fallback: daytime hours, flat
    else:
        prof = np.bincount(a["hour"].to_numpy(), minlength=24).astype(float)
    return prof / prof.sum()


def size_mix() -> dict[str, float]:
    """Share of event-week arrivals by size class, over every class in large_equiv_factor."""
    classes = list(assumptions()["large_equiv_factor"])
    a = _event_arrivals()
    if a is None or a.empty:
        return {c: 1.0 / len(classes) for c in classes}
    share = a["size_class"].value_counts(normalize=True)
    return {c: float(share.get(c, 0.0)) for c in classes}


# ---------- real FAA TFMSC counts (data/external/faa_tfmsc, see its README) ----------

def _faa_path(key: str) -> Path:
    return ROOT / forecast_params()["real_data"]["files"][key]


def faa_available() -> bool:
    return all(_faa_path(k).exists() for k in forecast_params()["real_data"]["files"])


@functools.lru_cache(maxsize=2)
def _faa(key: str) -> pd.DataFrame:
    df = pd.read_csv(_faa_path(key))
    df["date"] = pd.to_datetime(df["date"]).dt.date
    if "game_date" in df.columns:
        df["game_date"] = pd.to_datetime(df["game_date"]).dt.date
    return df


def load_faa_airport_daily(airport: str | None = None) -> pd.DataFrame:
    """Daily business-jet departures and arrivals per airport (TFMSC dates, probably UTC days: see the README)."""
    df = _faa("airport_daily")
    return (df[df["airport"] == airport] if airport else df).copy()


def load_faa_event_daily(exclude_event: str | None = None) -> pd.DataFrame:
    """Daily business-jet counts at each Super Bowl host region's airports; one event can be left out."""
    df = _faa("event_daily")
    return (df[df["event"] != exclude_event] if exclude_event else df).copy()
