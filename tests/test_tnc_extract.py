"""Rule-based and LLM spend-cycle extraction from T&C text."""

from pocketaces.extract import llm
from pocketaces.sources.bank_tnc import _spend_cycle


def test_spend_cycle_sentences():
    text = ("The total cash rebate shall be capped at S$50 for each statement month. "
            "Cardmembers must charge at least S$500 in a calendar month. "
            "UNI$ are awarded on the 7th calendar day of the following calendar month. "
            "The Deposits ADB means the average daily balance for the calendar month. "
            "Each Billing Cycle ends on the statement date.")
    found = _spend_cycle(text)
    assert found["statement_month"] == ["The total cash rebate shall be capped at S$50 for each statement month."]
    assert found["calendar_month"] == ["Cardmembers must charge at least S$500 in a calendar month."]


def _extracted(**kw):
    return llm.ExtractedTnc(rules=[], general_exclude_mcc=[], general_excluded_transactions=[],
                            redemption_min_block=None, redemption_fee=None, points_expiry=None,
                            other_notes=[], **kw)


def test_llm_spend_cycle_needs_a_verbatim_quote():
    text = "Min spend of S$800\n in a   calendar month applies."
    ok = _extracted(spend_cycle="calendar_month", spend_cycle_evidence=["min spend of S$800 in a calendar month"])
    assert llm.verify(ok, text, set())["rejected"] == [] and ok.spend_cycle == "calendar_month"
    made_up = _extracted(spend_cycle="statement_month", spend_cycle_evidence=["per statement cycle"])
    assert llm.verify(made_up, text, set())["rejected"] == ["spend_cycle:statement_month"]
    assert made_up.spend_cycle is None and made_up.spend_cycle_evidence == []
