"""Alternates ranker for a disrupted inbound flight. Option cards for the operator's dispatcher only.

Hard filters first:
- longest open runway (OurAirports runways.csv) at least the planning minimum for the size class;
- customs available for an international arrival (an airport marked "no" is dropped; "verify" stays, flagged);
- parking open: a partner FBO that has told us it is full is dropped (ad hoc parking stays, with a penalty).
Then a weighted score: extra drive minutes to the party's hotel zone, distance from VNY, parking and customs risk.
RAMPCAST never picks the airport: the operator's dispatcher and the pilot in command decide.
"""
from __future__ import annotations

import csv
import functools

from rampcast_server import config as C
from rampcast_server.data import KVNY, Flight, great_circle_nm

from .common import A, airport_ll, drive_minutes

RUNWAYS_CSV = C.ROOT / "data" / "reference" / "ourairports_runways.csv"
W_DRIVE, W_DIST, W_AD_HOC, W_CUSTOMS_VERIFY, BASE = 1.0, 0.25, 25.0, 30.0, 8.0


@functools.lru_cache(maxsize=1)
def longest_runways() -> dict[str, int]:
    """ICAO -> longest open runway in feet, from OurAirports. Empty if the file has not been fetched."""
    if not RUNWAYS_CSV.exists():
        return {}
    out: dict[str, int] = {}
    with open(RUNWAYS_CSV) as f:
        for row in csv.DictReader(f):
            if row.get("closed") == "1" or not row.get("length_ft"):
                continue
            out[row["airport_ident"]] = max(out.get(row["airport_ident"], 0), int(float(row["length_ft"])))
    return out


def runway_ft(icao: str) -> tuple[int, str]:
    """Longest open runway and where the number came from."""
    rw = longest_runways()
    if icao in rw:
        return rw[icao], "OurAirports"
    return int(A()["alternates"][icao]["runway_ft"]), "assumptions.yaml"


def alternates(f: Flight, zone: str, delay_min: int, partners_full: set[str] | None = None) -> list[dict]:
    a = A()
    partners_full = partners_full or set()
    need = a["runway_needed_ft"].get(f.size_class, 5000)
    base_drive = drive_minutes("KVNY", zone)
    opts = [{"airport": "KVNY", "name": "Hold for Van Nuys", "expected_delay_min": delay_min,
             "extra_drive_min": 0, "customs": "yes" if f.is_international else "n/a", "parking": "own stand held",
             "score": delay_min, "notes": ["Stand held for 90 min", "Pilot and ATC decide holding"]}]
    for icao, alt in a["alternates"].items():
        length, src = runway_ft(icao)
        if length < need:
            continue
        customs = alt["customs"]
        if f.is_international and customs == "no":
            continue
        if alt["partner_parking"] and icao in partners_full:
            continue
        extra = drive_minutes(icao, zone) - base_drive
        dist = great_circle_nm(*KVNY, *airport_ll(icao))
        score = (BASE + W_DRIVE * max(0, extra) + W_DIST * dist + (0 if alt["partner_parking"] else W_AD_HOC)
                 + (W_CUSTOMS_VERIFY if f.is_international and customs == "verify" else 0))
        notes = [f"Runway {length:,} ft ({src}; need {need:,} ft for {f.size_class.replace('_', '-')})"]
        if f.is_international:
            notes.append("Customs available" if customs == "yes" else "Customs availability must be verified")
        notes.append("Partner FBO parking" if alt["partner_parking"] else "No partner parking agreement")
        opts.append({"airport": icao, "name": alt["name"], "expected_delay_min": 0, "extra_drive_min": extra,
                     "customs": customs if f.is_international else "n/a", "runway_ft": length,
                     "parking": "partner FBO" if alt["partner_parking"] else "ad hoc", "score": round(score, 1),
                     "notes": notes})
    opts.sort(key=lambda o: o["score"])
    return opts[:4]
