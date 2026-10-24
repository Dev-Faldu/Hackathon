# RAMPCAST forecast: model card

**Model:** `rampcast.forecast v1` (analog uplift + ramp Monte Carlo) · **Owner:** Role 2 (forecasting) · **Date:** 2026-10-24
**Serves:** `GET /forecast` and `GET /ramp/occupancy` through `server/rampcast_server/adapters.py`

## What it does

For Super Bowl LXI week (Tue 2027-02-09 to Mon 2027-02-15, game Sun 2027-02-14), it forecasts business-jet
arrivals per day at our fictional FBO (Sepulveda Jet Center, KVNY), and hourly ramp occupancy in large-cabin
equivalents with the probability that occupancy exceeds capacity, for low, medium and high demand.

## Intended use

A planning input for the FBO manager: how full the ramp may get, when, and how uncertain that is. It feeds the
strategy cards. A person approves every plan.

## Never use it to

- accept, deny, prioritise or rank a specific aircraft, operator or passenger;
- decide who gets the last stand, or assign stands;
- guarantee capacity or promise a parking slot;
- sequence, hold or divert aircraft (ATC and pilots in command decide);
- claim forecast accuracy: no daily accuracy has been measured (see Validation).

## Inputs and where they come from

| Input | Source | Status |
|---|---|---|
| KVNY ordinary-day arrivals, 2022-01-15..21 (one day per weekday) | `data/processed/daily_counts.csv` | **Reconstructed** by Role 1, not observed |
| KVNY event-week daily shape, 2022-02-08..14 | same file | **Reconstructed**. Only two LA-basin numbers are published: 501 arrivals on Fri 2022-02-11 and 548 departures on Mon 2022-02-14 |
| Hourly arrival profile; size-class mix | `data/processed/flights.parquet` (aggregates only) | **Reconstructed** |
| Drop-and-go share 0.30; 48% of stayers leave on game night | arrival/departure pairing in `flights.parquet` | **Reconstructed** |
| Scenario levels: Thu-Sun arrivals 1.5x / 1.75x / 2.0x normal | WingX via AIN (2024-02-13) and GlobalAir (2026) | **Published** |
| Our FBO's share of KVNY arrivals, 0.30 | `assumptions.yaml` `fbo` | Team assumption |
| Ramp capacity, 48 large-cabin equivalents | `assumptions.yaml`, editable on Event setup | Team assumption |
| Footprints: light 0.4, mid 0.6, super-mid 0.8, large 1.0, other 0.6 | `assumptions.yaml` `large_equiv_factor` | Assumption |
| Count dispersion 1.5, week-level sd 0.10, game-day TFR damping 0.35, 18 aircraft parked at the start, stay windows | `assumptions.yaml` `forecast` | Assumptions |

Privacy: `data_io.py` is the only module that reads data, and only aggregates leave it. No tail hash, flight id
or personal field reaches the forecast, the API or the reports.

## Method

1. **Baseline (M1).** Mean ordinary-day arrivals at KVNY for each weekday, times our FBO share and a 2027 traffic
   level (1.0). The only Monday available is MLK Day; the window's Monday is Presidents' Day, so the holiday effect
   is consistent but cannot be estimated separately.
2. **Event uplift (M2).** The day-to-day shape is the 2022 event week divided by the same-weekday baseline. Its
   excess over 1 is scaled so the Thu-Sun mean equals the scenario level: low = min of the published ratios (1.5,
   Las Vegas 2024), medium = mean (1.75), high = max (2.0, Bay Area 2026). The Monday after the game keeps the same
   multiplier (0.73) in every scenario.
3. **Ramp simulation (M3).** 5,000 simulated weeks (seed 61). Each week draws a week-wide demand factor
   (lognormal, sd 0.10), daily arrivals (negative binomial, variance 1.5x the mean), arrival hours (damped during
   the game-day TFR), size classes and stays: drop-and-go (55-120 min), stay through the game for non-drop-and-go
   arrivals from Thursday (leave Sunday 20:30-23:30 or Monday 07:00-14:00), or 1-2 nights otherwise. Occupancy is
   counted at the middle of each hour, in large-cabin equivalents and in aircraft.
4. **Capacity** is read when the API is called, so a change on Event setup updates `p_over_capacity`.

## Results

Daily arrivals at our FBO, P50 (P10-P90):

