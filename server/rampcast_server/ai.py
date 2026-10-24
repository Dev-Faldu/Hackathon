"""The RAMPCAST co-pilot: every model in one place, what it suggests right now, and how each one works.

Three things live here:
- `MODELS`: a model card for every algorithm the product runs (forecast, simulation, solvers, rules, ranking,
  language), with its inputs and where they come from, its method, how it was checked, and what it must never do.
- `recommendations(...)`: asks each model what needs doing at a replay time and ranks the answers by urgency.
- `benchmark(...)`: the three parking algorithms on the same week, measured the same way.

Nothing here acts. Each suggestion carries the numbers it used, the models behind it, and the person who approves.
"""
from __future__ import annotations

import csv
from datetime import datetime, timedelta

from . import config as C

# label: published (a cited figure), reconstructed (rebuilt from published counts), assumption (team choice),
# live (computed by the app from the week being run)
MODELS: list[dict] = [
    {
        "id": "forecast", "name": "Arrivals forecast", "family": "Forecasting", "owner": "Role 2 · forecasting",
        "question": "How many business jets come to our FBO each day of Super Bowl week, and how sure are we?",
        "automation": "suggests",
        "method": [
            "Baseline: mean ordinary-day KVNY arrivals for each weekday, times our FBO's share.",
            "Event uplift: the 2022 LA week's day-by-day shape, scaled so Thu-Sun matches the scenario level.",
            "Scenario levels from published Super Bowl ratios: low 1.5x (Las Vegas 2024), medium 1.75x, high 2.0x (Bay Area 2026).",
            "Spread: negative-binomial daily counts (variance 1.5x the mean) and a week-wide demand factor.",
        ],
        "inputs": [
            {"name": "KVNY ordinary days and event-week shape, 2022", "label": "reconstructed"},
            {"name": "WingX arrival ratios, Super Bowl LVIII and LX", "label": "published"},
            {"name": "Our FBO's share of KVNY arrivals (0.30)", "label": "assumption"},
        ],
        "outputs": ["P10 / P50 / P90 arrivals per day", "Baseline for an ordinary week"],
        "limits": ["Never accept, deny or rank a specific aircraft or customer", "Never promise a parking slot",
                   "No daily accuracy claim: the 2022 week is reconstructed, so a backtest on it would be circular"],
        "code": "rampcast/forecast/ (uplift.py, baseline.py)", "card": "rampcast/forecast/MODEL_CARD.md",
    },
    {
        "id": "ramp_mc", "name": "Ramp Monte Carlo", "family": "Simulation", "owner": "Role 2 · forecasting",
        "question": "Hour by hour, how full does the ramp get, and what is the chance it overflows?",
        "automation": "suggests",
        "method": [
            "5,000 simulated weeks (seed 61), each with its own demand level and daily arrivals.",
            "Each arrival gets an hour (damped during the game-day TFR), a size class and a stay: drop-and-go, through the game, or 1-2 nights.",
            "Occupancy counted in large-cabin equivalents (light 0.4 ... large 1.0) at the middle of every hour.",
            "P(over capacity) read against the capacity set on Event setup, so changing it updates the answer.",
        ],
        "inputs": [
            {"name": "Daily arrivals from the forecast", "label": "live"},
            {"name": "Hourly arrival profile and size mix, 2022", "label": "reconstructed"},
            {"name": "Drop-and-go share 0.30; 48% of stayers leave on game night", "label": "reconstructed"},
            {"name": "Ramp capacity, 48 large-cabin equivalents", "label": "assumption"},
        ],
        "outputs": ["P50 / P90 occupancy per hour", "P(over capacity) per hour"],
        "limits": ["A planning input: a person approves every plan", "Never sequence, hold or divert aircraft"],
        "code": "rampcast/forecast/ramp_sim.py",
    },
    {
        "id": "strategies", "name": "Strategy optimizer", "family": "Optimization", "owner": "Role 3 · decision engine",
        "question": "Which of three ways to handle the overflow keeps the most jets, the least CO2 and an achievable staff plan?",
        "automation": "human approves",
        "method": [
            "Builds three plans: A cap and send away, B cap and partner FBOs, C temporary taxiway stands plus partners.",
            "OR-Tools CP-SAT sends each overflow jet to a partner FBO within the spaces each partner holds (Whiteman 6, Burbank 8, Camarillo 12).",
            "Counts empty repositioning legs, CO2 at 9.75 kg per gallon (EPA), and line staff at the busiest hour.",
            "Suggests the safest plan that keeps the ramp under capacity; CO2 and staff break ties.",
        ],
        "inputs": [
            {"name": "Planning week for the chosen scenario", "label": "live"},
            {"name": "Partner spaces and distances", "label": "assumption"},
            {"name": "CO2 per gallon of Jet A (EPA)", "label": "published"},
        ],
        "outputs": ["Three plans with KPIs and who must approve each", "A suggested plan"],
        "limits": ["Strategy C needs FAA and airport operations approval", "Nothing happens until a person approves"],
        "code": "rampcast/engine/strategies.py",
    },
    {
        "id": "stand_default", "name": "Stand planner (adaptive)", "family": "Optimization", "owner": "RAMPCAST core",
        "question": "Where does each jet park so the fewest jets get boxed in?",
        "automation": "suggests",
        "method": [
            "Walks the week in time order. Each arrival goes where it is least likely to box anyone in, given who is parked right now and when they said they would leave.",
            "Short stays take the hot spots by the terminal; long stays go deep.",
            "Then a whole-week local search moves one jet at a time while tows keep dropping.",
            "Tows are counted from when jets really leave, not from when owners said they would.",
        ],
        "inputs": [
            {"name": "Every arrival and stated departure of the week", "label": "reconstructed"},
            {"name": "Departure drift (see the drift model)", "label": "assumption"},
            {"name": "Layout: 48 marked stands, or game-day tandem rows", "label": "assumption"},
        ],
        "outputs": ["A position for every jet", "Tow sheet with times and reasons", "A plain-language reason per placement"],
        "limits": ["The line supervisor approves every tow and marshals every aircraft"],
        "code": "server/rampcast_server/parking.py",
    },
    {
        "id": "stand_cpsat", "name": "Stand planner (exact, CP-SAT)", "family": "Optimization", "owner": "Role 3 · decision engine",
        "question": "If the whole week is planned up front, can every jet park with nobody boxed in?",
        "automation": "suggests",
        "method": [
            "OR-Tools CP-SAT, one day of arrivals at a time with earlier days fixed (deterministic).",
            "Hard rules: the wingspan fits, one jet per slot, and nobody is boxed in, with a margin of one drift sigma between jets in a column.",
            "Objective: keep every jet on our ramp, use hot spots for short stays, keep the temporary zone and pad for when needed, park long stays deep.",
            "A manual move or a confirmed booking re-solves only the jets it touches. When a planned slot is still taken on arrival, the jet is parked where it fits best.",
        ],
        "inputs": [
            {"name": "Every arrival and stated departure of the week", "label": "reconstructed"},
            {"name": "Drift margin 1.0 sigma, solver budget", "label": "assumption"},
        ],
        "outputs": ["A position for every jet", "Solver status per day"],
        "limits": ["A plan with no tows on paper still has some: owners leave off schedule",
                   "Takes seconds, not milliseconds: re-solves are incremental"],
        "code": "rampcast/engine/stands.py",
    },
    {
        "id": "drift", "name": "Departure drift", "family": "Simulation", "owner": "RAMPCAST core",
        "question": "How far do real departures drift from the time the owner gave?",
        "automation": "automatic",
        "method": [
            "Stated departure = actual departure plus a seeded Gaussian error.",
            "Spread: 3 h for stays over 20 h (owners leave when the party ends), 1 h for stays over 3 h, none for quick turns.",
            "Every planner sees only the stated time; tows are counted from the actual one.",
        ],
        "inputs": [{"name": "Spread by stay length", "label": "assumption"}],
        "outputs": ["Stated departure for every jet"],
        "limits": ["An assumption until a season of real schedule changes is logged"],
        "code": "server/rampcast_server/parking.py (_as_told)",
    },
    {
        "id": "booking", "name": "Instant booking desk", "family": "Rules + search", "owner": "RAMPCAST core",
        "question": "Can we say yes to this trip request right now, and on which slot?",
        "automation": "automatic",
        "method": [
            "Finds the best free slot in the live parking plan for the whole stay, with a 30 min buffer.",
            "Checks customs hours, the noise curfew and the ramp forecast for the stay.",
            "Confirms by itself when every check passes and the chance of an overfull ramp is low; otherwise a person looks.",
            "An accepted booking becomes a pinned jet in the same plan every screen uses.",
        ],
        "inputs": [
            {"name": "Live parking plan and ramp forecast", "label": "live"},
            {"name": "CBP KVNY customs hours, VNY curfew", "label": "published"},
            {"name": "Channel mix, lead times, duplicates", "label": "assumption"},
        ],
        "outputs": ["Yes with slot, price and hold; or alternatives", "One inbox for every channel"],
        "limits": ["Partner links (FlightBridge, schedulers) need credentials we do not have"],
        "code": "server/rampcast_server/bookings.py",
    },
    {
        "id": "priority", "name": "Priority queue", "family": "Ranking", "owner": "Role 3 · decision engine",
        "question": "When everyone lands at once, who gets the first car and the curb?",
        "automation": "suggests",
        "method": [
            "Scores each party on need only: fixed-time commitment 0.4, medical or access need 0.3, hard deadline 0.2, time waited 0.1.",
            "Weights are set by the manager on Event setup; every ranking lists its reasons.",
        ],
        "inputs": [{"name": "Bookings: commitments, access needs, ETAs", "label": "assumption"}],
        "outputs": ["Ranked queue with reasons"],
        "limits": ["Never ranks by wealth, status, tier or spend"],
        "code": "rampcast/engine/priority.py",
    },
    {
        "id": "alerts", "name": "Rules and alerts", "family": "Rules", "owner": "Role 3 · decision engine",
        "question": "What will go wrong in the next hours if nobody acts?",
        "automation": "automatic",
        "method": [
            "Checks every inbound and parked jet against customs hours (P90 arrival), the noise curfew, the game-day TFR and ramp capacity.",
            "Each alert names the action and the role that owns it.",
        ],
        "inputs": [
            {"name": "CBP KVNY customs hours; VNY noise ordinance", "label": "published"},
            {"name": "Game-day TFR window (2022 and 2026 precedent)", "label": "published"},
        ],
        "outputs": ["Alerts with severity, action and owner"],
        "limits": ["Drafts requests (for example a customs extension); a person sends them"],
        "code": "rampcast/engine/alerts.py",
    },
    {
        "id": "runway", "name": "Runway sequencing (3D)", "family": "Simulation", "owner": "RAMPCAST core",
        "question": "What does the airfield look like when every FBO's jets share one runway?",
        "automation": "automatic",
        "method": [
            "Arrivals at least 90 s apart and departures 2 min apart on runway 16R, for every FBO at VNY.",
            "Departures queue at the hold-short line; after the game they leave one every 2 minutes.",
            "Tows are choreographed: the front jet comes out first, waits on the lane, goes back.",
        ],
        "inputs": [{"name": "Separation minima", "label": "assumption"}, {"name": "The week's plan", "label": "live"}],
        "outputs": ["The 3D airfield and the simulated radio"],
        "limits": ["A visual simulation: ATC and pilots in command decide real sequencing"],
        "code": "app/src/three/layout.ts",
    },
    {
        "id": "explain", "name": "Explanations", "family": "Language", "owner": "Role 3 · decision engine",
        "question": "Why is this the suggestion, in plain words?",
        "automation": "suggests",
        "method": [
            "Every answer is built from fact ids the engine computed, and cites them.",
            "With an Anthropic API key, Claude writes the text from those facts only; without one, built-in templates do.",
        ],
        "inputs": [{"name": "Facts from the other models", "label": "live"}],
        "outputs": ["Briefings and answers with cited numbers"],
        "limits": ["Never adds a number the engine did not compute"],
        "code": "rampcast/engine/explain.py",
    },
]

