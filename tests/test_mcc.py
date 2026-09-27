from pathlib import Path

from pocketaces.extract.mcc import expand, extract_mccs

FIXTURE = Path(__file__).parent / "fixtures" / "hsbc_revolution_tnc.txt"


def test_hsbc_revolution_exclusion_table():
    r = extract_mccs(FIXTURE.read_text())
    # the official table lists 48 excluded MCCs, spanning a page break
    assert len(r.exclude) == 48
    assert {"4829", "6011", "6051", "7995", "9311", "9754"} <= set(r.exclude)
    assert not r.conflicting
    assert not r.unknown


def test_hsbc_revolution_eligible_ranges():
    r = extract_mccs(FIXTURE.read_text())
    assert {"3000-3350", "3351-3500", "3501-3999", "4121", "5812", "5311"} <= set(r.include)
    # table row text like "Betting, including ..." must not flip polarity to include
    assert "7995" not in r.include


def test_polarity_from_inline_sentence():
    text = "Transactions with MCCs 4829 and 6300 are excluded.\nEligible MCC: 5812, 5814"
    r = extract_mccs(text)
    assert r.exclude == ["4829", "6300"]
    assert r.include == ["5812", "5814"]


def test_amounts_and_years_are_not_codes():
    text = "MCC list below.\nMinimum spend of S$1,000 by 31 December 2026 at 5000% ... 2026\nMCC 5411"
    r = extract_mccs(text)
    assert [h.code for h in r.hits] == ["5411"]


def test_trailing_comma_range():
    r = extract_mccs("Eligible MCCs:\n1 3000 to 3350, 4511 Airlines")
    assert r.include == ["3000-3350", "4511"]


def test_expand():
    assert expand(["5812", "3000-3002"]) == {5812, 3000, 3001, 3002}


def test_codes_missing_from_reference_are_kept_and_flagged():
    r = extract_mccs(FIXTURE.read_text(), known_codes={"4829", "6011"})
    assert len(r.exclude) == 48  # nothing silently dropped
    assert "6529" in r.unrecognised and "4829" not in r.unrecognised
