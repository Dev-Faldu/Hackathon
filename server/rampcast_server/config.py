"""Paths, time helpers and the shared assumptions file."""
from __future__ import annotations

import functools
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

ROOT = Path(__file__).resolve().parents[2]
PROCESSED = ROOT / "data" / "processed"
ASSUMPTIONS_PATH = ROOT / "contracts" / "assumptions.yaml"
LOG_DIR = ROOT / "logs"

LA = ZoneInfo("America/Los_Angeles")
UTC = ZoneInfo("UTC")

SIZE_CLASSES = ("light", "mid", "super_mid", "large", "other")
WINGSPAN_FT = {"light": 50, "mid": 58, "super_mid": 72, "large": 100, "other": 60}
SCENARIOS = ("low", "medium", "high")


@functools.lru_cache(maxsize=1)
def assumptions() -> dict:
    with open(ASSUMPTIONS_PATH) as f:
        return yaml.safe_load(f)


def window() -> tuple[date, date]:
    start, end = assumptions()["event"]["window"]
    return date.fromisoformat(start), date.fromisoformat(end)


def window_days() -> list[date]:
    start, end = window()
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


def window_start_local() -> datetime:
    return datetime.combine(window()[0], datetime.min.time(), tzinfo=LA)


def hour_index(t: datetime) -> int:
    """Hours since the start of the planning window (local midnight Tue)."""
    return int((t - window_start_local()).total_seconds() // 3600)


def n_hours() -> int:
    return len(window_days()) * 24


def parse_t(value: str | None) -> datetime:
    """Parse an ISO time; default to Friday 13:00 local, the busiest afternoon."""
    if not value:
        return datetime.combine(window()[0] + timedelta(days=3), datetime.min.time(), tzinfo=LA).replace(hour=13)
    t = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if t.tzinfo is None:
        t = t.replace(tzinfo=LA)
    return t.astimezone(LA)


def iso_local(t: datetime) -> str:
    return t.astimezone(LA).isoformat(timespec="minutes")


def iso_utc(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def large_equiv(size_class: str) -> float:
    return float(assumptions()["large_equiv_factor"].get(size_class, 0.6))
