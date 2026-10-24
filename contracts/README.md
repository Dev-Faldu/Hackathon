# RAMPCAST contracts

Every role reads this file first. Files and API responses must match these shapes exactly.
To change a contract, agree on it in the team chat first. Then update this file and the pydantic models in the same PR.

Conventions:
- Times are ISO 8601. `_utc` fields end in `Z`. `_local` fields are America/Los_Angeles with offset.
- Size classes are `light`, `mid`, `super_mid`, `large` or `other`.
- Large-cabin equivalents (parking footprint) are light 0.4, mid 0.6, super_mid 0.8, large 1.0, other 0.6.
- Scenarios are `low`, `medium` or `high`.
- No passenger names, phone numbers, owner names or raw tail numbers appear anywhere.

---

## Files (`data/processed/`, produced by Role 1)

### `flights.parquet`, one row per flight touching an LA-basin airport

| column | type | example | notes |
|---|---|---|---|
| flight_id | string | `F2022021112KVNY0042` | stable, unique |
| tail_hash | string | `9f2c4e1a0b7d3c55` | SHA-256 of icao24, first 16 hex |
| size_class | string | `large` | from FAA registry join |
| model | string | `GULFSTREAM G650` | |
| origin | string | `KTEB` | ICAO, may be null |
| dest | string | `KVNY` | ICAO, may be null |
| is_international | bool | `false` | origin outside US |
| first_seen_utc | timestamp | `2022-02-11T15:02:00Z` | |
| last_seen_utc | timestamp | `2022-02-11T20:31:00Z` | landing proxy for arrivals |
| direction | string | `arrival` | `arrival` or `departure` relative to `airport` |
| airport | string | `KVNY` | the basin airport this row is about |
| event_name | string | `SB_LVI_2022` | null for ordinary weeks |
| day_offset | int | `-2` | days relative to game day, null for ordinary weeks |

### `daily_counts.csv`

`date, airport, arrivals, departures, arr_light, arr_mid, arr_super_mid, arr_large, arr_other, event_name, day_offset`

### `replay_2027.jsonl`: one JSON event per line, sorted by `t_utc`

2022 times are shifted +1827 days (261 weeks), so Sun 2022-02-13 maps to Sun 2027-02-14.

```json
{"t_utc":"2027-02-12T20:31:00Z","flight_id":"F2022021112KVNY0042","event":"landed","airport":"KVNY","origin":"KTEB","size_class":"large","is_international":false,"source":"opensky_2022_shifted"}
```

`event` is one of `departed_origin`, `landed` or `departed_vny`. Map paths between events are great-circle interpolations and must be labelled "interpolated" in the UI.

### `bookings.json`: synthetic, one per replayed KVNY arrival at our FBO

```json
{"booking_code":"RC-7F3K","flight_id":"F2022021112KVNY0042","party_size":6,"commitment_type":"fixed_time","deadline_local":"2027-02-12T15:30:00-08:00","hotel_zone":"Beverly Hills","synthetic":true}
```

`commitment_type` is one of `fixed_time`, `medical_access` or `none`. `deadline_local` is null unless the type is `fixed_time`.
`hotel_zone` is one of `Beverly Hills`, `Santa Monica`, `Downtown LA`, `Inglewood` or `Burbank`.

### `stands.json`

```json
{"fbo":"Sepulveda Jet Center (fictional)","airport":"KVNY","capacity_large_equiv":48,
 "stands":[{"stand_id":"A1","row":"A","depth":1,"max_wingspan_ft":100}]}
```

Depth 1 faces the taxi lane. A jet at depth k+1 cannot leave until the jet at depth k has left.

---

## API (FastAPI, JSON)

### `GET /forecast?scenario=medium` (Role 2)

```json
{"scenario":"medium","airport":"KVNY","days":[{"date":"2027-02-12","baseline_p50":24,"p10":61,"p50":82,"p90":104}],
 "validation":{"event_held_out":"SB_LVI_2022","mape_pct":null,"interval_coverage_pct":null}}
```

### `GET /ramp/occupancy?scenario=medium` (Role 2)

```json
{"scenario":"medium","capacity":48,"hours":[{"t_local":"2027-02-12T14:00:00-08:00","p50":51.2,"p90":63.0,"p_over_capacity":0.71}]}
```

### `POST /plan/strategies` (Role 3)

Request: `{"scenario":"medium","modifiers":{}}`

