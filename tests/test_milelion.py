"""The MileLion review parsing, and its use as primary source for expiry / conversion / spend cycle."""

import pytest

from pocketaces import build, curate
from pocketaces.models import Card
from pocketaces.sources import milelion as ml

from test_curate import _paths, _setup, _tnc_docs

_DARK = 'style="background-color: #000124;"'
OVERVIEW = f"""
<table><tbody>
<tr><td colspan="4">Apply</td></tr>
<tr><td {_DARK}><strong>Income Req.</strong></td><td>S$30,000 p.a.</td>
    <td {_DARK}><strong>Points Validity</strong></td><td>12-15 months</td></tr>
<tr><td {_DARK}><strong>Annual Fee</strong></td><td>S$196.20<br/>(First Year Free)</td>
    <td {_DARK}><strong>Min. <br/>Transfer</strong></td><td>5,000 DBS Points<br/>(10,000 miles)</td></tr>
<tr><td {_DARK}><strong>FCY Fee</strong></td><td>3.25%</td>
    <td {_DARK}><strong>Transfer Fee</strong></td><td>S$27.25</td></tr>
<tr><td {_DARK}><strong>Local Earn</strong></td><td>0.4 mpd</td>
    <td {_DARK}><strong>Points Pool?</strong></td><td>Yes</td></tr>
</tbody></table>"""

# two card variants in one review: labels span two rows
VARIANTS = f"""
<table><tbody>
<tr><td rowspan="2" {_DARK}>Income Req.</td><td>S$30,000 p.a. Lady’s</td>
    <td rowspan="2" {_DARK}>Points Validity</td><td rowspan="2">24-27 months</td></tr>
<tr><td>S$120,000 p.a. Solitaire</td></tr>
<tr><td {_DARK}>Transfer Fee</td><td>S$27</td><td {_DARK}>Local Earn</td><td>0.4 mpd</td></tr>
</tbody></table>"""


def test_overview_table():
    t = ml.overview_table("<p>intro</p>" + OVERVIEW)
    assert t["points_validity"] == ["12-15 months"]
    assert t["min_transfer"] == ["5,000 DBS Points (10,000 miles)"]
    assert ml.key_facts(t) == {
        "points_expiry": {"months": 12, "months_max": 15}, "transfer_fee": 27.25,
        "min_transfer": {"points": 5000, "points_name": "DBS Points", "miles": 10000},
        "annual_fee": {"amount": 196.2, "first_year_free": True}, "income": 30000, "local_mpd": 0.4}


def test_variant_rows_stay_with_their_label_and_are_not_parsed():
    t = ml.overview_table(VARIANTS)
    assert t["income"] == ["S$30,000 p.a. Lady’s", "S$120,000 p.a. Solitaire"]
    assert t["points_validity"] == ["24-27 months"]
    facts = ml.key_facts(t)
    assert "income" not in facts and facts["points_expiry"] == {"months": 24, "months_max": 27}


@pytest.mark.parametrize("text, expected", [
    ("No Expiry", {"never": True}),
    ("3 years", {"months": 36}),
    ("37 months", {"months": 37}),
    ("3-4 years", {"months": 36, "months_max": 48}),
    ("Up to 5 yrs.", {"months_max": 60}),
    ("Depends on tier", None),
])
def test_parse_validity(text, expected):
    assert ml.parse_validity(text) == expected


@pytest.mark.parametrize("text, expected", [
    ("S$27.25", 27.25), ("Free", 0), ("None", 0), ("Waived", 0), ("N/A", None), ("Free till 31 Jan 25", None),
])
def test_parse_fee(text, expected):
    assert ml.parse_fee(text) == expected


def test_parse_min_transfer_ignores_footnote_marks():
    assert ml.parse_min_transfer("25,000 points (10,000 miles)^") == {
        "points": 25000, "points_name": "points", "miles": 10000}
    assert ml.parse_min_transfer("1,000 90°N Miles* (Up to 1,000 miles)")["points_name"] == "90°N Miles"
    assert ml.parse_min_transfer("N/A") is None