MODEL_IDS = {m["id"] for m in MODELS}


def validation_summary() -> list[dict]:
    """Role 2's leave-one-event-out check and plausibility ranges (reports/validation_summary.csv)."""
    path = C.ROOT / "reports" / "validation_summary.csv"
    if not path.exists():
        return []
    with open(path) as f:
        return list(csv.DictReader(f))


def models(evidence: dict[str, list[dict]], status: dict[str, str]) -> dict:
    """Model cards with live evidence (numbers computed from the running week) and where each one runs."""
    out = []
    for m in MODELS:
        out.append({**m, "evidence": evidence.get(m["id"], []), "status": status.get(m["id"], "live")})
    return {"models": out, "validation": validation_summary(),
            "note": "Evidence is computed from the week the app is running: the 2022 Super Bowl week, reconstructed from "
                    "published counts and replayed in 2027. No model here takes an action; people approve."}


def forecast_evidence(fc: dict, occ: dict) -> tuple[list[dict], list[dict]]:
    days = fc.get("days", [])
    week, base = sum(d["p50"] for d in days), sum(d["baseline_p50"] for d in days)
    peak = max(days, key=lambda d: d["p50"]) if days else None
    hours = occ.get("hours", [])
    over = [h for h in hours if h["p_over_capacity"] >= 0.5]
    peak_h = max(hours, key=lambda h: h["p50"]) if hours else None
    loo = [r for r in validation_summary() if r["check"] == "leave_one_event_out" and r["metric"] == "arrivals_ratio"]
    model_err = [float(r["abs_pct_error"]) for r in loo if r["method"] == "analog_mean_leave_one_out"]
    naive_err = [float(r["abs_pct_error"]) for r in loo if r["method"] == "naive_ordinary_week"]
    f_ev = [{"label": "Arrivals this week (P50)", "value": week, "detail": f"vs {base} in an ordinary week"}]
    if peak:
        f_ev.append({"label": "Busiest day", "value": peak["p50"], "detail": f"{peak['date']} · P10-P90 {peak['p10']}-{peak['p90']}"})
    if model_err and naive_err:
        f_ev.append({"label": "Leave-one-event-out error", "value": round(sum(model_err) / len(model_err), 1), "unit": "%",
                     "detail": f"arrival ratio, vs {round(sum(naive_err) / len(naive_err), 1)}% for 'same as an ordinary week' (2 published events)"})
    f_ev.append({"label": "Model", "value": fc.get("model", "reference"), "detail": f"data: {fc.get('data_source', 'unknown')}"})
    r_ev = [{"label": "Simulated weeks", "value": occ.get("runs", 0), "detail": "Monte Carlo runs"},
            {"label": "Hours likely over capacity", "value": len(over), "detail": f"P(over) >= 50% against capacity {occ.get('capacity')}"}]
    if peak_h:
        r_ev.append({"label": "Fullest hour (P50)", "value": peak_h["p50"], "detail": f"{peak_h['t_local'][:16]} · P90 {peak_h['p90']}"})
    return f_ev, r_ev


