"""Pull daily arrivals/departures for LA-basin airports from the OpenSky REST API.

Usage:
    export OPENSKY_CLIENT_ID=...  OPENSKY_CLIENT_SECRET=...   # optional, raises rate limits
    python data/scripts/fetch_opensky.py --start 2022-02-01 --end 2022-02-20
    python data/scripts/fetch_opensky.py --preset analog     # LVI week + ordinary Febs

Writes one CSV per airport/direction into data/raw/opensky/.
Only aggregate-safe fields are kept; the ICAO24 hex is SHA-256 hashed before saving.
"""
import argparse
import csv
import datetime as dt
import hashlib
import json
import os
import time
import urllib.parse
import urllib.request

API = "https://opensky-network.org/api"
TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"
AIRPORTS = ["KVNY", "KHHR", "KBUR", "KLGB", "KSMO", "KTOA", "KSNA", "KONT", "KCMA", "KWHP", "KLAX"]
OUT = os.path.join(os.path.dirname(__file__), "..", "raw", "opensky")

# Super Bowl LVI week at SoFi (labelled analog) plus ordinary Februaries for the baseline.
PRESETS = {
    "analog": [("2022-02-01", "2022-02-21")],
    "baseline": [(f"{y}-01-15", f"{y}-03-01") for y in (2019, 2021, 2023, 2024, 2025, 2026)],
}


def token():
    cid, secret = os.getenv("OPENSKY_CLIENT_ID"), os.getenv("OPENSKY_CLIENT_SECRET")
    if not (cid and secret):
        return None
    body = urllib.parse.urlencode(
        {"grant_type": "client_credentials", "client_id": cid, "client_secret": secret}
    ).encode()
    with urllib.request.urlopen(urllib.request.Request(TOKEN_URL, data=body)) as r:
        return json.load(r)["access_token"]


def get(path, params, tok):
    url = f"{API}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"} if tok else {})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:  # OpenSky returns 404 when there are no flights
                return []
            if e.code == 429:
                time.sleep(2 ** (attempt + 2))
                continue
            raise
    return []


def hash_tail(icao24):
    return hashlib.sha256((icao24 or "").lower().encode()).hexdigest()[:16]


def fetch(start, end, tok):
    os.makedirs(OUT, exist_ok=True)
    day = dt.datetime.fromisoformat(start).replace(tzinfo=dt.timezone.utc)
    stop = dt.datetime.fromisoformat(end).replace(tzinfo=dt.timezone.utc)
    while day < stop:
        b, e = int(day.timestamp()), int((day + dt.timedelta(days=1)).timestamp())
        for ap in AIRPORTS:
            for direction in ("arrival", "departure"):
                path = os.path.join(OUT, f"{ap}_{direction}_{day:%Y-%m-%d}.csv")
                if os.path.exists(path):
                    continue
                rows = get(f"/flights/{direction}", {"airport": ap, "begin": b, "end": e}, tok)
                with open(path, "w", newline="") as f:
                    w = csv.writer(f)
                    w.writerow(["tail_hash", "icao24", "callsign", "dep", "arr", "first_seen", "last_seen"])
                    for r in rows:
                        w.writerow([
                            hash_tail(r.get("icao24")), r.get("icao24"), (r.get("callsign") or "").strip(),
                            r.get("estDepartureAirport"), r.get("estArrivalAirport"),
                            r.get("firstSeen"), r.get("lastSeen"),
                        ])
                print(f"{ap} {direction} {day:%Y-%m-%d}: {len(rows)}")
                time.sleep(1)
        day += dt.timedelta(days=1)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--start")
    p.add_argument("--end")
    p.add_argument("--preset", choices=PRESETS)
    a = p.parse_args()
    tok = token()
    ranges = PRESETS[a.preset] if a.preset else [(a.start, a.end)]
    for s, e in ranges:
        fetch(s, e, tok)
