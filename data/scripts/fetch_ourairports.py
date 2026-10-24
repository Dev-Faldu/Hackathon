"""Runway lengths for LA-basin airports from OurAirports (public domain): https://ourairports.com/data/

Downloads runways.csv, keeps open, paved-or-not runways at the airports RAMPCAST may suggest as alternates,
and writes data/reference/ourairports_runways.csv. The engine reads the longest open runway per airport.

    python data/scripts/fetch_ourairports.py
"""
from __future__ import annotations

import csv
import io
import urllib.request
from pathlib import Path

URL = "https://davidmegginson.github.io/ourairports-data/runways.csv"
OUT = Path(__file__).resolve().parents[2] / "data" / "reference" / "ourairports_runways.csv"
AIRPORTS = {"KVNY", "KBUR", "KWHP", "KCMA", "KLGB", "KONT", "KLAX", "KSMO", "KTOA", "KHHR", "KSNA", "KOXR", "KPMD", "KSBD"}
KEEP = ["airport_ident", "le_ident", "he_ident", "length_ft", "width_ft", "surface", "lighted", "closed"]


def main() -> None:
    with urllib.request.urlopen(URL, timeout=60) as r:
        text = r.read().decode("utf-8")
    rows = [row for row in csv.DictReader(io.StringIO(text)) if row["airport_ident"] in AIRPORTS]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=KEEP)
        w.writeheader()
        for row in sorted(rows, key=lambda r: (r["airport_ident"], r["le_ident"])):
            w.writerow({k: row.get(k, "") for k in KEEP})
    print(f"wrote {len(rows)} runways for {len({r['airport_ident'] for r in rows})} airports to {OUT}")


if __name__ == "__main__":
    main()
