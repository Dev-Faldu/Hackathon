"""Role 1 (Data Engineering) Pipeline for RAMPCAST.

Produces all files in data/processed/ according to contracts/README.md:
1. flights.parquet  - One row per flight touching an LA-basin airport
2. daily_counts.csv - Daily aggregate counts and size breakdown per airport
3. replay_2027.jsonl - Replayed flight events shifted +1827 days to 2027 Super Bowl week
4. bookings.json    - Synthetic passenger & ground transport bookings for our FBO
5. stands.json      - Sepulveda Jet Center ramp configuration & stand layout

Source: a real OpenSky pull in data/raw/opensky (make fetch) when present, labelled "opensky_2022_shifted";
otherwise a reconstruction calibrated to the published 2022 counts, labelled "reconstructed_2022".

Usage:
    python data/scripts/build_processed.py
    python data/scripts/build_processed.py --verify
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import glob
import hashlib
import json
import math
import os
import random
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

# Paths
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
RAW_DIR = ROOT / "data" / "raw"
OPENSKY_RAW_DIR = RAW_DIR / "opensky"
PROCESSED_DIR = ROOT / "data" / "processed"

# Constants & Assumptions
AIRPORTS = ["KVNY", "KHHR", "KBUR", "KLGB", "KSMO", "KTOA", "KSNA", "KONT", "KCMA", "KWHP", "KLAX"]
US_PREFIXES = ("K", "P", "TJ")
SHIFT_DAYS = 1827
SHIFT = dt.timedelta(days=SHIFT_DAYS)
GAME_DATE_2022 = dt.date(2022, 2, 13)
GAME_DATE_2027 = dt.date(2027, 2, 14)
ANALOG_WINDOW = (dt.date(2022, 2, 5), dt.date(2022, 2, 15))
BASELINE_WINDOW = (dt.date(2022, 1, 15), dt.date(2022, 1, 31))

# Size classes and standard business aviation fleet
FLEET_TEMPLATES = [
    ("large", "GULFSTREAM", "G650", 16),
    ("large", "GULFSTREAM", "G550", 14),
    ("large", "BOMBARDIER", "GLOBAL 7500", 19),
    ("large", "BOMBARDIER", "BD-700 GLOBAL", 15),
    ("large", "DASSAULT", "FALCON 8X", 14),
    ("large", "BOEING", "BBJ 737", 25),
    ("super_mid", "BOMBARDIER", "CHALLENGER 350", 10),
    ("super_mid", "CESSNA", "CITATION X", 9),
    ("super_mid", "GULFSTREAM", "G280", 10),
    ("super_mid", "EMBRAER", "PRAETOR 600", 10),
    ("super_mid", "DASSAULT", "FALCON 2000", 10),
    ("mid", "CESSNA", "CITATION LATITUDE", 8),
    ("mid", "CESSNA", "CITATION SOVEREIGN", 9),
    ("mid", "HAWKER", "HAWKER 800XP", 8),
    ("mid", "BOMBARDIER", "LEARJET 60", 7),
    ("light", "EMBRAER", "PHENOM 300", 7),
    ("light", "CESSNA", "CITATION CJ4", 7),
    ("light", "PILATUS", "PC-12", 9),
    ("light", "HONDA", "HONDAJET HA-420", 5),
    ("light", "BEECH", "KING AIR 350", 9),
    ("other", "BEECH", "BONANZA G36", 5),
    ("other", "CIRRUS", "SR22", 4),
]

ORIGINS = [
    ("KTEB", "Teterboro, NJ", False, 14),
    ("KHPN", "White Plains, NY", False, 6),
    ("KLAS", "Las Vegas, NV", False, 12),
    ("KSJC", "San Jose, CA", False, 8),
    ("KDAL", "Dallas Love, TX", False, 8),
    ("KHOU", "Houston Hobby, TX", False, 5),
    ("KOPF", "Miami Opa-locka, FL", False, 7),
    ("KSDL", "Scottsdale, AZ", False, 8),
    ("KAPA", "Denver Centennial, CO", False, 6),
    ("KAUS", "Austin, TX", False, 5),
    ("KMDW", "Chicago Midway, IL", False, 6),
    ("KBED", "Boston Hanscom, MA", False, 4),
    ("KBFI", "Seattle Boeing Field, WA", False, 5),
    ("KPDK", "Atlanta Peachtree, GA", False, 4),
    ("KBNA", "Nashville, TN", False, 3),
    ("MMTO", "Toluca, Mexico", True, 4),
    ("CYYZ", "Toronto, Canada", True, 3),
    ("EGGW", "London Luton, UK", True, 2),
    ("MMSD", "Los Cabos, Mexico", True, 3),
    ("CYVR", "Vancouver, Canada", True, 2),
]

HOTEL_ZONES = ["Beverly Hills", "Santa Monica", "Downtown LA", "Inglewood", "Burbank"]
ZONE_WEIGHTS = [0.30, 0.22, 0.18, 0.18, 0.12]
CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def hash_tail(icao24: str) -> str:
    return hashlib.sha256((icao24 or "").lower().encode()).hexdigest()[:16]


# ---------- Calibrated reconstruction (only when no real OpenSky pull is on disk) ----------
# Published anchors for Super Bowl LVI week in the LA basin (FlightAware and WingX via Business Jet Traveler):
# 501 business-jet arrivals on Fri 11 Feb 2022 and 548 departures on Mon 14 Feb. WingX measured about 2x normal
# arrivals in the days before a Super Bowl. Days between the anchors are interpolated on that shape, and the
# ordinary January week sets the baseline. Labelled "reconstructed_2022" everywhere it appears.
BASIN_ARRIVALS = {
    dt.date(2022, 1, 15): 205, dt.date(2022, 1, 16): 196, dt.date(2022, 1, 17): 244, dt.date(2022, 1, 18): 252,
    dt.date(2022, 1, 19): 258, dt.date(2022, 1, 20): 264, dt.date(2022, 1, 21): 268,
    dt.date(2022, 2, 5): 214, dt.date(2022, 2, 6): 204, dt.date(2022, 2, 7): 262, dt.date(2022, 2, 8): 298,
    dt.date(2022, 2, 9): 352, dt.date(2022, 2, 10): 431, dt.date(2022, 2, 11): 501, dt.date(2022, 2, 12): 438,
    dt.date(2022, 2, 13): 286, dt.date(2022, 2, 14): 176, dt.date(2022, 2, 15): 232,
}
MONDAY = dt.date(2022, 2, 14)
MONDAY_DEPARTURES_PUBLISHED = 548
# Share of basin business-jet arrivals by airport; VNY is the busiest general-aviation field in the basin.
AIRPORT_SHARE = {"KVNY": 0.27, "KBUR": 0.13, "KHHR": 0.12, "KSNA": 0.12, "KLGB": 0.09, "KSMO": 0.07,
                 "KONT": 0.05, "KCMA": 0.05, "KTOA": 0.04, "KLAX": 0.04, "KWHP": 0.02}
HOUR_WEIGHTS = [0, 0, 0, 0, 0, 0.5, 2, 4, 6, 8, 10, 11, 11, 10, 10, 9, 8, 6, 4, 3, 2, 1, 0.5, 0]
SIZE_EVENT = {"large": 0.36, "super_mid": 0.26, "mid": 0.21, "light": 0.17}
SIZE_ORDINARY = {"large": 0.28, "super_mid": 0.25, "mid": 0.24, "light": 0.23}
COORDS = {  # origin airports, for block times
    "KTEB": (40.850, -74.061), "KHPN": (41.067, -73.708), "KLAS": (36.084, -115.152), "KSJC": (37.363, -121.929),
    "KDAL": (32.847, -96.852), "KHOU": (29.645, -95.279), "KOPF": (25.907, -80.278), "KSDL": (33.623, -111.911),
    "KAPA": (39.570, -104.849), "KAUS": (30.194, -97.670), "KMDW": (41.786, -87.752), "KBED": (42.470, -71.289),
    "KBFI": (47.530, -122.302), "KPDK": (33.875, -84.302), "KBNA": (36.124, -86.678), "MMTO": (19.337, -99.566),
    "CYYZ": (43.677, -79.631), "EGGW": (51.875, -0.368), "MMSD": (23.152, -109.721), "CYVR": (49.194, -123.184),
}
LA_TZ = ZoneInfo("America/Los_Angeles")
EVENT_DAYS = {dt.date(2022, 2, d) for d in range(9, 14)}   # Wed 9 - Sun 13
GAME_DAY = GAME_DATE_2022
THROUGH_GAME_MONDAY_SHARE = 0.505  # of jets staying through the game, the share leaving Monday (rest: Sunday night)


def _block_hours(origin: str, rng: random.Random) -> float:
    lat, lon = COORDS.get(origin, (37.0, -110.0))
    p1, p2, dl = math.radians(lat), math.radians(34.21), math.radians(-118.49 - lon)
    nm = 3440.065 * math.acos(min(1.0, math.sin(p1) * math.sin(p2) + math.cos(p1) * math.cos(p2) * math.cos(dl)))
    return nm / 440 + 0.35 + rng.uniform(-0.1, 0.2)


def _local(day: dt.date, hour: int, minute: int) -> dt.datetime:
    return dt.datetime(day.year, day.month, day.day, hour, minute, tzinfo=LA_TZ)


def _allocate(total: int, shares: dict[str, float]) -> dict[str, int]:
    """Largest-remainder split, so each day's basin total is kept exactly."""
    raw = {k: total * v for k, v in shares.items()}
    out = {k: int(v) for k, v in raw.items()}
    for k in sorted(raw, key=lambda k: raw[k] - out[k], reverse=True)[: total - sum(out.values())]:
        out[k] += 1
    return out


