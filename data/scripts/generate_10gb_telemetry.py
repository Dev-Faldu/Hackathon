"""Generate 10 GB of synthetic ADS-B state vector telemetry.

Simulates high-frequency (1 Hz) ADS-B receiver telemetry for private aviation
movements touching KVNY, Southern California basin, Las Vegas, Bay Area, and Phoenix.

Output: data/raw/adsb_state_vectors_10gb.csv (approx 10.05 GB, ignored by git)
Columns follow the standard OpenSky Network state vector specification:
    time,icao24,tail_hash,flight_id,lat,lon,velocity_kts,heading_deg,vertrate_fpm,
    callsign,onground,alert,spi,squawk,baroaltitude_ft,geoaltitude_ft,lastposupdate,lastcontact
"""
from __future__ import annotations

import argparse
import hashlib
import os
import random
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
RAW_DIR = ROOT / "data" / "raw"
OUT_FILE = RAW_DIR / "adsb_state_vectors_10gb.csv"

# Target 10.05 GB (10,050,000,000 bytes)
TARGET_BYTES = 10_050_000_000

# Flight Waypoint Centers
CORRIDORS = [
    # (Center Name, Lat, Lon, Alt Min, Alt Max, Base Heading)
    ("KVNY Approach / Valley", 34.2098, -118.4900, 800, 7500, 165.0),
    ("SoFi / LAX Basin Corridor", 33.9535, -118.3392, 1500, 12000, 250.0),
    ("Burbank / Pass Corridor", 34.2007, -118.3585, 1200, 8500, 150.0),
    ("Long Beach / South Bay", 33.8177, -118.1516, 1000, 9000, 260.0),
    ("Las Vegas Valley (KLAS/KHND)", 36.0840, -115.1522, 2200, 14000, 190.0),
    ("Bay Area Approach (KSJC/KOAK)", 37.3630, -121.9290, 1000, 11000, 310.0),
    ("Scottsdale / Phoenix Corridor", 33.6230, -111.9110, 1500, 12000, 210.0),
]

CALLSIGN_PREFIXES = ["EJA", "LXJ", "XOJ", "FBO", "N", "VNY", "SBX"]


def generate_10gb(target_bytes: int = TARGET_BYTES, out_path: Path = OUT_FILE) -> int:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"Generating synthetic telemetry to: {out_path}")
    print(f"Target size: {target_bytes / (1024**3):.2f} GiB ({target_bytes:,} bytes)")

    header = (
        "time,icao24,tail_hash,flight_id,lat,lon,velocity_kts,heading_deg,vertrate_fpm,"
        "callsign,onground,alert,spi,squawk,baroaltitude_ft,geoaltitude_ft,lastposupdate,lastcontact\n"
    )

    t0 = time.time()
    rng = random.Random(2027)

    # Pre-generate 100 trajectories
    trajectories = []
    base_ts = 1644537600  # Feb 11, 2022
    for i in range(120):
        corridor = CORRIDORS[i % len(CORRIDORS)]
        icao = f"{0xA00000 + i:06x}"
        th = hashlib.sha256(icao.encode()).hexdigest()[:16]
        fid = f"F20220211{i:04d}"
        cs = f"{rng.choice(CALLSIGN_PREFIXES)}{rng.randint(100, 999)}"
        trajectories.append({
            "icao": icao,
            "th": th,
            "fid": fid,
            "cs": cs,
            "lat": corridor[1] + rng.uniform(-0.15, 0.15),
            "lon": corridor[2] + rng.uniform(-0.15, 0.15),
            "alt": rng.randint(corridor[3], corridor[4]),
            "spd": rng.uniform(140.0, 320.0),
            "hdg": (corridor[5] + rng.uniform(-20, 20)) % 360,
            "vr": rng.choice([-800, -500, 0, 0, 0, 700, 1200]),
            "squawk": f"{rng.randint(1000, 7700):04d}",
        })

    bytes_written = 0
    batch_lines = []
    batch_count = 60000

    with open(out_path, "wb") as f:
        f.write(header.encode("utf-8"))
        bytes_written += len(header)

        sim_time = base_ts
        report_interval = 1_000_000_000  # Report every ~1 GB
        next_report = report_interval

        while bytes_written < target_bytes:
            batch_lines.clear()
            for _ in range(batch_count):
                sim_time += 1
                t = trajectories[rng.randint(0, len(trajectories) - 1)]

                # Step simulation
                t["lat"] += rng.uniform(-0.0008, 0.0008)
                t["lon"] += rng.uniform(-0.0008, 0.0008)
                t["alt"] = max(0, min(45000, t["alt"] + int(t["vr"] / 60)))
                t["spd"] = max(90.0, min(520.0, t["spd"] + rng.uniform(-1.5, 1.5)))
                t["hdg"] = (t["hdg"] + rng.uniform(-1.0, 1.0)) % 360
                onground = "true" if t["alt"] < 100 else "false"

                row = (
                    f"{sim_time},{t['icao']},{t['th']},{t['fid']},"
                    f"{t['lat']:.5f},{t['lon']:.5f},{t['spd']:.1f},{t['hdg']:.1f},{t['vr']},"
                    f"{t['cs']},{onground},false,false,{t['squawk']},{t['alt']},{t['alt'] + 40},"
                    f"{sim_time - 1},{sim_time}\n"
                )
                batch_lines.append(row)

            chunk = "".join(batch_lines).encode("utf-8")
            f.write(chunk)
            bytes_written += len(chunk)

            if bytes_written >= next_report:
                elapsed = time.time() - t0
                rate = (bytes_written / (1024 * 1024)) / elapsed if elapsed > 0 else 0
                pct = (bytes_written / target_bytes) * 100
                print(f"Progress: {bytes_written / (1024**3):.2f} / {target_bytes / (1024**3):.2f} GiB ({pct:.1f}%) "
                      f"- {rate:.1f} MB/s - {elapsed:.1f}s elapsed")
                next_report += report_interval

    total_time = time.time() - t0
    final_gb = bytes_written / (1024**3)
    final_mb_s = (bytes_written / (1024 * 1024)) / total_time
    print(f"\n✓ Completed: Wrote {final_gb:.2f} GiB ({bytes_written:,} bytes) in {total_time:.1f}s ({final_mb_s:.1f} MB/s)")
    print(f"File saved at: {out_path}")
    return bytes_written


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Generate 10 GB ADS-B synthetic telemetry dataset")
    p.add_argument("--bytes", type=int, default=TARGET_BYTES, help="Target file size in bytes")
    p.add_argument("--out", type=Path, default=OUT_FILE, help="Output file path")
    args = p.parse_args()

    generate_10gb(args.bytes, args.out)