def test_spend_cycle_evidence_keeps_cap_and_min_spend_mentions_only():
    text = ("An overall cap of S$1,000 per statement month applies. "
            "Bonus points are credited in the following calendar month. "
            "The limo is free if you spend S$2,000 in a calendar month. "
            "Cardholders must meet a minimum spend of S$800 per calendar month.")
    ev = ml.spend_cycle_evidence(text)
    assert ev == {"statement_month": ["An overall cap of S$1,000 per statement month applies."],
                  "calendar_month": ["Cardholders must meet a minimum spend of S$800 per calendar month."]}
    assert ml.review_cycle({"spend_cycle": ev}) == (None, [])
    assert ml.review_cycle({"spend_cycle": {"calendar_month": ["q"]}}) == ("calendar_month", ["q"])


def _review(**kw):
    t = ml.overview_table(OVERVIEW)
    return {"card_ids": ["x-card"], "card_name": "X Card", "title": "Review: X Card",
            "url": "https://milelion.test/x", "modified": "2026-09-01T00:00:00",
            "overview": t, "facts": ml.key_facts(t),
            "citation": {"id": "milelion:1", "url": "https://milelion.test/x", "source_type": "editorial"},
            "spend_cycle": {"statement_month": ["capped at S$1,000 per statement month"]}, **kw}


def _miles_setup(monkeypatch, review):
    _setup(monkeypatch)
    monkeypatch.setattr(curate.registry, "get", lambda cid: {"id": cid, "bank": "Bank", "name": "X Card",
                                                              "reward_kind": "miles"})
    monkeypatch.setattr(curate, "_reviews", lambda cid: [review])


def test_draft_takes_expiry_conversion_and_cycle_from_milelion(tmp_path, monkeypatch):
    _paths(tmp_path, monkeypatch)
    _miles_setup(monkeypatch, _review())
    card = curate.build_draft("x-card")
    rc = card.reward_currency
    assert (rc.expiry.months, rc.expiry.months_max, rc.expiry.sources) == (12, 15, ["milelion:1"])
    conv, = rc.conversions
    assert (conv.partner, conv.points, conv.partner_units, conv.fee.amount) == ("KrisFlyer", 5000, 10000, 27.25)
    assert card.spend_cycle.value == "statement_month" and card.spend_cycle_sources == ["milelion:1"]
    assert "expiry:" in curate._dump(card)


def test_milelion_cycle_wins_but_flags_a_tnc_disagreement(tmp_path, monkeypatch):
    _paths(tmp_path, monkeypatch)
    _miles_setup(monkeypatch, _review())
    quote = "Bonus capped at S$1,000 per calendar month."
    monkeypatch.setattr(curate, "_tnc", lambda cid: _tnc_docs(
        tmp_path, ("bank:1", quote, {"calendar_month": [quote]})))
    card = curate.build_draft("x-card")
    assert card.spend_cycle.value == "statement_month"
    assert any("official T&C evidence says calendar_month" in n for n in card.notes)


def test_tnc_cycle_used_when_milelion_is_mixed(tmp_path, monkeypatch):
    _paths(tmp_path, monkeypatch)
    _miles_setup(monkeypatch, _review(spend_cycle={"statement_month": ["a"], "calendar_month": ["b"]}))
    quote = "Bonus capped at S$1,000 per calendar month."
    monkeypatch.setattr(curate, "_tnc", lambda cid: _tnc_docs(
        tmp_path, ("bank:1", quote, {"calendar_month": [quote]})))
    card = curate.build_draft("x-card")
    assert card.spend_cycle.value == "calendar_month" and card.spend_cycle_sources == ["bank:1"]


