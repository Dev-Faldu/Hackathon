"""Flights, bookings and stands for our FBO.

Two sources, same shapes:
- "opensky_2022_shifted": data/processed/ from the data pipeline (real Super Bowl LVI week, shifted to 2027).
- "sample": a seeded generator shaped by public analog figures, used until the processed files exist.
Every record carries its source so the UI can label it.
"""
from __future__ import annotations

import hashlib
import json
import math
import string
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta

import numpy as np

from . import config as C

# Ordinary-week arrivals per day at our FBO, Tue..Mon (assumption, replaced by the baseline model).
BASE_ARRIVALS = [20, 21, 23, 24, 15, 14, 19]
# Super Bowl uplift by day for the medium scenario, Tue..Mon. Calibrated to public analogs: WingX measured
# ~2x normal February business-jet arrivals over the four days before Super Bowl LX (Bay Area, 2026), and the
# 2022 LA week peaked on Friday. Sunday arrivals are morning-heavy; Monday is a departure day.
MEDIUM_UPLIFT = [1.2, 1.45, 1.8, 2.1, 1.9, 1.25, 0.95]
SCENARIO_K = {"baseline": 0.0, "low": 0.55, "medium": 1.0, "high": 1.5}

HOUR_WEIGHTS = np.zeros(24)
for h, w in [(6, 2), (7, 4), (8, 6), (9, 8), (10, 10), (11, 11), (12, 11), (13, 10), (14, 10), (15, 9),
             (16, 8), (17, 6), (18, 4), (19, 3), (20, 2), (21, 1)]:
    HOUR_WEIGHTS[h] = w

SIZE_MIX = {"large": 0.35, "super_mid": 0.25, "mid": 0.22, "light": 0.18}

# (ICAO, name, lat, lon, weight, international)
ORIGINS = [
    ("KTEB", "Teterboro, NJ", 40.850, -74.061, 12, False),
    ("KHPN", "White Plains, NY", 41.067, -73.708, 5, False),
    ("KLAS", "Las Vegas", 36.084, -115.152, 10, False),
    ("KSJC", "San Jose", 37.363, -121.929, 6, False),
    ("KDAL", "Dallas Love", 32.847, -96.852, 7, False),
    ("KHOU", "Houston Hobby", 29.645, -95.279, 4, False),
    ("KOPF", "Miami Opa-locka", 25.907, -80.278, 6, False),
    ("KSDL", "Scottsdale", 33.623, -111.911, 7, False),
    ("KAPA", "Denver Centennial", 39.570, -104.849, 5, False),
    ("KAUS", "Austin", 30.194, -97.670, 4, False),
    ("KMDW", "Chicago Midway", 41.786, -87.752, 5, False),
    ("KBED", "Boston Hanscom", 42.470, -71.289, 3, False),
    ("KBFI", "Seattle Boeing Field", 47.530, -122.302, 4, False),
    ("KPDK", "Atlanta Peachtree", 33.875, -84.302, 4, False),
    ("KBNA", "Nashville", 36.124, -86.678, 3, False),
    ("KMSY", "New Orleans", 29.993, -90.258, 2, False),
    ("MMTO", "Toluca, Mexico", 19.337, -99.566, 3, True),
    ("CYYZ", "Toronto", 43.677, -79.631, 2, True),
    ("EGGW", "London Luton", 51.875, -0.368, 2, True),
    ("LFPB", "Paris Le Bourget", 48.969, 2.441, 1, True),
    ("MMSD", "Los Cabos", 23.152, -109.721, 2, True),
    ("CYVR", "Vancouver", 49.194, -123.184, 1, True),
]
ORIGIN_BY_ICAO = {o[0]: o for o in ORIGINS}
KVNY = (34.2098, -118.4900)

HOTEL_ZONES = {"Beverly Hills": 0.30, "Santa Monica": 0.22, "Downtown LA": 0.18, "Inglewood": 0.18, "Burbank": 0.12}
CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


@dataclass
class Flight:
    flight_id: str
    tail_hash: str
    size_class: str
    origin: str
    origin_name: str
    origin_lat: float
    origin_lon: float
    is_international: bool
    departed_origin: datetime
    landed: datetime
    departed_vny: datetime
    stay_type: str            # drop_and_go | overnight | through_game | pre_window
    source: str
    booking_code: str | None = None

    @property
    def footprint(self) -> float:
        return C.large_equiv(self.size_class)

    def to_dict(self) -> dict:
        d = asdict(self)
        for k in ("departed_origin", "landed", "departed_vny"):
            d[k] = C.iso_local(d[k])
        d["footprint"] = self.footprint
        return d


