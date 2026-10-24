"""Loading Role 1's processed files: bad lines skipped, impossible times repaired, stands without columns."""
import json

from rampcast_server import config as C
from rampcast_server import data as D


def test_bad_replay_rows_are_repaired_and_reported(tmp_path, monkeypatch):
    rows = [
        {"t_utc": "2027-02-11T18:00:00Z", "event": "landed", "flight_id": "OK1", "airport": "KVNY", "size_class": "mid"},
        {"t_utc": "2027-02-12T18:00:00Z", "event": "departed_vny", "flight_id": "OK1", "airport": "KVNY", "size_class": "mid"},
        {"t_utc": "2027-02-11T20:00:00Z", "event": "landed", "flight_id": "BACKWARDS", "airport": "KVNY", "size_class": "jumbo"},
        {"t_utc": "2027-02-11T10:00:00Z", "event": "departed_vny", "flight_id": "BACKWARDS", "airport": "KVNY", "size_class": "jumbo"},
    ]
    text = "\n".join(json.dumps(r) for r in rows) + "\n{not json\n"
    (tmp_path / "replay_2027.jsonl").write_text(text)
    monkeypatch.setattr(C, "PROCESSED", tmp_path)
    monkeypatch.setitem(C.assumptions()["fbo"], "share_of_airport_arrivals", 1.0)
    ds = D.load_processed()
    by = {f.flight_id: f for f in ds.flights}
    assert by["BACKWARDS"].departed_vny > by["BACKWARDS"].landed
    assert by["BACKWARDS"].size_class == "other"
    note = " ".join(ds.notes)
    assert "1 bad lines" in note and "1 departure before landing" in note and "1 unknown size" in note


def test_stands_without_columns_get_three_deep_columns():
    stands = [{"stand_id": f"A{i}", "row": "A", "depth": (i - 1) % 3 + 1, "max_wingspan_ft": 100} for i in range(1, 7)]
    cols = [s["column"] for s in D.normalize_stands(stands)]
    assert cols == [1, 1, 1, 2, 2, 2]
