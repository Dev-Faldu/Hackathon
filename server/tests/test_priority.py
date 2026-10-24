"""Priority queue: need-based input only, strict order set by the manager's weights, reasons for every rank."""
import inspect
from datetime import timedelta

from rampcast.engine import priority as P
from rampcast.engine.models import QueueResponse

from factory import at, booking, dataset, flight

DEFAULT = {"fixed_time": 0.4, "medical_access": 0.3, "hard_deadline": 0.2, "wait": 0.1}


def test_scorer_input_has_no_identity_status_or_payment_fields():
    assert not P.input_fields() & P.BANNED_FIELDS
    # and the scorer cannot be handed anything else
    params = inspect.signature(P.score).parameters
    assert list(params) == ["inp", "weights"]
    assert params["inp"].annotation in (P.PriorityInput, "PriorityInput")


def _queue(weights=DEFAULT):
    t = at(3, 13)
    tight = flight("TIGHT", t + timedelta(minutes=30), t + timedelta(hours=30), booking="RC-TGHT")
    medical = flight("MED", t + timedelta(minutes=10), t + timedelta(hours=30), booking="RC-MEDX")
    plain = flight("PLAIN", t + timedelta(minutes=5), t + timedelta(hours=30), booking="RC-PLAN")
    bks = [booking("RC-TGHT", "TIGHT", "fixed_time", t + timedelta(minutes=120)),
           booking("RC-MEDX", "MED", "medical_access"), booking("RC-PLAN", "PLAIN")]
    return P.priority_queue(dataset([tight, medical, plain], bks), t, weights)


def test_strict_order_slack_then_medical_then_first_come():
    q = _queue()
    QueueResponse.model_validate(q)
    assert [i["booking_code"] for i in q["items"]] == ["RC-TGHT", "RC-MEDX", "RC-PLAN"]
    assert all(i["reasons"] for i in q["items"])


def test_manager_weights_set_the_order():
    q = _queue({"fixed_time": 0.1, "medical_access": 0.6, "hard_deadline": 0.2, "wait": 0.1})
    assert q["order"][0] == "medical_access"
    assert q["items"][0]["booking_code"] == "RC-MEDX"


def _commitments():
    t = at(3, 13)
    fl = [flight("LATE20", t + timedelta(minutes=5), t + timedelta(hours=30), booking="RC-L20X"),
          flight("LATE65", t + timedelta(minutes=30), t + timedelta(hours=30), booking="RC-L65X"),
          flight("MED", t + timedelta(minutes=1), t + timedelta(hours=30), booking="RC-MEDX"),
          flight("SPARE", t + timedelta(minutes=2), t + timedelta(hours=30), booking="RC-SPAR")]
    bk = [booking("RC-L20X", "LATE20", "fixed_time", t + timedelta(minutes=40)),   # 20 min short after the drive
          booking("RC-L65X", "LATE65", "fixed_time", t + timedelta(minutes=20)),   # 65 min short
          booking("RC-MEDX", "MED", "medical_access"),
          booking("RC-SPAR", "SPARE", "fixed_time", t + timedelta(minutes=230))]   # nearly three hours spare
    return dataset(fl, bk), t


def test_the_latest_commitment_goes_first():
    ds, t = _commitments()
    codes = [i["booking_code"] for i in P.priority_queue(ds, t, DEFAULT)["items"]]
    assert codes.index("RC-L65X") < codes.index("RC-L20X")


def test_plenty_of_slack_does_not_outrank_medical():
    ds, t = _commitments()
    q = P.priority_queue(ds, t, DEFAULT)["items"]
    codes = [i["booking_code"] for i in q]
    assert codes.index("RC-MEDX") < codes.index("RC-SPAR")
    spare = next(i for i in q if i["booking_code"] == "RC-SPAR")
    assert "not urgent" in spare["reasons"][0]


def test_zero_weight_criterion_is_ignored():
    ds, t = _commitments()
    q = P.priority_queue(ds, t, {"fixed_time": 0.4, "medical_access": 0, "hard_deadline": 0.2, "wait": 0.1})
    assert "medical_access" not in q["order"]
    untied = [i for i in q["items"] if i["booking_code"] in ("RC-MEDX", "RC-SPAR")]
    assert [i["eta_local"] for i in untied] == sorted(i["eta_local"] for i in untied)  # medical no longer counts: arrival order


def test_curfew_is_a_hard_deadline():
    t = at(3, 19)
    f = flight("LATE", t - timedelta(minutes=10), at(3, 21, 15), curfew="stage2_jets", booking="RC-LATE")
    inp = P.to_input(f, booking("RC-LATE", "LATE"), t)
    comp, reasons, _ = P.score(inp, DEFAULT)
    assert comp["hard_deadline"] == 1.0
    assert any("curfew" in r for r in reasons)


def test_customs_closing_is_a_hard_deadline():
    t = at(3, 13)  # Friday: VNY customs closes 14:30
    f = flight("INTL", at(3, 14, 25), at(4, 12), intl=True, booking="RC-INTL")
    comp, reasons, _ = P.score(P.to_input(f, booking("RC-INTL", "INTL"), t), DEFAULT)
    assert comp["hard_deadline"] == 1.0 and any("Customs closes" in r for r in reasons)