| Scenario | Tue 9 | Wed 10 | Thu 11 | Fri 12 | Sat 13 | Sun 14 | Mon 15 | Week |
|---|---|---|---|---|---|---|---|---|
| Ordinary week | 20 | 21 | 21 | 22 | 16 | 16 | 20 | 136 |
| Low | 22 (15-31) | 25 (18-35) | 30 (21-40) | 34 (24-45) | 28 (20-39) | 20 (13-28) | 14 (9-21) | 176 (147-208) |
| Medium | 24 (16-33) | 28 (20-38) | 34 (24-45) | 40 (29-51) | 35 (25-45) | 23 (15-31) | 14 (9-21) | 199 (166-234) |
| High | 25 (17-34) | 31 (21-41) | 38 (28-50) | 46 (34-59) | 40 (30-53) | 25 (17-34) | 14 (9-21) | 221 (186-259) |

Ramp occupancy against capacity 48: P50 peak 58.2 / 68.2 / 77.6 large-cabin equivalents (low / medium / high);
15 / 34 / 37 hours with at least a 50% chance of exceeding capacity. Charts: `reports/forecast_daily_by_scenario.png`,
`reports/occupancy_medium_vs_capacity.png`.

## Validation

**Not possible: a daily backtest.** Every file in `data/processed/` is `reconstructed_2022`. A daily MAPE against
it scores the model against the assumptions it was shaped on. The After-action screen currently shows such a
number (MAPE 12.2%, coverage 100%, computed in `server/rampcast_server/main.py`); it is circular and must not be
cited. `/forecast` returns `mape_pct: null` and says why in `validation_note`.

**1. Leave-one-event-out on the published ratios** (`reports/validation_summary.csv`). Each event's ratio is
predicted from the other events only. Two published events per metric, so each prediction uses one other event,
and "analog mean" equals "copy the previous host" whenever an earlier host exists.

| Metric | Held-out event | Actual | Analog prediction (error) | Ordinary-week rule 1.0 (error) |
|---|---|---|---|---|
| Thu-Sun arrivals ratio | Las Vegas 2024 | 1.5 | 2.0 (33%) | 1.0 (33%) |
| Thu-Sun arrivals ratio | Bay Area 2026 | 2.0 | 1.5 (25%) | 1.0 (50%) |
| Monday departures ratio | Los Angeles 2022 | 1.65 | 3.0 (82%) | 1.0 (39%) |
| Monday departures ratio | Bay Area 2026 | 3.0 | 1.65 (45%) | 1.0 (67%) |

Reading: the analog beats the ordinary-week rule in 2 of 4 cases and ties in 1. For Los Angeles 2022 the
ordinary-week rule was closer: relative surges do not transfer cleanly between regions, and LA is a larger, busier
basin, so its relative surge was smaller. Treat low and high as plausible bounds from two events, not as a
confidence interval.

**2. Plausibility against what single FBOs reported in 2022** (AIN informal poll, 2022-02-18).

| Check (medium) | Model P50 (P10-P90) | Reported | Result |
|---|---|---|---|
| Arrivals at our FBO over the week | 199 (166-234) | 70 (Castle & Cooke, KVNY) to 170 (Million Air, KBUR) | Above |
| Aircraft on our ramp at kickoff | 91 (73-110) | 45 (Million Air, KBUR) to 75 (Ross Aviation, KLGB) | Above |

The P50 would reach the top of the reported ranges at an FBO share of about 0.25-0.26. The team kept 0.30 on
2026-10-24 so every screen uses the same demand; this is the single largest lever on every number above.

## Limits

- The data is reconstructed; only two published LA-basin numbers anchor it.
- Two events per published metric, with different windows and denominators.
- The daily shape comes from one reconstructed week.
- The baseline has one day per weekday and no trend; 2027 traffic level is an assumption (1.0).
- Occupancy is in large-cabin equivalents; the Parking control screen counts physical stands. The team has not yet
  agreed on one capacity definition.
- The booking desk and the LA28 screen still call the reference `forecast.occupancy` directly
  (`main.py`, `la28.py`), so they do not use this model.

## Reproduce

From the repo root, with the server environment:

```bash
server/.venv/bin/python -m rampcast.forecast.build      # precompute all scenarios
server/.venv/bin/python -m rampcast.forecast.validate   # reports/ CSVs and charts
server/.venv/bin/python -m pytest -q rampcast/forecast/tests
```

## Real-data mode (P2, pending)

When Role 1 delivers real counts (`daily_counts.csv` with a `source` column and more years or host airports),
`data_io.data_source()` turns `real`. Then: widen `forecast.baseline_dates`, add host-airport daily counts per event,
and run a true leave-one-event-out daily backtest with no data from the held-out week in any fit.
