"""Draft generation from staged aggregator data."""

from pocketaces import curate
from pocketaces.models import Citation, StagedCard


def _setup(monkeypatch, **staged_fields):
    ss = StagedCard(
        source="singsaver", source_id="x", source_url="https://ss.test/x", name="X Card", bank="Bank",
        card_id="x-card",
        earn_rates={"percent:dining": {"value": 6.0, "unit": "percent"},
                    "percent:baseline": {"value": 0.3, "unit": "percent"}},
        citation=Citation(id="singsaver:1", url="https://ss.test/x", source_type="aggregator"),
        **staged_fields,
    )
    monkeypatch.setattr(curate.registry, "get", lambda cid: {"id": cid, "bank": "Bank", "name": "X Card",
                                                              "reward_kind": "cashback"})
    monkeypatch.setattr(curate, "_staged", lambda cid: {"singsaver": ss})
    monkeypatch.setattr(curate, "_tnc", lambda cid: {})
    monkeypatch.setattr(curate, "_reviews", lambda cid: [])


def test_min_monthly_spend_goes_on_bonus_rules_only(monkeypatch):
    _setup(monkeypatch, min_monthly_spend=800.0)
    card = curate.build_draft("x-card")
    bonus = next(r for r in card.earn_rules if r.tier == "bonus")
    base = next(r for r in card.earn_rules if r.tier == "base")
    assert bonus.min_spend.amount == 800 and bonus.min_spend_period.value == "statement_month"
    assert any("confirm the period" in c for c in bonus.conditions)
    assert base.min_spend is None


def test_no_min_spend_when_aggregator_has_none(monkeypatch):
    _setup(monkeypatch)
    assert all(r.min_spend is None for r in curate.build_draft("x-card").earn_rules)
