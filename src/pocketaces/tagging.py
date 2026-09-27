"""Derive spend tags for a card by comparing its earn rules' MCC coverage with config/categories.yaml.

A tag is "full" when the card's best bonus rule(s) cover at least MIN_COVERAGE of the tag's MCCs,
"partial" when they cover some. Transaction-mode requirements (e.g. online only) are reported
alongside, since they are not expressible as MCCs.
"""

from __future__ import annotations

from functools import cache

from . import config
from .extract.mcc import expand
from .models import Card, EarnRule

MIN_COVERAGE = 0.9
ALL_MCC = frozenset(range(0, 10000))


@cache
def tag_codes(tag: str) -> frozenset[int]:
    cats = config.categories()
    if tag not in cats:
        raise KeyError(f"unknown tag {tag!r} (not in config/categories.yaml)")
    spec = cats[tag]
    codes = set(expand(spec.get("mcc", [])))
    for child in spec.get("children", []):
        codes |= tag_codes(child)
    return frozenset(codes)


def eligible_codes(rule: EarnRule, card: Card) -> frozenset[int]:
    el = rule.eligibility
    if el.all_spend:
        codes = set(ALL_MCC)
    else:
        codes = set(expand(el.include_mcc))
        for t in el.tags:
            codes |= tag_codes(t)
    codes -= expand(el.exclude_mcc)
    codes -= expand(card.general_exclusions.exclude_mcc)
    return frozenset(codes)


def top_rules(card: Card) -> list[EarnRule]:
    """Bonus rules at the card's highest rate (several rules may share the top rate)."""
    bonus = [r for r in card.earn_rules if r.tier == "bonus"] or card.earn_rules
    if not bonus:
        return []
    best = max(r.rate for r in bonus)
    return [r for r in bonus if r.rate == best]


def coverage(card: Card) -> dict[str, dict]:
    """tag → {level, share, rules, modes_required} for every tag with any coverage."""
    rules = top_rules(card)
    out: dict[str, dict] = {}
    for tag, spec in config.categories().items():
        codes = tag_codes(tag)
        if not codes or tag == "commonly_excluded" or tag in (
                config.categories()["commonly_excluded"].get("children", [])):
            continue
        covered: set[int] = set()
        by: list[str] = []
        modes: set[str] = set()
        for r in rules:
            hit = codes & eligible_codes(r, card)
            if hit:
                covered |= hit
                by.append(r.id)
                modes |= {m.value for m in r.eligibility.modes_required}
        if not covered:
            continue
        share = len(covered) / len(codes)
        out[tag] = {
            "level": "full" if share >= MIN_COVERAGE else "partial",
            "share": round(share, 3),
            "rules": by,
            "modes_required": sorted(modes),
        }
    # a parent tag is only "full" when every child is (a small child such as travel agencies,
    # one MCC, would otherwise vanish inside a large parent's share)
    cats = config.categories()

    def full(tag: str) -> bool:
        children = cats[tag].get("children", [])
        if children:
            return all(full(c) for c in children)
        return out.get(tag, {}).get("level") == "full"

    for tag in out:
        if cats[tag].get("children"):
            out[tag]["level"] = "full" if full(tag) else "partial"
    return out


def card_tags(card: Card) -> list[str]:
    tags = [t for t, c in coverage(card).items() if c["level"] == "full"]
    rules = top_rules(card)
    if card.reward_currency.kind:
        tags.append(card.reward_currency.kind)
    if rules and all(r.min_spend is None for r in rules):
        tags.append("no_min_spend")
    if rules and any(r.uncapped for r in rules):
        tags.append("uncapped_bonus")
    base = [r for r in card.earn_rules if r.eligibility.all_spend]
    if base and any(r.uncapped for r in base):
        tags.append("uncapped_base")
    return sorted(set(tags))


def excluded_categories(card: Card) -> list[str]:
    """Commonly-excluded categories that this card's general exclusions hit."""
    excl = expand(card.general_exclusions.exclude_mcc)
    out = []
    for child in config.categories()["commonly_excluded"].get("children", []):
        if tag_codes(child) & excl:
            out.append(child)
    return out
