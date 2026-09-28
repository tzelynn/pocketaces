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


def _paths(tmp_path, monkeypatch):
    monkeypatch.setattr(curate.paths, "ROOT", tmp_path)
    monkeypatch.setattr(curate.paths, "CURATED_CARDS", tmp_path / "curated")
    monkeypatch.setattr(curate, "SUGGESTIONS", tmp_path / "suggestions")
    monkeypatch.setattr(curate, "DRAFTS", tmp_path / "drafts")


def _mark_reviewed(path):
    path.write_text(path.read_text().replace("status: draft", "status: reviewed"))


def test_reviewed_record_is_never_overwritten(tmp_path, monkeypatch):
    _paths(tmp_path, monkeypatch)
    _setup(monkeypatch)
    record = curate.curate("x-card")
    _mark_reviewed(record)
    reviewed = record.read_text()

    _setup(monkeypatch, min_monthly_spend=800.0)  # sources change
    out = curate.curate("x-card")
    assert record.read_text() == reviewed
    assert out == tmp_path / "suggestions" / "x-card.yaml"
    assert "800" in out.read_text()
    diff = out.with_suffix(".diff").read_text()
    assert "+" in diff and "800" in diff and "status: reviewed" in diff
    assert curate.pending_suggestions() == ["x-card"]


def test_no_suggestion_when_sources_unchanged(tmp_path, monkeypatch):
    _paths(tmp_path, monkeypatch)
    _setup(monkeypatch)
    _mark_reviewed(curate.curate("x-card"))
    assert curate.curate("x-card") is None
    assert curate.pending_suggestions() == []


def test_draft_records_are_still_overwritten(tmp_path, monkeypatch):
    _paths(tmp_path, monkeypatch)
    _setup(monkeypatch)
    record = curate.curate("x-card")
    _setup(monkeypatch, min_monthly_spend=800.0)
    assert curate.curate("x-card") == record and "800" in record.read_text()
    assert curate.pending_suggestions() == []


def _tnc_docs(tmp_path, *docs):
    """Staged T&C documents: (citation id, text, spend_cycle evidence) per document."""
    out = []
    for cid, text, cycle in docs:
        (tmp_path / f"{cid}.txt").write_text(text)
        out.append({"citation": {"id": cid, "url": f"https://bank.test/{cid}", "source_type": "official"},
                    "text_path": f"{cid}.txt", "spend_cycle": cycle})
    return {"documents": out}


def test_spend_cycle_from_tnc_sets_min_spend_period(tmp_path, monkeypatch):
    _paths(tmp_path, monkeypatch)
    _setup(monkeypatch, min_monthly_spend=800.0)
    quote = "Cashback is capped at S$80 per calendar month."
    monkeypatch.setattr(curate, "_tnc", lambda cid: _tnc_docs(
        tmp_path, ("bank:1", quote, {"calendar_month": [quote]})))
    card = curate.build_draft("x-card")
    assert card.spend_cycle.value == "calendar_month" and card.spend_cycle_sources == ["bank:1"]
    bonus = next(r for r in card.earn_rules if r.tier == "bonus")
    assert bonus.min_spend_period.value == "calendar_month"
    assert any("spend_cycle calendar_month auto-extracted" in n for n in card.notes)
    assert "spend_cycle: calendar_month" in curate._dump(card)


def test_conflicting_spend_cycle_is_left_for_review(tmp_path, monkeypatch):
    _paths(tmp_path, monkeypatch)
    _setup(monkeypatch)
    monkeypatch.setattr(curate, "_tnc", lambda cid: _tnc_docs(
        tmp_path, ("bank:1", "a", {"statement_month": ["a"]}), ("bank:2", "b", {"calendar_month": ["b"]})))
    card = curate.build_draft("x-card")
    assert card.spend_cycle_sources == []
    assert any("set spend_cycle by hand" in n for n in card.notes)
    assert "\nspend_cycle:" not in curate._dump(card)  # unstated: don't write the model default


def test_llm_spend_cycle_wins_and_cites_the_quoting_document(tmp_path, monkeypatch):
    _paths(tmp_path, monkeypatch)
    _setup(monkeypatch)
    quote = "Minimum spend of S$600 within the same statement month."
    tnc = _tnc_docs(tmp_path, ("bank:1", "Other terms.", {"calendar_month": ["x"]}),
                    ("bank:2", f"Intro. {quote} More.", {}))
    tnc["llm"] = {"spend_cycle": "statement_month", "spend_cycle_evidence": [quote]}
    monkeypatch.setattr(curate, "_tnc", lambda cid: tnc)
    card = curate.build_draft("x-card")
    assert card.spend_cycle.value == "statement_month" and card.spend_cycle_sources == ["bank:2"]


def test_offer_terms_parse_qualifying_spend_and_eligibility():
    t = curate._offer_terms(
        "Promotion is valid for new American Express card members only.\nApply for the card, pay the annual "
        "fee (S$397.85 incl. GST) and make a min. spend of S$8,000 within the first 6 months of card approval."
        "\nPromotion does not stack with other welcome offers.")
    assert t["min_spend"].amount == 8000 and t["spend_within_days"] == 180
    assert t["new_to_bank_only"] is True and t["stackable"] is False

    # Moneysmart: bullets, an apply-by date, and an unrelated later date that must not win
    t = curate._offer_terms("• A\npply for the card by 30th Sept 2026\n• Spend a min. of S$800 in eligible "
                            "transactions within 60 days\n• Submit your Claim Form by 30th Oct 2026")
    assert t["min_spend"].amount == 800 and t["spend_within_days"] == 60
    assert t["valid_to"].isoformat() == "2026-09-30" and "new_to_bank_only" not in t

    assert curate._offer_terms("Reach S$1K spend to receive 20,000 Max Miles.")["min_spend"].amount == 1000
    assert curate._offer_terms("Receive S$100 with a minimum S$188 closing balance.") == {}


def test_moneysmart_offer_is_structured(monkeypatch):
    ms = StagedCard(
        source="moneysmart", source_id="x", source_url="https://ms.test/x", name="X Card", bank="Bank",
        card_id="x-card", citation=Citation(id="moneysmart:1", url="https://ms.test/x", source_type="aggregator"),
        sign_up_offers=[{"title": "Samsonite Luggage", "terms": "Valid for New Customers only\nCharge a min. of "
                                                             "S$500 within 60 days"},
                        {"title": "S$288 Cashback"}],
    )
    _setup(monkeypatch)
    monkeypatch.setattr(curate, "_staged", lambda cid: {"moneysmart": ms})
    [b] = curate.build_draft("x-card").sign_up_bonuses
    assert b.options == ["Samsonite Luggage", "S$288 Cashback"] and b.value.amount == 288
    assert b.min_spend.amount == 500 and b.spend_within_days == 60 and b.new_to_bank_only
    assert "Terms" not in b.description and b.terms.startswith("Valid for New Customers")


def test_draft_date_alone_is_not_a_change():
    assert curate._facts("id: x\nupdated_at: '2026-09-27'\n") == curate._facts("id: x\nupdated_at: '2026-09-28'\n")