@dataclass
class Booking:
    booking_code: str
    flight_id: str
    party_size: int
    commitment_type: str      # fixed_time | medical_access | none
    deadline_local: datetime | None
    hotel_zone: str
    synthetic: bool = True

    def to_dict(self) -> dict:
        d = asdict(self)
        d["deadline_local"] = C.iso_local(self.deadline_local) if self.deadline_local else None
        return d


@dataclass
class Dataset:
    source: str
    scenario: str
    flights: list[Flight]
    bookings: dict[str, Booking]
    stands: list[dict]
    notes: list[str] = field(default_factory=list)


def great_circle_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 3440.065
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def default_stands() -> list[dict]:
    """48 stands: rows A-D, 12 per row, depth 1-3 (depth 1 faces the taxi lane)."""
    spans = [110, 100, 80, 100, 80, 60, 100, 80, 60, 110, 100, 80]
    stands = []
    for row in "ABCD":
        for n in range(1, 13):
            stands.append({"stand_id": f"{row}{n}", "row": row, "column": (n - 1) // 3 + 1,
                           "depth": (n - 1) % 3 + 1, "max_wingspan_ft": spans[n - 1]})
    return stands


def _code(rng: np.random.Generator) -> str:
    return "RC-" + "".join(rng.choice(list(CODE_CHARS), 4))


def daily_arrivals(scenario: str) -> list[int]:
    k = SCENARIO_K[scenario]
    return [round(b * (1 + (m - 1) * k)) for b, m in zip(BASE_ARRIVALS, MEDIUM_UPLIFT)]


def generate_sample(scenario: str = "medium", seed: int = 61, demand_multiplier: float = 1.0,
                    count_noise: float = 0.0) -> Dataset:
    """Seeded flights and bookings for one plausible week. Shapes, not facts: labelled 'sample'.

    count_noise > 0 draws each day's count around the scenario mean, as a real week would.
    """
    rng = np.random.default_rng(seed)
    days = C.window_days()
    counts = [c * demand_multiplier for c in daily_arrivals(scenario)]
    if count_noise:
        counts = [rng.poisson(max(0.0, c * rng.normal(1, count_noise))) for c in counts]
    counts = [int(round(c)) for c in counts]
    event = scenario != "baseline"
    weights = np.array([o[4] for o in ORIGINS], dtype=float)
    weights /= weights.sum()
    sizes, size_p = list(SIZE_MIX), np.array(list(SIZE_MIX.values()))
    flights: list[Flight] = []
    bookings: dict[str, Booking] = {}
    game_day = days[5]
    seq = 0

    # Aircraft already parked when the window opens; they leave Tue/Wed.
    for i in range(18):
        size = rng.choice(sizes, p=size_p)
        o = ORIGINS[int(rng.choice(len(ORIGINS), p=weights))]
        land = C.window_start_local() - timedelta(hours=int(rng.integers(4, 40)))
        dep = C.window_start_local() + timedelta(days=int(rng.integers(0, 2)), hours=int(rng.integers(8, 17)),
                                                 minutes=int(rng.integers(0, 60)))
        seq += 1
        flights.append(Flight(f"VNY-{seq:04d}", _hash(seed, seq), size, o[0], o[1], o[2], o[3], o[5],
                              land - timedelta(hours=3), land, dep, "pre_window", "sample"))

    for d, (day, n) in enumerate(zip(days, counts)):
        hw = HOUR_WEIGHTS.copy()
        if event and d == 5:  # game day: TFR afternoon, arrivals mostly before 14:00
            hw[14:21] *= 0.35
        hw /= hw.sum()
        for _ in range(n):
            seq += 1
            size = str(rng.choice(sizes, p=size_p))
            o = ORIGINS[int(rng.choice(len(ORIGINS), p=weights))]
            hour = int(rng.choice(24, p=hw))
            land = datetime.combine(day, datetime.min.time(), tzinfo=C.LA) + timedelta(
                hours=hour, minutes=int(rng.integers(0, 60)))
            dist = great_circle_nm(o[2], o[3], *KVNY)
            dep_origin = land - timedelta(hours=dist / 440 + 0.35)
            dg_share = 0.38 if event else 0.30
            if rng.random() < dg_share:
                stay, dep = "drop_and_go", land + timedelta(minutes=int(rng.integers(55, 130)))
            elif event and 2 <= d <= 5:
                stay = "through_game"
                if rng.random() < 0.35:
                    dep = datetime.combine(game_day, datetime.min.time(), tzinfo=C.LA) + timedelta(
                        hours=20, minutes=int(rng.integers(0, 210)))
                else:
                    dep = datetime.combine(days[6], datetime.min.time(), tzinfo=C.LA) + timedelta(
                        hours=7, minutes=int(rng.integers(0, 420)))
            else:
                stay = "overnight"
                dep = datetime.combine(day + timedelta(days=int(rng.integers(1, 3))), datetime.min.time(),
                                       tzinfo=C.LA) + timedelta(hours=int(rng.integers(8, 17)),
                                                                minutes=int(rng.integers(0, 60)))
            dep = max(dep, land + timedelta(minutes=50))
            code = _code(rng)
            while code in bookings:
                code = _code(rng)
            f = Flight(f"VNY-{seq:04d}", _hash(seed, seq), size, o[0], o[1], o[2], o[3], o[5],
                       dep_origin, land, dep, stay, "sample", code)
            flights.append(f)
            bookings[code] = _booking(rng, code, f)

    return Dataset("sample", scenario, sorted(flights, key=lambda f: f.landed), bookings, default_stands(),
                   ["Sample data: seeded flights shaped by public Super Bowl analogs. Not real movements."])


