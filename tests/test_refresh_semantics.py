"""Refresh semantics: overwrite on success, keep previous data when a card/fetch fails."""

import json
from datetime import datetime, timezone

import pytest

from pocketaces import paths
from pocketaces.fetch import Fetcher
from pocketaces.models import Card, Citation, StagedCard
from pocketaces.sources.common import write_staging


@pytest.fixture
def tmp_root(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "ROOT", tmp_path)
    monkeypatch.setattr(paths, "RAW", tmp_path / "data" / "raw")
    monkeypatch.setattr(paths, "STAGING", tmp_path / "data" / "staging")
    return tmp_path


def staged(source_id: str, fee: float) -> StagedCard:
    return StagedCard(
        source="test", source_id=source_id, source_url=f"https://x.test/{source_id}",
        name=source_id, bank="Bank", annual_fee=fee,
        citation=Citation(id="test:1", url="https://x.test", source_type="aggregator"))


def test_staging_overwrites_keeps_failed_and_drops_delisted(tmp_root):
    write_staging([staged("a", 1), staged("b", 1), staged("c", 1)], "test")
    write_staging([staged("a", 2)], "test", failed={"b"})
    out = tmp_root / "data" / "staging" / "test"
    assert json.loads((out / "_unmapped-a.json").read_text())["annual_fee"] == 2  # overwritten
    assert json.loads((out / "_unmapped-b.json").read_text())["annual_fee"] == 1  # kept (failed)
    assert not (out / "_unmapped-c.json").exists()  # delisted


def test_empty_run_keeps_everything(tmp_root):
    write_staging([staged("a", 1)], "test")
    write_staging([], "test")
    assert (tmp_root / "data" / "staging" / "test" / "_unmapped-a.json").exists()


def test_snapshot_overwritten_per_url(tmp_root):
    with Fetcher("test") as f:
        s1 = f.save("https://x.test/doc.pdf", "https://x.test/doc.pdf", b"%PDF v1", "application/pdf")
        s2 = f.save("https://x.test/doc.pdf", "https://x.test/doc.pdf", b"%PDF v2", "application/pdf")
    assert s1.path == s2.path and s1.sha256 != s2.sha256
    assert (tmp_root / s2.path).read_bytes() == b"%PDF v2"
    manifest = json.loads((tmp_root / "data" / "raw" / "test" / "manifest.json").read_text())
    assert manifest["https://x.test/doc.pdf"]["sha256"] == s2.sha256


def _tnc(tmp_root, card_id: str, seen_since: str) -> None:
    out = tmp_root / "data" / "staging" / "tnc"
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{card_id}.json").write_text(json.dumps({"card_id": card_id, "documents": [
        {"url": "https://bank.test/new.pdf", "sha256": "abc", "seen_since": seen_since}]}))


@pytest.mark.parametrize("reviewed_at, stale", [
    (None, True),                                       # no review date: T&C change wins
    ("2026-09-26", True),                               # reviewed before the pull
    ("2026-09-27", False),                              # same day (date-only) counts as after
    (datetime(2026, 9, 27, 8, 0, tzinfo=timezone.utc), True),
    (datetime(2026, 9, 27, 9, 0, tzinfo=timezone.utc), False),
])
def test_review_after_pull_outranks_stale(tmp_root, reviewed_at, stale):
    from pocketaces.build import _stale_reason

    _tnc(tmp_root, "c", "2026-09-27T08:30:00+00:00")
    card = Card(id="c", bank="Bank", name="C", reward_currency={"kind": "miles", "name": "miles"},
                earn_rules=[], review={"status": "reviewed", "reviewed_at": reviewed_at})
    assert (_stale_reason(card) is not None) == stale