def benchmark(rows: dict[str, dict], layout: str, temp: bool) -> dict:
    """The three parking algorithms on the same week, measured the same way (tows from real departures)."""
    names = {"first_come": "Whiteboard (first free slot)", "optimized": "Adaptive (RAMPCAST default)", "cpsat": "Exact solver (CP-SAT)"}
    out = []
    for method in ("first_come", "optimized", "cpsat"):
        m = rows.get(method)
        if not m:
            continue
        out.append({"method": method, "name": names[method], "tows": m["tows"], "overflow": m["overflow_aircraft"],
                    "boxed_in": m["boxed_in_events"], "pad": m.get("pad_uses", 0), "temp": m.get("temp_zone_uses", 0),
                    "hot": m["hot_spot_uses"], "solver": m.get("solver"), "solve_s": m.get("solve_s", 0)})
    ranked = sorted([r for r in out if r["method"] != "first_come"], key=lambda r: (r["overflow"], r["tows"]))
    best = ranked[0]["method"] if ranked else None
    base = next((r for r in out if r["method"] == "first_come"), None)
    return {"layout": layout, "temp_zone": temp, "rows": out, "best": best,
            "cut_vs_whiteboard_pct": round((1 - ranked[0]["tows"] / base["tows"]) * 100) if ranked and base and base["tows"] else None,
            "how": "Every method sees only the departure times owners gave; tows are counted from when jets really left. "
                   "Best = fewest jets turned away, then fewest tows."}


