"""Helpers shared by source scrapers."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from bs4 import BeautifulSoup

from .. import paths
from ..fetch import Snapshot
from ..models import Citation, SourceType, StagedCard

log = logging.getLogger(__name__)


def html_to_text(html: str | None) -> str:
    if not html:
        return ""
    text = BeautifulSoup(html, "lxml").get_text("\n")
    return re.sub(r"\n\s*\n+", "\n", text).strip()


def num(value) -> float | None:
    if value in (None, "", "$undefined"):
        return None
    try:
        return float(str(value).replace(",", "").replace("S$", "").strip())
    except ValueError:
        return None


def citation(snap: Snapshot, source_type: SourceType, title: str | None = None) -> Citation:
    return Citation(
        id=snap.citation_id,
        url=snap.final_url,
        title=title,
        source_type=source_type,
        retrieved_at=snap.retrieved_at,
        sha256=snap.sha256,
        snapshot=snap.path,
    )


def write_staging(cards: list[StagedCard], source: str, *, failed: set[str] = frozenset()) -> Path:
    """Overwrite each successfully parsed card's staging file.

    `failed` holds source ids whose fetch/parse failed this run; their previous files are kept.
    Old files for cards neither re-staged nor failed (delisted/discontinued) are removed. If the
    run produced no cards at all, nothing is touched: that is a broken run, not an empty market.
    """
    out = paths.STAGING / source
    if not cards:
        log.error("%s: no cards parsed — keeping previous staging data", source)
        return out
    out.mkdir(parents=True, exist_ok=True)
    written = set()
    for c in cards:
        name = c.card_id or f"_unmapped-{re.sub(r'[^a-z0-9]+', '-', c.source_id.lower())}"
        path = out / f"{name}.json"
        path.write_text(c.model_dump_json(indent=1, exclude_none=True))
        written.add(path.name)
    kept = []
    for old in out.glob("*.json"):
        if old.name in written or old.name.startswith("_index"):
            continue
        try:
            source_id = json.loads(old.read_text()).get("source_id")
        except json.JSONDecodeError:
            source_id = None
        if source_id in failed:
            kept.append(source_id)
        else:
            old.unlink()
    if kept:
        log.warning("%s: kept previous data for %d cards that failed this run: %s",
                    source, len(kept), ", ".join(sorted(kept)))
    index = [{"card_id": c.card_id, "source_id": c.source_id, "name": c.name, "bank": c.bank,
              "url": c.source_url} for c in cards]
    (out / "_index.json").write_text(json.dumps(index, indent=1))
    return out


def load_staging(source: str) -> list[StagedCard]:
    d = paths.STAGING / source
    if not d.exists():
        return []
    from .. import registry

    out = []
    for p in sorted(d.glob("*.json")):
        if p.name.startswith("_index"):
            continue
        card = StagedCard.model_validate_json(p.read_text())
        # resolve against the current registry so mapping a card doesn't require re-fetching
        card.card_id = registry.lookup(source, card.source_id)
        out.append(card)
    return out
