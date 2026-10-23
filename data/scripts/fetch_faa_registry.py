"""Download the FAA Releasable Aircraft Registry and build an icao24 -> aircraft class lookup.

Usage: python data/scripts/fetch_faa_registry.py
Output: data/raw/icao24_aircraft.csv  (icao24, manufacturer, model, seats, size_class)

size_class drives parking footprint and fuel uplift in the ramp model.
"""
import csv
import io
import os
import urllib.request
import zipfile

URL = "https://registry.faa.gov/database/ReleasableAircraft.zip"
OUT = os.path.join(os.path.dirname(__file__), "..", "raw", "icao24_aircraft.csv")

# Keyword -> class, checked in order. Large-cabin = 1.0 parking spot (G450-equivalent).
CLASSES = [
    ("large", ["GVII", "G700", "G650", "GV", "G-V", "G550", "G500", "GIV", "G-IV", "G450", "GLOBAL", "BD-700",
               "FALCON 7X", "FALCON 8X", "FALCON 6X", "BBJ", "737", "ACJ"]),
    ("super_mid", ["CHALLENGER", "CL-600", "BD-100", "G280", "CITATION X", "750", "LONGITUDE", "PRAETOR 600",
                   "FALCON 2000", "FALCON 900", "LEGACY 600"]),
    ("mid", ["LEARJET", "HAWKER", "LATITUDE", "SOVEREIGN", "680", "PRAETOR 500", "LEGACY 450", "G150", "G200"]),
    ("light", ["PHENOM", "CITATION", "525", "560", "HONDAJET", "HA-420", "PC-12", "KING AIR", "PILATUS"]),
]


def size_class(model):
    m = model.upper()
    for cls, keys in CLASSES:
        if any(k in m for k in keys):
            return cls
    return "other"


def main():
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=300) as r:
        z = zipfile.ZipFile(io.BytesIO(r.read()))
    read = lambda name: csv.DictReader(io.TextIOWrapper(z.open(name), encoding="utf-8-sig"))
    ref = {row["CODE"].strip(): row for row in read("ACFTREF.txt")}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    n = 0
    with open(OUT, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["icao24", "manufacturer", "model", "seats", "size_class"])
        for row in read("MASTER.txt"):
            hexcode = (row.get("MODE S CODE HEX") or "").strip().lower()
            a = ref.get((row.get("MFR MDL CODE") or "").strip())
            if not hexcode or not a:
                continue
            model = a["MODEL"].strip()
            w.writerow([hexcode, a["MFR"].strip(), model, a["NO-SEATS"].strip(), size_class(model)])
            n += 1
    print(f"wrote {n} aircraft to {OUT}")


if __name__ == "__main__":
    main()
