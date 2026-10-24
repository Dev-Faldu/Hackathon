"""Stand planner (CP-SAT): wingspans fit, nobody boxed in, deterministic, incremental re-solve."""
from rampcast.engine import stands
from rampcast_server import parking
from rampcast_server.data import generate_sample

from factory import at, dataset, flight


def _week():
    ds = generate_sample("medium", seed=7)
    return ds, parking.positions(ds.stands, False)


def _check_hard_rules(ds, pos, assignment):
    by_id = {p.id: p for p in pos}
    by_f = {f.flight_id: f for f in ds.flights}
    for fid, pid in assignment.items():
        if pid:
            assert by_id[pid].max_wingspan_ft >= stands.span(by_f[fid]), f"{fid} does not fit {pid}"
    taken: dict[str, list] = {}
    for fid, pid in assignment.items():
        if pid:
            taken.setdefault(pid, []).append(by_f[fid])
    for pid, fs in taken.items():
        fs.sort(key=lambda f: f.landed)
        for a, b in zip(fs, fs[1:]):
            assert a.departed_vny <= b.landed, f"two jets on {pid} at once"


def test_plan_obeys_every_hard_rule():
    ds, pos = _week()
    sol = stands.solve(ds.flights, pos)
    assert sol.method.startswith("cp-sat")
    _check_hard_rules(ds, pos, sol.assignment)
    assert stands.violations(ds.flights, pos, sol.assignment) == []


def test_solver_beats_or_matches_the_greedy_start():
    ds, pos = _week()
    greedy = stands.greedy(ds.flights, pos)
    assert stands.solve(ds.flights, pos).overflow <= stands._count_over(ds.flights, greedy)


def test_same_input_same_plan():
    ds, pos = _week()
    assert stands.solve(ds.flights, pos).assignment == stands.solve(ds.flights, pos).assignment


def test_crossing_stays_never_share_a_column():
    # a lands first but also leaves first: whichever is deeper gets boxed in, so they must not share a column
    a = flight("A", at(1, 10), at(1, 18), size="light")
    b = flight("B", at(1, 12), at(1, 20), size="light")
    pos = [p for p in parking.positions(dataset([a, b]).stands, False) if p.row == "A" and p.column == 1]
    sol = stands.solve([a, b], pos)
    placed = [fid for fid, pid in sol.assignment.items() if pid]
    assert len(placed) == 1  # only one column available, so the other overflows rather than boxing anyone in


def test_nested_stay_parks_behind():
    long = flight("LONG", at(1, 8), at(2, 18), size="light")
    short = flight("SHORT", at(1, 12), at(1, 16), size="light")
    pos = [p for p in parking.positions(dataset([long, short]).stands, False) if p.row == "A" and p.column == 1]
    sol = stands.solve([long, short], pos)
    depth = {p.id: p.depth for p in pos}
    assert depth[sol.assignment["LONG"]] > depth[sol.assignment["SHORT"]]


def test_violations_finds_a_boxed_in_jet():
    back = flight("BACK", at(1, 12), at(1, 15), size="light")
    front = flight("FRONT", at(1, 10), at(1, 20), size="light")
    pos = parking.positions(dataset([back, front]).stands, False)
    v = stands.violations([back, front], pos, {"BACK": "A3", "FRONT": "A1"})
    assert v and v[0]["back"] == "BACK" and v[0]["front"] == "FRONT"


def test_pin_resolves_only_the_jets_it_touches():
    ds, pos = _week()
    base = stands.solve(ds.flights, pos)
    fid = next(f for f, p in base.assignment.items() if p and p.startswith("B"))
    sol = stands.resolve(ds.flights, pos, base.assignment, {fid}, {fid: "D1"})
    assert sol.assignment[fid] == "D1"
    pinned = next(f for f in ds.flights if f.flight_id == fid)
    for f in ds.flights:
        if not stands.overlap(f, pinned) and f.flight_id != fid:
            assert sol.assignment[f.flight_id] == base.assignment[f.flight_id]
    assert all(fid in (v["back"], v["front"]) for v in stands.violations(ds.flights, pos, sol.assignment))