def _hash(seed: int, seq: int) -> str:
    return hashlib.sha256(f"{seed}-{seq}".encode()).hexdigest()[:16]


def _booking(rng: np.random.Generator, code: str, f: Flight) -> Booking:
    r = rng.random()
    ctype = "fixed_time" if r < 0.15 else "medical_access" if r < 0.20 else "none"
    deadline = None
    if ctype == "fixed_time":
        mins = int(rng.integers(8, 25)) * 15
        deadline = f.landed + timedelta(minutes=mins)
        deadline = deadline.replace(minute=(deadline.minute // 15) * 15, second=0, microsecond=0)
    zones, zp = list(HOTEL_ZONES), np.array(list(HOTEL_ZONES.values()))
    return Booking(code, f.flight_id, int(rng.integers(1, 13)), ctype, deadline, str(rng.choice(zones, p=zp)))


def load_processed() -> Dataset | None:
    """Build our FBO's flights from the real replay if the data pipeline has produced it."""
    replay = C.PROCESSED / "replay_2027.jsonl"
    if not replay.exists():
        return None
    share = C.assumptions()["fbo"].get("share_of_airport_arrivals", 0.3)
    events: dict[str, dict] = {}
    with open(replay) as f:
        for line in f:
            e = json.loads(line)
            events.setdefault(e["flight_id"], {}).update({e["event"]: e, "meta": e})
    flights = []
    for fid, ev in events.items():
        if "landed" not in ev or ev["landed"].get("airport") != "KVNY":
            continue
        if int(hashlib.sha256(fid.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF > share:
            continue
        m = ev["meta"]
        landed = C.parse_t(ev["landed"]["t_utc"])
        dep_o = C.parse_t(ev["departed_origin"]["t_utc"]) if "departed_origin" in ev else landed - timedelta(hours=3)
        dep_v = C.parse_t(ev["departed_vny"]["t_utc"]) if "departed_vny" in ev else landed + timedelta(hours=26)
        o = ORIGIN_BY_ICAO.get(m.get("origin") or "", (m.get("origin") or "UNKN", m.get("origin") or "Unknown",
                                                         *KVNY, 0, bool(m.get("is_international"))))
        stay = "drop_and_go" if (dep_v - landed) < timedelta(hours=3) else "overnight"
        flights.append(Flight(fid, m.get("tail_hash", fid[:16]), m.get("size_class", "other"), o[0], o[1], o[2],
                              o[3], bool(m.get("is_international")), dep_o, landed, dep_v, stay,
                              "opensky_2022_shifted"))
    if not flights:
        return None
    bookings: dict[str, Booking] = {}
    bpath = C.PROCESSED / "bookings.json"
    if bpath.exists():
        for b in json.loads(bpath.read_text()):
            bookings[b["booking_code"]] = Booking(
                b["booking_code"], b["flight_id"], b["party_size"], b["commitment_type"],
                C.parse_t(b["deadline_local"]) if b.get("deadline_local") else None, b["hotel_zone"], True)
    by_flight = {b.flight_id: b.booking_code for b in bookings.values()}
    rng = np.random.default_rng(61)
    for f in flights:
        f.booking_code = by_flight.get(f.flight_id)
        if f.booking_code is None:
            code = _code(rng)
            f.booking_code = code
            bookings[code] = _booking(rng, code, f)
    spath = C.PROCESSED / "stands.json"
    stands = json.loads(spath.read_text())["stands"] if spath.exists() else default_stands()
    return Dataset("opensky_2022_shifted", "actual", sorted(flights, key=lambda f: f.landed), bookings, stands,
                   ["Real Super Bowl LVI (2022) flights from OpenSky, shifted +1827 days. Bookings are synthetic."])
