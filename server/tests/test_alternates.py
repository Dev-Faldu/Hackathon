"""Alternates ranker: OurAirports runway lengths, hard filters, then score. Cards are for the dispatcher."""
from rampcast.engine import alternates as ALT

from factory import at, flight


def test_runway_lengths_come_from_ourairports():
    rw = ALT.longest_runways()
    assert rw["KVNY"] == 8001 and rw["KWHP"] == 4120 and rw["KBUR"] == 6886
    assert ALT.runway_ft("KLAX")[1] == "OurAirports"


def test_large_jet_never_offered_a_short_runway():
    opts = ALT.alternates(flight("BIG", at(3, 12), at(4, 12), size="large"), "Beverly Hills", 40)
    assert "KWHP" not in {o["airport"] for o in opts}   # 4,120 ft < 5,800 ft planning minimum
    assert all("OurAirports" in o["notes"][0] for o in opts if o["airport"] != "KVNY")


def test_international_needs_customs():
    opts = ALT.alternates(flight("INT", at(3, 12), at(4, 12), size="light", intl=True), "Burbank", 40)
    assert not {"KWHP", "KCMA"} & {o["airport"] for o in opts}


def test_full_partner_is_filtered_out():
    f = flight("MID", at(3, 12), at(4, 12), size="mid")
    assert "KBUR" in {o["airport"] for o in ALT.alternates(f, "Burbank", 40)}
    assert "KBUR" not in {o["airport"] for o in ALT.alternates(f, "Burbank", 40, partners_full={"KBUR"})}


def test_holding_for_vny_is_always_an_option():
    opts = ALT.alternates(flight("ANY", at(3, 12), at(4, 12)), "Inglewood", 25)
    assert any(o["airport"] == "KVNY" for o in opts)
    assert opts == sorted(opts, key=lambda o: o["score"])
