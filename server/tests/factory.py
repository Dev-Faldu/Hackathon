"""Tiny builders for hand-made flights and datasets used by the engine unit tests."""
from datetime import datetime, timedelta

from rampcast_server import config as C
from rampcast_server.data import Booking, Dataset, Flight, default_stands


def at(day: int, hh: int, mm: int = 0) -> datetime:
    """Local time on Feb 9 + day (Tue = 0)."""
    return datetime(2027, 2, 9 + day, hh, mm, tzinfo=C.LA)


def flight(fid: str, landed: datetime, departs: datetime, size: str = "mid", intl: bool = False,
           stay: str = "overnight", curfew: str | None = "", booking: str | None = None) -> Flight:
    return Flight(fid, f"tail-{fid}", size, "KTEB", "Teterboro, NJ", 40.85, -74.06, intl,
                  landed - timedelta(hours=5), landed, departs, stay, "test", booking, curfew)


def booking(code: str, fid: str, commitment: str = "none", deadline: datetime | None = None,
            zone: str = "Beverly Hills", car_at: str = "KVNY") -> Booking:
    return Booking(code, fid, 4, commitment, deadline, zone, True, car_at)


def dataset(flights: list[Flight], bookings: list[Booking] = ()) -> Dataset:
    return Dataset("test", "medium", sorted(flights, key=lambda f: f.landed), {b.booking_code: b for b in bookings},
                   default_stands(), [])