def _hhmm(iso: str) -> str:
    return iso[11:16]


def _day_hhmm(iso: str) -> str:
    return f"{C.parse_t(iso):%a} {iso[11:16]}"


def recommendations(t: datetime, *, briefing: dict, strategies: dict, approved: str | None, parking_now: dict,
                    plan_metrics: dict, temp_metrics: dict, bench: dict | None, alerts: list[dict], queue: dict,
                    inbox: dict, occ: dict, settings: dict, layout: str) -> list[dict]:
    """Every model's answer to 'what needs doing?', ranked: act now, then today, then this week."""
    recs: list[dict] = []
    t_iso = C.iso_local(t)

    # Tow sheet: the next three hours.
    tows = parking_now.get("tows_next_3h", [])
    if tows:
        first = tows[0]
        recs.append({
            "id": "tows", "urgency": "now", "score": 90,
            "title": f"Brief the tug crew: {len(tows)} tow{'s' if len(tows) != 1 else ''} in the next 3 hours",
            "why": [f"First at {_hhmm(first['t_local'])}: {first['reason']} ({first['flight_id']}, {first['from']})",
                    "Each tow needs a tug, a driver and a wing walker on each tip"],
            "numbers": [{"label": "Tows next 3 h", "value": len(tows)}],
            "models": ["stand_default", "drift"], "approver": "Line supervisor", "screen": "parking", "action": "Open the tow sheet"})

    # Alerts: customs, curfew, TFR, capacity. One suggestion per action, listing every jet it covers.
    groups: dict[str, list[dict]] = {}
    for a in alerts:
        if a.get("severity") == "high":
            groups.setdefault(a.get("recommended_action") or a["message"], []).append(a)
    for action, items in list(groups.items())[:3]:
        n = len(items)
        recs.append({
            "id": f"alert:{items[0]['kind']}:{items[0].get('flight_id', '')}", "urgency": "now", "score": 85 + min(n, 5),
            "title": action + (f" ({n} jets)" if n > 1 else ""),
            "why": [a["message"] for a in items[:3]] + ([f"and {n - 3} more"] if n > 3 else []),
            "numbers": [{"label": "Jets", "value": n}], "models": ["alerts"],
            "approver": items[0].get("owner_role", "FBO manager"), "screen": "live", "action": "See it in Live ops"})

    # Priority: who to serve first.
    items = queue.get("items", [])
    if items:
        top = items[0]
        recs.append({
            "id": "priority", "urgency": "now", "score": 70,
            "title": f"Serve {top.get('booking_code') or top['flight_id']} first at the curb",
            "why": top.get("reasons", [])[:2] + ["Need-based only: never by wealth, status or spend"],
            "numbers": [{"label": "In queue", "value": len(items)}],
            "models": ["priority"], "approver": "Customer service", "screen": "live", "action": "Open the queue"})

    # Ramp risk in the coming hours.
    ahead = [h for h in occ.get("hours", []) if h["t_local"] >= t_iso[:16] and h["p_over_capacity"] >= 0.5][:48]
    if ahead:
        run_end = ahead[0]
        for h in ahead[1:]:
            if (C.parse_t(h["t_local"]) - C.parse_t(run_end["t_local"])) > timedelta(hours=1):
                break
            run_end = h
        peak = max(ahead, key=lambda h: h["p_over_capacity"])
        soon = C.parse_t(ahead[0]["t_local"]) - t <= timedelta(hours=6)
        recs.append({
            "id": "ramp_risk", "urgency": "now" if soon else "today", "score": 75 if soon else 55,
            "title": f"Ramp likely full {_day_hhmm(ahead[0]['t_local'])} to {C.parse_t(run_end['t_local']) + timedelta(hours=1):%H:%M}",
            "why": [f"P(over capacity) peaks at {round(peak['p_over_capacity'] * 100)}% at {_hhmm(peak['t_local'])} (P90 {peak['p90']} of {occ.get('capacity')})",
                    "Hold overnight bookings for that window, and line up partner FBOs"],
            "numbers": [{"label": "Hours at risk", "value": len(ahead)}],
            "models": ["ramp_mc", "forecast"], "approver": "FBO manager", "screen": "plan", "action": "See the forecast"})

    # Bookings that need a person.
    if inbox.get("look"):
        issues = {k: v for k, v in inbox.get("by_issue", {}).items() if v}
        recs.append({
            "id": "inbox", "urgency": "today", "score": 60,
            "title": f"{inbox['look']} booking request{'s' if inbox['look'] != 1 else ''} need a person",
            "why": [f"{inbox['auto']} of {inbox['total']} were answered automatically",
                    "Waiting on: " + ", ".join(f"{v} {k}" for k, v in issues.items()) if issues else "Mostly changes since the first answer"],
            "numbers": [{"label": "Answered automatically", "value": round(inbox["auto"] / inbox["total"] * 100) if inbox.get("total") else 0, "unit": "%"}],
            "models": ["booking", "stand_default", "ramp_mc"], "approver": "Customer service", "screen": "bookings", "action": "Open the inbox"})

    # Strategy for the week.
    rec_id = briefing.get("recommended")
    card = next((c for c in strategies.get("strategies", []) if c["id"] == rec_id), None)
    if card and approved != rec_id:
        sq = strategies["status_quo"]["hours_over_capacity"]
        recs.append({
            "id": "strategy", "urgency": "this week", "score": 65,
            "title": f"Approve Strategy {card['id']}: {card['name']}",
            "why": [f"Hours over capacity {sq} h -> {card['kpis']['hours_over_capacity']} h; {card['kpis']['overflow_aircraft']} jets park elsewhere",
                    f"{card['kpis']['empty_legs']} empty legs, {card['kpis']['co2_t']} t CO2; needs {', '.join(card['approvers'])}"],
            "numbers": [{"label": "Hours over capacity", "value": card["kpis"]["hours_over_capacity"]}],
            "models": ["strategies", "forecast", "explain"], "approver": card["approvers"][0], "screen": "plan", "action": "Compare the three plans"})

    # Staffing at the busiest hour.
    staff = settings.get("staff_on_shift")
    if card and staff and card["kpis"]["peak_line_staff"] > staff:
        gap = card["kpis"]["peak_line_staff"] - staff
        recs.append({
            "id": "staff", "urgency": "this week", "score": 58,
            "title": f"Add {gap} line tech{'s' if gap != 1 else ''} for the peak hour",
            "why": [f"Strategy {card['id']} needs {card['kpis']['peak_line_staff']} at the busiest hour; {staff} are on shift (Event setup)"],
            "numbers": [{"label": "Short by", "value": gap}],
            "models": ["strategies"], "approver": "FBO manager", "screen": "setup", "action": "Adjust staffing"})

    # Temporary zone: measured on the parking plan, with and without.
    if temp_metrics and plan_metrics:
        saved_tows = plan_metrics["tows"] - temp_metrics["tows"]
        saved_over = plan_metrics["overflow_aircraft"] - temp_metrics["overflow_aircraft"]
        saved_pad = plan_metrics.get("pad_uses", 0) - temp_metrics.get("pad_uses", 0)
        if not plan_metrics["temp_zone"] and (saved_tows > 0 or saved_over > 0):
            recs.append({
                "id": "temp_zone", "urgency": "this week", "score": 50 + min(10, saved_over),
                "title": "Ask to open the temporary taxiway zone for game weekend",
                "why": [f"Same week, same planner: {saved_tows} fewer tows" + (f", {saved_over} fewer jets turned away" if saved_over > 0 else "")
                        + (f", {saved_pad} fewer on the overflow pad" if saved_pad > 0 else ""),
                        "Needs FAA and airport operations approval (Strategy C)"],
                "numbers": [{"label": "Tows saved", "value": saved_tows}],
                "models": ["stand_default", "strategies"], "approver": "FAA", "screen": "parking", "action": "Try it on Parking control"})

    # Which parking algorithm to trust for this layout, from the benchmark.
    if bench and bench.get("best") == "cpsat":
        rows = {r["method"]: r for r in bench["rows"]}
        d, c = rows.get("optimized"), rows.get("cpsat")
        if d and c and c["tows"] < d["tows"] and c["overflow"] <= d["overflow"]:
            recs.append({
                "id": "solver", "urgency": "this week", "score": 48,
                "title": f"Use the exact solver for this layout: {d['tows'] - c['tows']} fewer tows",
                "why": [f"CP-SAT {c['tows']} tows vs adaptive {d['tows']}, both with {c['overflow']} jets turned away",
                        f"Measured on this week ({layout}{', temp zone open' if bench['temp_zone'] else ''}), tows counted from real departures"],
                "numbers": [{"label": "Tows saved", "value": d["tows"] - c["tows"]}],
                "models": ["stand_cpsat", "stand_default", "drift"], "approver": "Line supervisor", "screen": "parking", "action": "Switch on Parking control"})

    rank = {"now": 0, "today": 1, "this week": 2}
    recs.sort(key=lambda r: (rank[r["urgency"]], -r["score"]))
    for r in recs:
        r["models"] = [m for m in r["models"] if m in MODEL_IDS]
    return recs
