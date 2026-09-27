"""The card registry (config/cards.yaml): our card ids and how each source names each card."""

from __future__ import annotations

import re
from functools import cache

from . import config


@cache
def _index() -> dict[tuple[str, str], str]:
    idx: dict[tuple[str, str], str] = {}
    for card in config.cards():
        for source, keys in (card.get("sources") or {}).items():
            for key in keys if isinstance(keys, list) else [keys]:
                idx[(source, str(key))] = card["id"]
    return idx


def lookup(source: str, key: str) -> str | None:
    return _index().get((source, key))


def get(card_id: str) -> dict | None:
    return next((c for c in config.cards() if c["id"] == card_id), None)


BANK_ALIASES = {
    "citibank": {"citi"},
    "bank": {"boc"},  # "Bank of China"
    "american": {"amex"},
    "standard": {"sc "},
}


def suggest_id(bank: str, name: str) -> str:
    """'DBS', 'DBS Altitude Visa Signature Card' → 'dbs-altitude-visa-signature'."""
    s = name.lower().replace("'", "").replace("’", "")
    aliases = {bank.lower(), bank.lower().split()[0]} | BANK_ALIASES.get(bank.lower().split()[0], set())
    if not any(s.startswith(a) for a in aliases):
        s = f"{bank.lower()} {s}"
    s = re.sub(r"\b(credit\s+card|card)\b", "", s)
    s = re.sub(r"\+", " plus ", s)
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def match_name(bank_and_name: str) -> list[str]:
    """Registry ids whose bank+name, or one of whose `aliases`, has the same significant tokens as
    `bank_and_name` (used for editorial titles). An alias may be shared, e.g. "DBS Altitude Card"
    for both Altitude variants."""
    from .discover import _tokens

    target = _tokens("", bank_and_name)
    out = []
    for card in config.cards():
        names = [card["name"], f"{card['bank']} {card['name']}", *card.get("aliases", [])]
        if any(_tokens("", n) == target for n in names):
            out.append(card["id"])
    return out
