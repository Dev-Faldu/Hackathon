"""Role 1 Data Contract Tests.

Validates that all files produced by Role 1 in data/processed/ adhere strictly
to the contracts and privacy safeguards defined in contracts/README.md.
"""
import json
import pandas as pd
import pytest
from rampcast_server import config as C
from rampcast_server.data import load_processed

PROCESSED = C.ROOT / "data" / "processed"
HOTEL_ZONES = {"Beverly Hills", "Santa Monica", "Downtown LA", "Inglewood", "Burbank"}
SIZE_CLASSES = {"large", "super_mid", "mid", "light", "other"}
ROW_SOURCES = ("reconstructed_2022", "opensky_2022_shifted", "synthetic")
OTHER_EVENTS = {"SB_LVIII_2024", "SB_LX_2026", "SB_LVII_2023"}
SOURCES = {"opensky_2022_shifted", "reconstructed_2022"}  # a real pull, or the calibrated reconstruction
BANNED_FIELDS = {"name", "passenger_name", "passenger", "vip", "tier", "payment", "price", "credit_card", "loyalty"}


def test_processed_files_exist():
    expected = [
        "flights.parquet",
        "daily_counts.csv",
        "replay_2027.jsonl",
        "bookings.json",
        "stands.json",
    ]
    for filename in expected:
        path = PROCESSED / filename
        assert path.exists(), f"Missing required Role 1 contract file: {filename}"
        assert path.stat().st_size > 0, f"Contract file is empty: {filename}"


def test_stands_contract():
    path = PROCESSED / "stands.json"
    data = json.loads(path.read_text())
    assert data["airport"] == "KVNY"
    assert data["capacity_large_equiv"] == 48
    assert "Sepulveda" in data["fbo"]
    stands = data["stands"]
    assert len(stands) == 48
    for s in stands:
        assert s["row"] in "ABCD"
        assert 1 <= s["depth"] <= 3
        assert s["max_wingspan_ft"] in (60, 80, 100, 110)
        assert s["stand_id"].startswith(s["row"])


def test_replay_contract():
    path = PROCESSED / "replay_2027.jsonl"
    lines = path.read_text().splitlines()
    assert len(lines) >= 100

    prev_t = None
    events = []
    for line in lines:
        e = json.loads(line)
        events.append(e)
        assert e["event"] in ("departed_origin", "landed", "departed_vny")
        assert e["airport"] == "KVNY"
        assert e["size_class"] in SIZE_CLASSES
        assert len(e["tail_hash"]) == 16, "tail_hash must be 16-hex SHA-256"
        assert e["source"] in SOURCES
        assert e["t_utc"].startswith("2027-"), f"Replay times must be shifted to 2027: {e['t_utc']}"

        # Check chronological ordering
        if prev_t is not None:
            assert e["t_utc"] >= prev_t, f"Events out of order: {prev_t} > {e['t_utc']}"
        prev_t = e["t_utc"]

        # Privacy safeguard
        assert not BANNED_FIELDS.intersection(e.keys()), f"Privacy violation in replay event: {e}"


def test_bookings_contract():
    path = PROCESSED / "bookings.json"
    bookings = json.loads(path.read_text())
    assert len(bookings) >= 50

    seen_codes = set()
    for b in bookings:
        code = b["booking_code"]
        assert code.startswith("RC-")
        assert code not in seen_codes, f"Duplicate booking code: {code}"
        seen_codes.add(code)

        assert 1 <= b["party_size"] <= 25
        assert b["commitment_type"] in ("fixed_time", "medical_access", "none")
        assert b["hotel_zone"] in HOTEL_ZONES
        assert b["synthetic"] is True

        if b["commitment_type"] == "fixed_time":
            assert b["deadline_local"] is not None
            assert "-08:00" in b["deadline_local"]
        else:
            assert b["deadline_local"] is None

        # Privacy safeguard
        assert not BANNED_FIELDS.intersection(b.keys()), f"Privacy violation in booking: {b}"


