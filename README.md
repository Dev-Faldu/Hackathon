# RAMPCAST

**SpartHill Hacks 2026 · Track 01 "The Intelligent FBO" · Focus: Parking**

RAMPCAST is an AI ramp-capacity planner for a fictional FBO, *Sepulveda Jet Center*, at Van Nuys Airport (KVNY) during Super Bowl LXI week (Sun Feb 14 2027, SoFi Stadium). It forecasts parking demand, shows which hours the ramp overflows under low, medium and high demand, and drafts a plan (reservation caps, overflow partners, fuel and crews) that a human FBO manager approves.

Visual blueprint: [`docs/rampcast-blueprint.html`](docs/rampcast-blueprint.html)

## Why this angle

1. **LA already hosted this game.** Super Bowl LVI was played at SoFi in Feb 2022. That week is a real, labelled analog, so we can train on data before it, forecast it blind, and report real error.
2. **Parking is the binding constraint.** In 2022 the FAA ran an FBO **parking reservation program** (Feb 6–14) at LAX, HHR, VNY, BUR, LGB, SNA, ONT, SBD and SMO.
3. **The TFR pushes traffic to VNY.** The 2022 game-day TFR had a 10 nm core and a 30 nm ring. HHR (1.9 nm), LAX (3.5), SMO (6.7) and TOA (9.0) sit inside the core. VNY is at 17.1 nm.
4. **Overflow is an emissions problem.** Jets that can't park fly empty repositioning legs. Planning the ramp well cuts them, and the savings are measured in gallons and tonnes of CO₂.

## Real reference numbers

| Event | Figure | Source |
|---|---|---|
| LVI, LA 2022 | 1,400+ bizav flights in the days before; 501 arrivals on the Friday peak; 548 departures the Monday after | FlightAware / WingX via BJT |
| LX, Bay Area 2026 | 1,000+ arrivals over 4 days (~2× normal); ~600 Monday departures (~3×); OAK 32%, SFO 22%, SJC 22% | WingX via GlobalAir |
| LVIII, Las Vegas 2024 | 882 private planes | WingX via AP |

## Data

```bash
python data/scripts/fetch_opensky.py --preset analog     # LVI week, 11 LA-basin airports
python data/scripts/fetch_opensky.py --preset baseline   # ordinary Jan–Feb windows
python data/scripts/fetch_faa_registry.py                # icao24 -> model -> size class
```

- OpenSky REST API: free account; set `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` for higher limits. Tail IDs are hashed on save.
- FAA Releasable Aircraft Registry: used for size class, parking footprint and fuel uplift.
- FAA OPSNET daily counts are used to calibrate ADS-B coverage. Iowa Mesonet ASOS supplies weather.
- Aircraft in the FAA LADD program are excluded (privacy).

## Models

- **M1 Baseline:** seasonal forecast of ordinary-week arrivals, with P10–P90.
- **M2 Event uplift:** a multiplier curve by day relative to the game, built from real analogs (LVI–LX).
- **M3 Ramp simulator:** Monte Carlo of hourly occupancy, giving P(over capacity) per hour.
- **M4 Plan optimizer:** reservation caps, drop-and-go quota, nearest-partner overflow, fuel and crews.

## Human in command

The AI never decides whether a specific aircraft may land, park or depart, and never picks which customer gets the last spot. Movement authority stays with ATC and the pilot in command. Spot allocation stays with the FBO manager. Every plan line goes through an approve, edit or reject step with an audit log.
