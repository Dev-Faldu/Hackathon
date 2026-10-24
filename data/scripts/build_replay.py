"""Turn raw OpenSky KVNY arrivals/departures into the replay file the API loads.

Usage (after fetch_opensky.py --preset analog and fetch_faa_registry.py):
    python data/scripts/build_replay.py
Output: data/processed/replay_2027.jsonl, the Super Bowl LVI week (Feb 2022) shifted +1827 days so
Sun 2022-02-13 lands on Sun 2027-02-14. Format: contracts/README.md. Only hashed tails are written.
"""
import argparse
import csv
import datetime as dt
import glob
import json
import os

HERE = os.path.dirname(__file__)
RAW = os.path.join(HERE, "..", "raw")
OUT = os.path.join(HERE, "..", "processed", "replay_2027.jsonl")
SHIFT = dt.timedelta(days=1827)
# Planning window Tue 9 - Mon 15 Feb 2027 is Tue 8 - Mon 14 Feb 2022; keep 3 days before for jets already parked.
FIRST, LAST = dt.date(2022, 2, 5), dt.date(2022, 2, 15)
US_PREFIXES = ("K", "P", "TJ")  # contiguous US, Alaska/Hawaii/Pacific, Puerto Rico


def read(pattern):
    rows = []
    for path in sorted(glob.glob(pattern)):
        day = dt.date.fromisoformat(os.path.basename(path).rsplit("_", 1)[1][:10])
        if FIRST <= day <= LAST:
            with open(path, newline="") as f:
                rows += [r for r in csv.DictReader(f) if r.get("first_seen") and r.get("last_seen")]
    return rows


def size_lookup(path):
    if not os.path.exists(path):
        return {}
    with open(path, newline="") as f:
        return {r["icao24"].lower(): r["size_class"] for r in csv.DictReader(f)}


def utc(ts):
    return dt.datetime.fromtimestamp(int(ts), tz=dt.timezone.utc)


def iso(t):
    return (t + SHIFT).strftime("%Y-%m-%dT%H:%M:%SZ")


def build(raw=RAW, out=OUT):
    sizes = size_lookup(os.path.join(raw, "icao24_aircraft.csv"))
    arrivals = sorted(read(os.path.join(raw, "opensky", "KVNY_arrival_*.csv")), key=lambda r: int(r["last_seen"]))
    departures = sorted(read(os.path.join(raw, "opensky", "KVNY_departure_*.csv")), key=lambda r: int(r["first_seen"]))
    deps_by_tail = {}
    for d in departures:
        deps_by_tail.setdefault(d["tail_hash"], []).append(d)
    events, seq = [], 0
    for a in arrivals:
        landed = utc(a["last_seen"])
        if landed.date() < FIRST:
            continue
        seq += 1
        fid = f"F{landed:%Y%m%d%H}KVNY{seq:04d}"
        origin = (a.get("dep") or "").strip() or None
        meta = {"flight_id": fid, "tail_hash": a["tail_hash"], "airport": "KVNY", "origin": origin,
                "size_class": sizes.get((a.get("icao24") or "").lower(), "other"),
                "is_international": bool(origin) and not origin.startswith(US_PREFIXES),
                "source": "opensky_2022_shifted"}
        events.append({"t_utc": iso(utc(a["first_seen"])), "event": "departed_origin", **meta})
        events.append({"t_utc": iso(landed), "event": "landed", **meta})
        # The same tail's next departure from VNY after it landed.
        nxt = next((d for d in deps_by_tail.get(a["tail_hash"], []) if utc(d["first_seen"]) > landed), None)
        if nxt:
            deps_by_tail[a["tail_hash"]].remove(nxt)
            events.append({"t_utc": iso(utc(nxt["first_seen"])), "event": "departed_vny", **meta})
    events.sort(key=lambda e: e["t_utc"])
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        for e in events:
            f.write(json.dumps(e) + "\n")
    print(f"wrote {seq} KVNY arrivals ({len(events)} events) to {out}")
    return seq


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--raw", default=RAW)
    p.add_argument("--out", default=OUT)
    a = p.parse_args()
    build(a.raw, a.out)