def test_flights_parquet_contract():
    path = PROCESSED / "flights.parquet"
    df = pd.read_parquet(path)
    expected_cols = [
        "flight_id", "tail_hash", "size_class", "model", "origin", "dest",
        "is_international", "first_seen_utc", "last_seen_utc", "direction",
        "airport", "event_name", "day_offset", "source"
    ]
    assert list(df.columns) == expected_cols

    assert len(df) > 500
    assert set(df["size_class"].unique()).issubset(SIZE_CLASSES)
    assert set(df["direction"].unique()) == {"arrival", "departure"}
    assert all(str(x).startswith(ROW_SOURCES) for x in df["source"].unique())
    # Rows from other host Super Bowls are generated, and say so
    assert (df[df["event_name"].isin(OTHER_EVENTS)]["source"] == "synthetic").all()

    # Check tail_hash format (16 hex chars)
    hashes = df["tail_hash"].dropna()
    assert all(len(h) == 16 for h in hashes)

    # Event annotations during Super Bowl week
    event_rows = df[df["event_name"] == "SB_LVI_2022"]
    assert len(event_rows) > 0
    assert all(-8 <= off <= 5 for off in event_rows["day_offset"].dropna())


def test_daily_counts_contract():
    path = PROCESSED / "daily_counts.csv"
    df = pd.read_csv(path)
    expected_cols = [
        "date", "airport", "arrivals", "departures",
        "arr_light", "arr_mid", "arr_super_mid", "arr_large", "arr_other",
        "event_name", "day_offset", "source"
    ]
    assert list(df.columns) == expected_cols
    assert all(str(x).startswith(ROW_SOURCES) for x in df["source"].unique())
    # Only the two days whose basin totals are published carry the anchor label, and nothing claims to be published
    anchors = df[df["source"].str.endswith("_anchor")]
    assert set(anchors["date"]) == {"2022-02-11", "2022-02-14"}
    assert not df["source"].str.startswith("published").any()

    # Ensure size class sums match total arrivals for tracked arrival days
    tracked = df[df["arrivals"].notna()]
    size_sum = tracked["arr_light"] + tracked["arr_mid"] + tracked["arr_super_mid"] + tracked["arr_large"] + tracked["arr_other"]
    assert (size_sum == tracked["arrivals"]).all(), "Sum of size classes must equal total arrivals"

    # Ensure the six untracked fake-zero days are marked missing (NaN), not 0
    fake_zero_dates = {"2022-01-22", "2022-01-23", "2022-01-24", "2022-02-16", "2022-02-17", "2022-02-18"}
    missing_days = df[df["date"].isin(fake_zero_dates)]
    assert missing_days["arrivals"].isna().all(), "Fake-zero days must be missing/NaN instead of 0"

    # Multiple airports represented
    airports = set(df["airport"].unique())
    assert {"KVNY", "KBUR", "KHHR", "KLGB", "KLAS", "KHND", "KSJC", "KOAK"} <= airports


def test_kvny_historical_and_uplift_datasets():
    # KVNY historical Jan-Mar across 2019, 2020, 2022-2026 (skipping 2021)
    k_path = PROCESSED / "kvny_historical_counts.csv"
    assert k_path.exists()
    kdf = pd.read_csv(k_path)
    years = set(pd.to_datetime(kdf["date"]).dt.year.unique())
    assert years == {2019, 2020, 2022, 2023, 2024, 2025, 2026}
    assert 2021 not in years
    assert (kdf["airport"] == "KVNY").all()
    assert (kdf["source"] == "synthetic").all(), "generated history must not pass as FAA counts"

    # Uplift dataset across multiple host Super Bowls
    u_path = PROCESSED / "super_bowl_uplifts.csv"
    assert u_path.exists()
    udf = pd.read_csv(u_path)
    assert set(udf["event_name"].unique()) == {"SB_LVIII_2024", "SB_LX_2026", "SB_LVII_2023"}
    assert all(udf["uplift_ratio"] > 0)
    assert (udf["source"] == "synthetic").all()


def test_load_processed_dataset_loader():
    ds = load_processed()
    assert ds is not None
    assert ds.source in SOURCES
    assert all(f.source == ds.source for f in ds.flights)
    assert len(ds.flights) > 0
    assert len(ds.bookings) > 0
    assert len(ds.stands) == 48

    # Ensure every flight has a valid booking
    for f in ds.flights:
        assert f.booking_code is not None
        assert f.booking_code in ds.bookings


def test_reconstruction_matches_published_anchors(tmp_path):
    """Without a real OpenSky pull the week is rebuilt from published 2022 counts; it must hit them."""
    import sys
    sys.path.insert(0, str(C.ROOT / "data" / "scripts"))
    import build_processed as bp
    r = bp.reconstruct_week(tmp_path)
    assert r["friday_arrivals"] == 501
    assert abs(r["monday_departures"] - bp.MONDAY_DEPARTURES_PUBLISHED) <= 0.05 * bp.MONDAY_DEPARTURES_PUBLISHED
