"""Find aggregator cards missing from config/cards.yaml and propose registry entries.

Cards from SingSaver and Moneysmart are matched by normalised name so one entry covers both.
Proposals are printed (or appended with --write); a human should check the grouping and fill in
`official.product_page` before running `pocketaces tnc`.
"""

from __future__ import annotations

import re

import yaml

from . import config, paths, registry
from .sources.common import load_staging

BANK_KEYS = {
    "dbs": "dbs", "posb": "posb", "uob": "uob", "ocbc": "ocbc", "citibank": "citibank",
    "citi": "citibank", "hsbc": "hsbc", "standard chartered": "standard-chartered",
    "maybank": "maybank", "american express": "amex", "amex": "amex", "trust": "trust",
    "cimb": "cimb", "boc": "boc", "bank of china": "boc", "dcs": "dcs", "hl bank": "hlbank",
}
_STOP = {"card", "credit", "the"}
# words that tell two otherwise-identical card names apart; fuzzy matching may not ignore them
_DISTINGUISHING = {"world", "plus", "visa", "amex", "mastercard", "unionpay", "signature",
                   "infinite", "solitaire", "student", "ascend", "prestige", "metal"}


def bank_key(bank: str) -> str:
    b = bank.lower()
    for k, v in BANK_KEYS.items():
        if b.startswith(k):
            return v
    return re.sub(r"[^a-z0-9]+", "-", b).strip("-")


def _tokens(bank: str, name: str) -> frozenset[str]:
    s = f"{bank} {name}".lower().replace("+", " plus ").replace("citibank", "citi")
    s = s.replace("american express", "amex").replace("standard chartered", "sc")
    return frozenset(t for t in re.findall(r"[a-z0-9]+", s) if t not in _STOP)


def _similar(a: frozenset, b: frozenset) -> bool:
    if not (a and b) or (a ^ b) & _DISTINGUISHING:
        return False
    return len(a & b) / len(a | b) >= 0.75


def _skipped(source_id: str) -> bool:
    patterns = config.sources().get("discover_skip_patterns", [])
    return any(re.search(p, source_id) for p in patterns)


def proposals() -> list[dict]:
    """Group unmapped cards across sources: exact token matches first, then fuzzy matches."""
    groups: list[dict] = []
    pending = []
    for source in ("singsaver", "moneysmart"):
        for c in load_staging(source):
            if not c.card_id and not _skipped(c.source_id):
                pending.append((source, c, _tokens(c.bank, c.name)))
    for match in (lambda a, b: a == b, _similar):
        rest = []
        for source, c, toks in pending:
            g = next((g for g in groups
                      if source not in g["sources"] and match(g["_tokens"], toks)), None)
            if g:
                g["sources"][source] = c.source_id
            elif match is _similar or source == "singsaver":
                groups.append({
                    "id": _unique(registry.suggest_id(c.bank, c.name), groups),
                    "bank": c.bank,
                    "bank_key": bank_key(c.bank),
                    "name": c.name,
                    "sources": {source: c.source_id},
                    "official": {"product_page": None},
                    "_tokens": toks,
                })
            else:
                rest.append((source, c, toks))
        pending = rest
    for g in groups:
        del g["_tokens"]
    return sorted(groups, key=lambda g: g["id"])


def _unique(cid: str, groups: list[dict]) -> str:
    taken = {g["id"] for g in groups} | {c["id"] for c in config.cards()}
    out, n = cid, 2
    while out in taken:
        out, n = f"{cid}-{n}", n + 1
    return out


def write(props: list[dict]) -> int:
    path = paths.CONFIG / "cards.yaml"
    data = yaml.safe_load(path.read_text()) if path.exists() else None
    data = data or {"cards": []}
    existing = {c["id"] for c in data["cards"]}
    added = [p for p in props if p["id"] not in existing]
    data["cards"].extend(added)
    path.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True, width=100))
    config.load.cache_clear()
    registry._index.cache_clear()
    return len(added)