```json
{"strategies":[{"id":"A","name":"Cap overnight + drop-and-go",
  "kpis":{"aircraft_accommodated":231,"hours_over_capacity":0,"empty_legs":44,"co2_t":38.6,"peak_line_staff":14,"fuel_gal_week":233200,"risk":"medium"},
  "approvers":["FBO general manager"],
  "assumptions":["assumptions.yaml#empty_leg_nm"],
  "explanation_facts":[{"id":"A.kpis.empty_legs","text":"44 empty repositioning legs"}]}]}
```

Exactly three strategies, `A`, `B` and `C`. C always lists `["FBO general manager","Airport operations","FAA"]` as approvers.

### `GET /priority/queue?t=2027-02-12T13:10:00-08:00` (Role 3)

```json
{"weights":{"fixed_time":0.4,"medical_access":0.3,"hard_deadline":0.2,"wait":0.1},
 "items":[{"booking_code":"RC-7F3K","rank":1,"score":0.91,"slack_min":40,
   "reasons":["Must reach Inglewood by 15:30; 40 min of slack after expected drive time"]}]}
```

The scorer's input model must not contain name, status, tier, loyalty or payment fields. A test enforces this.

### `GET /alerts?t=...` (Role 3)

```json
{"alerts":[{"id":"AL-0193","severity":"high","kind":"customs_window",
  "message":"JET-04 P90 arrival 14:39 is after VNY customs closes at 14:30",
  "recommended_action":"Draft a customs extension request for review","owner_role":"Customer service"}]}
```

`severity` is one of `info`, `watch` or `high`. `kind` is one of `ramp_capacity`, `customs_window`, `curfew`, `car_wrong_airport` or `runway`.

### `POST /whatif` (Role 3)

Request: `{"scenario":"medium","modifiers":{"runway_closed":{"from":"2027-02-12T13:05:00-08:00","to":"2027-02-12T13:55:00-08:00"},"demand_multiplier":1.0,"customs_hours":null}}`

Response: `{"kpi_diff":{"A":{"hours_over_capacity":[0,3]}},"new_alerts":[...],"strategies":[...]}`, where each pair is `[before, after]`.

### `GET /briefing?t=...` and `POST /explain` (Role 3)

```json
{"text":"Friday peak: medium scenario puts the ramp at 107% from 13:00 to 17:00 (A.kpis...).","cited_ids":["A.kpis.hours_over_capacity"],"model":"claude-opus-5-5","fallback":false}
```

### `POST /bookings/quote` and `POST /bookings/inbound` (booking desk)

Request (trip-sheet fields; give `aircraft_type` as an ICAO designator or `size_class`):
`{"aircraft_type":"CL35","tail":"N350RC","origin":"KTEB","international":false,"arrive_local":"2027-02-10T16:00","depart_local":"2027-02-11T10:00","services":["Fuel","GPU"],"channel":"FlightBridge"}`

Response: `{"decision":"confirmed|approval|full","position":{...}|null,"price_usd":700,"hold_expires_local":"...","checks":[{"ok":true,"label":"Ramp space","detail":"..."}],"alternatives":[...],"trip_sheet":{...},"answer_ms":0.6}`.
`/bookings/inbound` is the open endpoint for schedulers and trip-services tools; same answer plus `received_via`.
`POST /bookings/accept` with `{"trip_sheet":{...}}` confirms, logs to the audit trail and returns the trip sheet to send back.

### `GET /bookings/inbox?t=...` and `GET /bookings/connections`

Inbox: every request received by `t` from every channel, each with `status` (`auto` or `look`), `issues` and `notes`. Requests are rebuilt from the replay week; channel mix, lead times, duplicates and aircraft swaps are assumptions (`bookings` in `assumptions.yaml`).

### Parking layouts

Every parking route takes `layout=stands` (48 marked stands) or `layout=tandem` (game-day packing; slot ids like `B3-2` = row B, column 3, second in the column; `H1`–`H6` hot spots; `T*` temp zone; `P*` overflow pad). Tows carry `kind` (`arrival` or `departure`) and `for_flight_t`. Accepted bookings join the plan: `POST /bookings/accept` returns `flight_id` and `position`; `DELETE /bookings/accepted/{flight_id}` cancels.

### `GET /airfield/movements`

The other FBOs' business-jet visits at VNY in the replay (`id, size_class, landed, departed, origin`), so the 3D runway carries the whole field's traffic.

### Audit log (`logs/audit.jsonl`, Role 3)

```json
{"t_utc":"2027-02-12T21:10:04Z","actor_role":"FBO general manager","action":"approve","target":"strategy:A","note":""}
```