def reconstruct_week(out_dir: Path) -> dict:
    """Write arrival/departure CSVs (OpenSky column layout) for the reconstructed weeks into out_dir/flights,
    plus the fleet lookup out_dir/fleet.csv. Every arrival is paired with the same jet's departure."""
    rng = random.Random(2022)
    flights_dir = out_dir / "flights"
    flights_dir.mkdir(parents=True, exist_ok=True)
    for old in flights_dir.glob("*.csv"):
        old.unlink()
    fleet_rows, rows = [], {}  # rows[(airport, direction, local date)] -> list
    origins, origin_w = [o[0] for o in ORIGINS], [o[3] for o in ORIGINS]
    models = {}
    for cls, mfr, model, seats in FLEET_TEMPLATES:
        if cls != "other":
            models.setdefault(cls, []).append((mfr, model, seats))
    seq = 0
    for day, total in sorted(BASIN_ARRIVALS.items()):
        event = day in EVENT_DAYS
        mix = SIZE_EVENT if event else SIZE_ORDINARY
        hw = list(HOUR_WEIGHTS)
        if day == GAME_DAY:  # game-day TFR afternoon: arrivals mostly before 14:30
            hw = [w * (0.35 if 14 <= h < 21 else 1) for h, w in enumerate(hw)]
        for ap, n in _allocate(total, AIRPORT_SHARE).items():
            for _ in range(n):
                seq += 1
                icao24 = f"{0xA00000 + seq:06x}"
                cls = rng.choices(list(mix), weights=list(mix.values()))[0]
                mfr, model, seats = rng.choice(models[cls])
                fleet_rows.append([icao24, mfr, model, seats, cls])
                origin = rng.choices(origins, weights=origin_w)[0]
                land = _local(day, rng.choices(range(24), weights=hw)[0], rng.randint(0, 59))
                dep_origin = land - dt.timedelta(hours=_block_hours(origin, rng))
                # How long it stays, the same rules the planning engine uses for a Super Bowl week.
                if rng.random() < (0.38 if event else 0.30):
                    dep = land + dt.timedelta(minutes=rng.randint(55, 130))
                elif (event and day >= dt.date(2022, 2, 10) and rng.random() < 0.70) or (day == dt.date(2022, 2, 9) and rng.random() < 0.45):
                    if rng.random() < THROUGH_GAME_MONDAY_SHARE:
                        dep = _local(MONDAY, rng.randint(7, 17), rng.randint(0, 59))
                    else:
                        dep = _local(GAME_DAY, rng.randint(20, 23), rng.randint(0, 59))
                else:
                    dep = _local(day + dt.timedelta(days=rng.randint(1, 3)), rng.randint(8, 17), rng.randint(0, 59))
                dep = max(dep, land + dt.timedelta(minutes=50))
                th = hash_tail(icao24)
                rows.setdefault((ap, "arrival", land.date()), []).append(
                    [th, icao24, "", origin, ap, int(dep_origin.timestamp()), int(land.timestamp())])
                rows.setdefault((ap, "departure", dep.date()), []).append(
                    [th, icao24, "", ap, origin, int(dep.timestamp()), int((dep + dt.timedelta(hours=2)).timestamp())])
    for (ap, direction, day), rs in rows.items():
        with open(flights_dir / f"{ap}_{direction}_{day:%Y-%m-%d}.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["tail_hash", "icao24", "callsign", "dep", "arr", "first_seen", "last_seen"])
            w.writerows(sorted(rs, key=lambda r: r[5]))
    with open(out_dir / "fleet.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["icao24", "manufacturer", "model", "seats", "size_class"])
        w.writerows(fleet_rows)
    monday_deps = sum(len(rs) for (ap, d, day), rs in rows.items() if d == "departure" and day == MONDAY)
    friday_arrs = sum(len(rs) for (ap, d, day), rs in rows.items() if d == "arrival" and day == dt.date(2022, 2, 11))
    print(f"Reconstructed {seq} arrivals: Fri 11 Feb {friday_arrs} (published 501), "
          f"Mon 14 Feb departures {monday_deps} (published {MONDAY_DEPARTURES_PUBLISHED})")
    return {"arrivals": seq, "friday_arrivals": friday_arrs, "monday_departures": monday_deps}


def build_replay(raw_dir: Path, out_path: Path, flights_dir: str, registry: str, source: str) -> int:
    """Build replay_2027.jsonl from KVNY arrival/departure CSVs (real OpenSky or the reconstruction)."""
    import sys
    if str(HERE) not in sys.path:
        sys.path.insert(0, str(HERE))
    import build_replay as br
    return br.build(str(raw_dir), str(out_path), flights_dir=flights_dir, registry=registry, source=source)


def build_stands(out_path: Path) -> None:
    """Build stands.json according to contracts/README.md."""
    spans = [110, 100, 80, 100, 80, 60, 100, 80, 60, 110, 100, 80]
    stands = []
    for row in "ABCD":
        for n in range(1, 13):
            stands.append({
                "stand_id": f"{row}{n}",
                "row": row,
                "column": (n - 1) // 3 + 1,
                "depth": (n - 1) % 3 + 1,
                "max_wingspan_ft": spans[n - 1],
            })
    doc = {
        "fbo": "Sepulveda Jet Center (fictional)",
        "airport": "KVNY",
        "capacity_large_equiv": 48,
        "stands": stands,
    }
    with open(out_path, "w") as f:
        json.dump(doc, f, indent=2)
    print(f"Wrote {len(stands)} stands to {out_path}")


def build_bookings(replay_path: Path, out_path: Path) -> int:
    """Build synthetic bookings.json for replayed KVNY arrivals."""
    rng = random.Random(61)
    flights = []
    with open(replay_path) as f:
        for line in f:
            e = json.loads(line)
            if e["event"] == "landed" and e.get("airport") == "KVNY":
                flights.append(e)

    bookings = []
    used_codes = set()
    for f in flights:
        code = f"RC-{''.join(rng.choices(CODE_CHARS, k=4))}"
        while code in used_codes:
            code = f"RC-{''.join(rng.choices(CODE_CHARS, k=4))}"
        used_codes.add(code)

        r = rng.random()
        ctype = "fixed_time" if r < 0.15 else "medical_access" if r < 0.20 else "none"
        deadline_local = None
        if ctype == "fixed_time":
            # 2 to 5 hours after landing in local time
            landed_utc = dt.datetime.fromisoformat(f["t_utc"].replace("Z", "+00:00"))
            landed_local = landed_utc.astimezone(dt.timezone(dt.timedelta(hours=-8)))
            mins = rng.randint(8, 20) * 15
            dl = landed_local + dt.timedelta(minutes=mins)
            dl = dl.replace(minute=(dl.minute // 15) * 15, second=0, microsecond=0)
            deadline_local = dl.isoformat()

        zone = rng.choices(HOTEL_ZONES, weights=ZONE_WEIGHTS)[0]
        bookings.append({
            "booking_code": code,
            "flight_id": f["flight_id"],
            "party_size": rng.randint(1, 12),
            "commitment_type": ctype,
            "deadline_local": deadline_local,
            "hotel_zone": zone,
            "synthetic": True,
        })

    with open(out_path, "w") as f:
        json.dump(bookings, f, indent=2)
    print(f"Wrote {len(bookings)} synthetic bookings to {out_path}")
    return len(bookings)


def build_flights_parquet_and_daily_counts(flights_dir: Path, reg_path: Path, out_parquet: Path, out_csv: Path) -> tuple[int, int]:
    """Build flights.parquet and daily_counts.csv according to contracts/README.md."""
    # Load aircraft registry
    sizes = {}
    models = {}
    if reg_path.exists():
        with open(reg_path, newline="") as f:
            for r in csv.DictReader(f):
                ic = r["icao24"].lower()
                sizes[ic] = r["size_class"]
                models[ic] = f"{r['manufacturer']} {r['model']}".strip()

    csv_files = sorted(flights_dir.glob("*.csv"))

    rows = []
    seq_counter = {}

    for path in csv_files:
        name = path.name  # {ap}_{direction}_{date}.csv
        parts = name[:-4].split("_")
        if len(parts) < 3:
            continue
        airport = parts[0]
        direction = parts[1]
        date_str = parts[2]
        date_obj = dt.date.fromisoformat(date_str)

        is_event = ANALOG_WINDOW[0] <= date_obj <= ANALOG_WINDOW[1]
        event_name = "SB_LVI_2022" if is_event else None
        day_offset = (date_obj - GAME_DATE_2022).days if is_event else None

        with open(path, newline="") as f:
            reader = csv.DictReader(f)
            for r in reader:
                fs = r.get("first_seen")
                ls = r.get("last_seen")
                if not fs or not ls:
                    continue
                first_seen_ts = int(fs)
                last_seen_ts = int(ls)
                first_seen_utc = dt.datetime.fromtimestamp(first_seen_ts, tz=dt.timezone.utc).isoformat().replace("+00:00", "Z")
                last_seen_utc = dt.datetime.fromtimestamp(last_seen_ts, tz=dt.timezone.utc).isoformat().replace("+00:00", "Z")

                icao24 = (r.get("icao24") or "").lower()
                size_class = sizes.get(icao24, "other")
                model = models.get(icao24, "UNKNOWN AIRCRAFT")

                origin = (r.get("dep") or "").strip() or None
                dest = (r.get("arr") or "").strip() or None

                if direction == "arrival":
                    is_international = bool(origin) and not origin.startswith(US_PREFIXES)
                else:
                    is_international = bool(dest) and not dest.startswith(US_PREFIXES)

                t_ref = last_seen_utc if direction == "arrival" else first_seen_utc
                dt_ref = dt.datetime.fromisoformat(t_ref.replace("Z", "+00:00"))
                seq_key = (airport, dt_ref.strftime("%Y%m%d%H"))
                seq_counter[seq_key] = seq_counter.get(seq_key, 0) + 1
                flight_id = f"F{dt_ref:%Y%m%d%H}{airport}{seq_counter[seq_key]:04d}"

                rows.append({
                    "flight_id": flight_id,
                    "tail_hash": r["tail_hash"],
                    "size_class": size_class,
                    "model": model,
                    "origin": origin,
                    "dest": dest,
                    "is_international": is_international,
                    "first_seen_utc": first_seen_utc,
                    "last_seen_utc": last_seen_utc,
                    "direction": direction,
                    "airport": airport,
                    "event_name": event_name,
                    "day_offset": day_offset,
                    "date": date_str,
                })

    df = pd.DataFrame(rows)
    print(f"Extracted {len(df)} total flight events.")

    # Save flights.parquet
    parquet_df = df.drop(columns=["date"])
    # Schema check
    expected_cols = [
        "flight_id", "tail_hash", "size_class", "model", "origin", "dest",
        "is_international", "first_seen_utc", "last_seen_utc", "direction",
        "airport", "event_name", "day_offset"
    ]
    parquet_df = parquet_df[expected_cols]
    parquet_df.to_parquet(out_parquet, index=False, engine="pyarrow")
    print(f"Saved {len(parquet_df)} flights to {out_parquet}")

    # Build daily_counts.csv
    # Columns: date, airport, arrivals, departures, arr_light, arr_mid, arr_super_mid, arr_large, arr_other, event_name, day_offset
    daily_records = []
    grouped = df.groupby(["date", "airport"])

    for (d_str, ap), grp in grouped:
        d_obj = dt.date.fromisoformat(d_str)
        is_event = ANALOG_WINDOW[0] <= d_obj <= ANALOG_WINDOW[1]
        ev_name = "SB_LVI_2022" if is_event else ""
        offset = str((d_obj - GAME_DATE_2022).days) if is_event else ""

        arrs = grp[grp["direction"] == "arrival"]
        deps = grp[grp["direction"] == "departure"]

        counts_by_size = arrs["size_class"].value_counts().to_dict()

        daily_records.append({
            "date": d_str,
            "airport": ap,
            "arrivals": len(arrs),
            "departures": len(deps),
            "arr_light": counts_by_size.get("light", 0),
            "arr_mid": counts_by_size.get("mid", 0),
            "arr_super_mid": counts_by_size.get("super_mid", 0),
            "arr_large": counts_by_size.get("large", 0),
            "arr_other": counts_by_size.get("other", 0),
            "event_name": ev_name,
            "day_offset": offset,
        })

    daily_df = pd.DataFrame(daily_records)
    daily_df = daily_df.sort_values(by=["date", "airport"])
    daily_df.to_csv(out_csv, index=False)
    print(f"Saved {len(daily_df)} daily count rows to {out_csv}")

    return len(parquet_df), len(daily_df)


def verify_processed_data() -> bool:
    """Validate all processed files against contracts/README.md."""
    print("\n--- Verifying Role 1 Data Contracts ---")
    ok = True

    # 1. stands.json
    stands_p = PROCESSED_DIR / "stands.json"
    if not stands_p.exists():
        print("❌ stands.json missing")
        ok = False
    else:
        st = json.loads(stands_p.read_text())
        assert st["airport"] == "KVNY", "Airport mismatch"
        assert st["capacity_large_equiv"] == 48, "Capacity mismatch"
        assert len(st["stands"]) == 48, "Expected 48 stands"
        print(f"✓ stands.json verified: 48 stands at {st['airport']}")

    # 2. replay_2027.jsonl
    replay_p = PROCESSED_DIR / "replay_2027.jsonl"
    if not replay_p.exists():
        print("❌ replay_2027.jsonl missing")
        ok = False
    else:
        lines = replay_p.read_text().splitlines()
        assert len(lines) > 0, "replay_2027.jsonl is empty"
        first = json.loads(lines[0])
        assert "t_utc" in first and "flight_id" in first and "event" in first
        # Verify 2027 timestamp shift
        assert first["t_utc"].startswith("2027-"), f"Expected 2027 dates, got {first['t_utc']}"
        # Privacy check: no passenger name or raw tail
        banned = {"name", "passenger_name", "tail", "n_number"}
        assert not banned.intersection(first.keys()), "Privacy violation in replay"
        print(f"✓ replay_2027.jsonl verified: {len(lines)} replayed events shifted to 2027")

    # 3. bookings.json
    bookings_p = PROCESSED_DIR / "bookings.json"
    if not bookings_p.exists():
        print("❌ bookings.json missing")
        ok = False
    else:
        bks = json.loads(bookings_p.read_text())
        assert len(bks) > 0, "bookings.json is empty"
        first_bk = bks[0]
        assert first_bk["booking_code"].startswith("RC-")
        assert first_bk["commitment_type"] in ("fixed_time", "medical_access", "none")
        assert first_bk["hotel_zone"] in HOTEL_ZONES
        banned = {"name", "passenger_name", "status", "tier", "payment", "price"}
        assert not banned.intersection(first_bk.keys()), "Privacy violation in bookings"
        print(f"✓ bookings.json verified: {len(bks)} synthetic bookings, strict privacy check passed")

    # 4. flights.parquet
    parquet_p = PROCESSED_DIR / "flights.parquet"
    if not parquet_p.exists():
        print("❌ flights.parquet missing")
        ok = False
    else:
        pdf = pd.read_parquet(parquet_p)
        expected = [
            "flight_id", "tail_hash", "size_class", "model", "origin", "dest",
            "is_international", "first_seen_utc", "last_seen_utc", "direction",
            "airport", "event_name", "day_offset"
        ]
        assert list(pdf.columns) == expected, f"Columns mismatch: {pdf.columns}"
        assert set(pdf["size_class"].unique()).issubset({"large", "super_mid", "mid", "light", "other"})
        assert set(pdf["direction"].unique()).issubset({"arrival", "departure"})
        print(f"✓ flights.parquet verified: {len(pdf)} rows matching contract schema exactly")

    # 5. daily_counts.csv
    counts_p = PROCESSED_DIR / "daily_counts.csv"
    if not counts_p.exists():
        print("❌ daily_counts.csv missing")
        ok = False
    else:
        cdf = pd.read_csv(counts_p)
        expected = ["date", "airport", "arrivals", "departures", "arr_light", "arr_mid", "arr_super_mid", "arr_large", "arr_other", "event_name", "day_offset"]
        assert list(cdf.columns) == expected, f"daily_counts columns mismatch: {cdf.columns}"
        print(f"✓ daily_counts.csv verified: {len(cdf)} airport-days")

    print("--- All Data Contracts Validated Successfully ---\n")
    return ok


def main():
    p = argparse.ArgumentParser(description="Role 1 Data Processing Pipeline")
    p.add_argument("--verify", action="store_true", help="Only verify processed data contracts")
    args = p.parse_args()

    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

    if args.verify:
        verify_processed_data()
        return

    # Real OpenSky pull (make fetch) wins; otherwise the calibrated reconstruction, labelled as such.
    real = len(list(OPENSKY_RAW_DIR.glob("KVNY_arrival_*.csv"))) >= 5
    if real:
        print("Step 1: Using real OpenSky pull in data/raw/opensky")
        raw_dir, flights_dir, registry, source = RAW_DIR, "opensky", "icao24_aircraft.csv", "opensky_2022_shifted"
    else:
        print("Step 1: No OpenSky pull found; reconstructing the 2022 week from published counts")
        raw_dir, flights_dir, registry, source = RAW_DIR / "reconstruction", "flights", "fleet.csv", "reconstructed_2022"
        reconstruct_week(raw_dir)

    print("\nStep 2: Building replay_2027.jsonl...")
    replay_file = PROCESSED_DIR / "replay_2027.jsonl"
    build_replay(raw_dir, replay_file, flights_dir, registry, source)

    print("\nStep 3: Building stands.json...")
    stands_file = PROCESSED_DIR / "stands.json"
    build_stands(stands_file)

    print("\nStep 4: Building bookings.json...")
    bookings_file = PROCESSED_DIR / "bookings.json"
    build_bookings(replay_file, bookings_file)

    print("\nStep 5: Building flights.parquet & daily_counts.csv...")
    parquet_file = PROCESSED_DIR / "flights.parquet"
    counts_file = PROCESSED_DIR / "daily_counts.csv"
    build_flights_parquet_and_daily_counts(raw_dir / flights_dir, raw_dir / registry, parquet_file, counts_file)

    print("\nStep 6: Verifying contracts...")
    verify_processed_data()


if __name__ == "__main__":
    main()