def test_cashback_cards_get_no_points_fields(tmp_path, monkeypatch):
    _paths(tmp_path, monkeypatch)
    _setup(monkeypatch)
    monkeypatch.setattr(curate, "_reviews", lambda cid: [_review()])
    rc = curate.build_draft("x-card").reward_currency
    assert rc.expiry is None and rc.conversions == []


def _card(**rc):
    return Card(id="x-card", bank="Bank", name="X", annual_fee={"amount": {"amount": 196.2}},
                reward_currency={"kind": "points", "name": "DBS Points", **rc},
                earn_rules=[{"id": "base", "label": "base", "rate": 0.2, "unit": "points_per_dollar",
                             "tier": "base", "eligibility": {"all_spend": True},
                             "bonus_cap": {"amount": 1000, "unit": "SGD_spend", "period": "calendar_month"}}])


def test_build_reports_disagreements_with_milelion():
    conv = [{"partner": "KrisFlyer", "points": 5000, "partner_units": 10000, "fee": {"amount": 25}}]
    issues = build._compare_milelion(_card(conversions=conv, expiry={"months": 12}), _review())
    assert issues == [
        "spend cycle calendar_month vs milelion statement_month (“capped at S$1,000 per statement month”)",
        "points expiry {'months': 12} vs milelion {'months': 12, 'months_max': 15}",
        "conversion fee 25 vs milelion 27.25",
    ]
    # base 0.2 points/S$ at 5,000:10,000 = 0.4 mpd agrees with the review's local earn
    assert not any("base rate" in i for i in issues)
    missing = build._compare_milelion(_card(), _review())
    assert any(i.startswith("no points expiry") for i in missing)
    assert any(i.startswith("no conversions") for i in missing)
    assert build._cycle_unstated(_card())


def test_local_earn_matching_a_bonus_rule_is_not_a_conflict():
    card = _card(conversions=[{"partner": "KrisFlyer", "points": 5000, "partner_units": 10000}])
    card.earn_rules[0].rate = 0.1  # base 0.2 mpd
    review = _review()
    review["facts"]["local_mpd"] = 4.0
    assert any("local earn 4 mpd matches no earn rule (base 0.20 mpd)" in i
               for i in build._compare_milelion(card, review))
    card.earn_rules.append(card.earn_rules[0].model_copy(update={"id": "bonus", "tier": "bonus", "rate": 2.0}))
    assert not any("local earn" in i for i in build._compare_milelion(card, review))


def _points_setup(monkeypatch, earn_rates):
    _setup(monkeypatch)
    curate._staged("x-card")["singsaver"].earn_rates = earn_rates
    monkeypatch.setattr(curate.registry, "get", lambda cid: {"id": cid, "bank": "Bank", "name": "X Card",
                                                              "reward_kind": "points"})


def test_convertible_points_are_drafted_in_mpd(tmp_path, monkeypatch):
    _paths(tmp_path, monkeypatch)
    _points_setup(monkeypatch, {"points_per_dollar:dining": {"value": 2.0, "unit": "points_per_dollar"},
                                "points_per_dollar:baseline": {"value": 0.2, "unit": "points_per_dollar"}})
    monkeypatch.setattr(curate, "_reviews", lambda cid: [_review()])
    card = curate.build_draft("x-card")
    # 5,000 points → 10,000 miles: 2 points/S$ = 4 mpd
    assert [(r.rate, r.unit.value) for r in card.earn_rules] == [(4.0, "mpd"), (0.4, "mpd")]
    assert "milelion:1" in card.earn_rules[0].sources
    assert any("2 points per S$1" in c for c in card.earn_rules[0].conditions)
    assert not any("local earn" in i for i in build._compare_milelion(card, _review()))


def test_points_without_a_conversion_stay_points(tmp_path, monkeypatch):
    _paths(tmp_path, monkeypatch)
    _points_setup(monkeypatch, {"points_per_dollar:baseline": {"value": 1.0, "unit": "points_per_dollar"}})
    assert curate.build_draft("x-card").earn_rules[0].unit.value == "points_per_dollar"
