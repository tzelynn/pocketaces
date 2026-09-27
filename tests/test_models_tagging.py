import pytest

from pocketaces import tagging
from pocketaces.models import Card


def card(**over):
    base = {
        "id": "test-card",
        "bank": "Test Bank",
        "name": "Test Card",
        "reward_currency": {"kind": "miles", "name": "KrisFlyer miles"},
        "earn_rules": [
            {"id": "base", "label": "All spend", "rate": 1.2, "unit": "mpd", "tier": "base",
             "eligibility": {"all_spend": True}, "sources": ["c1"]},
            {"id": "travel", "label": "Travel", "rate": 4, "unit": "mpd",
             "eligibility": {"tags": ["flights", "hotels"], "include_mcc": ["4121"],
                             "modes_required": ["online"]},
             "bonus_cap": {"amount": 1000, "unit": "SGD_spend", "period": "calendar_month"},
             "sources": ["c1"]},
        ],
        "general_exclusions": {"exclude_mcc": ["6011", "9311"]},
        "citations": [{"id": "c1", "url": "https://bank.test/tnc.pdf", "source_type": "official"}],
    }
    base.update(over)
    return Card.model_validate(base)


def test_unknown_citation_rejected():
    with pytest.raises(ValueError, match="unknown citation"):
        card(citations=[])


def test_tags():
    c = card()
    cov = tagging.coverage(c)
    assert cov["flights"]["level"] == "full"
    assert cov["hotels"]["level"] == "full"
    assert cov["ride_hailing"]["level"] == "full"
    assert cov["travel"]["level"] == "partial"  # no car rental / cruise / agencies
    assert cov["flights"]["modes_required"] == ["online"]
    tags = tagging.card_tags(c)
    assert {"flights", "hotels", "miles", "no_min_spend", "uncapped_base"} <= set(tags)
    assert "uncapped_bonus" not in tags
    assert set(tagging.excluded_categories(c)) == {"financial", "government"}


def test_general_exclusions_remove_codes():
    c = card(general_exclusions={"exclude_mcc": ["3000-3350", "4511"]})
    assert "flights" not in tagging.coverage(c)


def test_spend_cycle_defaults_to_calendar_month():
    assert card().spend_cycle.value == "calendar_month"
    c = card(spend_cycle="statement_month", spend_cycle_sources=["c1"])
    assert c.spend_cycle.value == "statement_month"
    with pytest.raises(ValueError):
        card(spend_cycle="quarter")
    with pytest.raises(ValueError, match="unknown citation"):
        card(spend_cycle="statement_month", spend_cycle_sources=["nope"])
