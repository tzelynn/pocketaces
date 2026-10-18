"""Merge curated records with staged evidence, validate, tag, and report problems.

Outputs:
  data/build/cards.json  – every curated card (reviewed or not) with computed tags and status
  data/build/report.md   – what needs human attention
"""

from __future__ import annotations

import json
import logging
import re
from datetime import date, datetime

from . import config, paths, tagging
from .curate import load_curated, pending_suggestions
from .models import Card, Period, ReviewStatus
from .sources import milelion
from .sources.common import load_staging
from .sources.mcc_reference import known_codes

log = logging.getLogger(__name__)

_DATE_IN_TEXT = re.compile(
    r"\b(?:till|until|by|before|ends?|valid\s+(?:till|until|to))\s+(\d{1,2}\s+"
    r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})", re.I)


def _parse_date(s: str) -> date | None:
    for fmt in ("%d %B %Y", "%d %b %Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def validate_config() -> list[str]:
    """Problems in config files (unknown MCCs in categories, duplicate registry ids...)."""
    problems = []
    known = known_codes()
    for tag, spec in config.categories().items():
        for child in spec.get("children", []):
            if child not in config.categories():
                problems.append(f"categories.{tag}: unknown child {child!r}")
        if known is None:
            continue
        for code in spec.get("mcc", []):
            if "-" in code:
                continue
            if code not in known:
                problems.append(f"categories.{tag}: MCC {code} not in reference list")
    ids = [c["id"] for c in config.cards()]
    for dup in {i for i in ids if ids.count(i) > 1}:
        problems.append(f"cards.yaml: duplicate id {dup}")
    return problems


def _reviewed_after(card: Card, pulled_at: str | None) -> bool:
    """True if the human review is dated on/after the data pull — the review then outranks it.
    A date-only `reviewed_at` counts as the whole day (reviews usually follow a same-day refresh)."""
    reviewed = card.review.reviewed_at
    if reviewed is None or not pulled_at:
        return False
    pulled = datetime.fromisoformat(pulled_at)
    if isinstance(reviewed, datetime):
        if reviewed.tzinfo is None:
            reviewed = reviewed.astimezone()  # naive: the reviewer's local time
        return reviewed >= pulled
    return reviewed >= pulled.astimezone().date()


def _stale_reason(card: Card) -> str | None:
    """A reviewed card goes stale if an official document it cites has since changed — unless the
    review (`review.reviewed_at`) is dated after that change was pulled."""
    p = paths.STAGING / "tnc" / f"{card.id}.json"
    if not p.exists() or card.review.status != ReviewStatus.reviewed:
        return None
    tnc = json.loads(p.read_text())
    cited = {c.url: c.sha256 for c in card.citations if c.source_type.value == "official" and c.sha256}
    for d in tnc.get("documents", []):
        if not d.get("sha256") or _reviewed_after(
                card, d.get("seen_since") or d.get("citation", {}).get("retrieved_at")):
            continue
        if d["url"] in cited and d["sha256"] != cited[d["url"]]:
            return f"T&C changed since review: {d['url']}"
        if d["url"] not in cited:
            return f"new official document not cited in review: {d['url']}"
    if not _reviewed_after(card, tnc.get("removed_at")):
        for url in tnc.get("removed_documents", []):
            if url in cited:
                return f"cited T&C no longer published: {url}"
    return None


def _compare(card: Card, staged: dict[str, list]) -> list[str]:
    issues = []
    for source, items in staged.items():
        s = next((x for x in items if x.card_id == card.id), None)
        if not s:
            continue
        if card.annual_fee and s.annual_fee is not None and \
                abs(card.annual_fee.amount.amount - s.annual_fee) > 0.01:
            issues.append(f"annual fee {card.annual_fee.amount.amount} vs {source} {s.annual_fee}")
        if card.min_annual_income and s.min_annual_income and \
                abs(card.min_annual_income.amount - s.min_annual_income) > 1:
            issues.append(f"min income {card.min_annual_income.amount} vs {source} {s.min_annual_income}")
        best = card.best_rule()
        top = []  # the source's rates in the best rule's unit (points → mpd for convertible points)
        for k, v in s.earn_rates.items():
            val = v.get("value")
            val = val["max"] if isinstance(val, dict) else val
            unit = k.split(":", 1)[0]
            if best and val is not None:
                rate = val if unit == best.unit.value else \
                    _mpd(card, val, unit) if best.unit.value == "mpd" else None
                if rate is not None:
                    top.append(round(rate, 2))
        if best and top and abs(max(top) - best.rate) > 0.01:
            issues.append(f"best rate {best.rate} {best.unit.value} vs {source} {max(top)}")
    return issues


def _mpd(card: Card, rate: float, unit: str) -> float | None:
    """A rate in miles per dollar, converting bank points at the card's first conversion."""
    if unit == "mpd":
        return rate
    conv = card.reward_currency.conversions
    if unit == "points_per_dollar" and conv and conv[0].points:
        return rate * conv[0].partner_units / conv[0].points
    return None


def _compare_milelion(card: Card, review: dict) -> list[str]:
    """Where the curated record disagrees with (or lacks) what The MileLion review states."""
    facts = review.get("facts") or {}
    issues = []
    fee = facts.get("annual_fee")
    if fee and card.annual_fee and abs(card.annual_fee.amount.amount - fee["amount"]) > 0.01:
        issues.append(f"annual fee {card.annual_fee.amount.amount:g} vs milelion {fee['amount']:g}")
    if (inc := facts.get("income")) and card.min_annual_income and abs(card.min_annual_income.amount - inc) > 1:
        issues.append(f"min income {card.min_annual_income.amount:g} vs milelion {inc:g}")
    # the review's "Local Earn" is usually the base rate, sometimes a card's headline bonus rate
    base = next((r for r in card.earn_rules if r.tier == "base"), None)
    rates = [m for r in card.earn_rules if (m := _mpd(card, r.rate, r.unit.value)) is not None]
    if base and rates and (local := facts.get("local_mpd")) is not None \
            and all(abs(m - local) > 0.011 for m in rates):
        mpd = _mpd(card, base.rate, base.unit.value)
        issues.append(f"milelion local earn {local:g} mpd matches no earn rule"
                      + (f" (base {mpd:.2f} mpd)" if mpd is not None else ""))
    cycle, quotes = milelion.review_cycle(review)
    monthly = {Period.calendar_month, Period.statement_month}
    has_monthly = any(r.min_spend_period in monthly or r.max_spend_period in monthly
                      or (r.bonus_cap and r.bonus_cap.period in monthly) for r in card.earn_rules)
    if cycle and (card.spend_cycle_sources or has_monthly) and card.spend_cycle.value != cycle:
        issues.append(f"spend cycle {card.spend_cycle.value} vs milelion {cycle} (“{quotes[0][:120]}”)")
    if card.reward_currency.kind != "cashback":
        exp, have = facts.get("points_expiry"), card.reward_currency.expiry
        if exp and not have:
            issues.append(f"no points expiry; milelion: {review['overview']['points_validity'][0]}")
        elif exp and have and have.model_dump(include={"never", "months", "months_max"}) != \
                {"never": False, "months": None, "months_max": None, **exp}:
            issues.append(f"points expiry {have.model_dump(include={'never', 'months', 'months_max'}, exclude_defaults=True)} "
                          f"vs milelion {exp}")
        convs = card.reward_currency.conversions
        mt, tf = facts.get("min_transfer"), facts.get("transfer_fee")
        if mt and not convs:
            issues.append(f"no conversions; milelion: min. transfer {review['overview']['min_transfer'][0]}, "
                          f"fee {' / '.join(review['overview'].get('transfer_fee') or ['?'])}")
        elif convs and tf is not None and convs[0].fee and abs(convs[0].fee.amount - tf) > 0.01:
            issues.append(f"conversion fee {convs[0].fee.amount:g} vs milelion {tf:g}")
        elif convs and mt and abs(convs[0].points / convs[0].partner_units - mt["points"] / mt["miles"]) > 1e-6:
            issues.append(f"conversion {convs[0].points:g}:{convs[0].partner_units:g} vs milelion "
                          f"{mt['points']:g}:{mt['miles']:g}")
    return issues


def _cycle_unstated(card: Card) -> bool:
    """Monthly min spend or caps, but no source says whether the month is calendar or statement."""
    monthly = {Period.calendar_month, Period.statement_month}
    return not card.spend_cycle_sources and any(
        r.min_spend is not None or r.max_spend is not None or r.bonus_cap is not None
        for r in card.earn_rules if (r.min_spend_period in monthly or r.max_spend_period in monthly
                                     or (r.bonus_cap and r.bonus_cap.period in monthly)))


def _expired_claims(staged: dict[str, list]) -> list[str]:
    """Aggregator text that refers to a date already past, i.e. probably stale data."""
    today = date.today()
    out = []
    for source, items in staged.items():
        for s in items:
            texts = [v.get("note") or "" for v in s.earn_rates.values()] + s.highlights
            for t in texts:
                for m in _DATE_IN_TEXT.finditer(t):
                    d = _parse_date(m.group(1))
                    if d and d < today:
                        out.append(f"{source} / {s.name}: “{m.group(0)}” in: {t[:160]}")
    return out


def _expired_offers(card: Card) -> list[str]:
    today = date.today()
    return [f"{b.offered_by}: {b.description[:80]} (ended {b.valid_to})"
            for b in card.sign_up_bonuses if b.valid_to and b.valid_to < today]


def run() -> dict:
    staged = {s: load_staging(s) for s in ("singsaver", "moneysmart")}
    reviews = milelion.load_reviews()
    cards_out = []
    report: dict[str, list] = {
        "config": validate_config(),
        "invalid": [],
        "stale": [],
        "suggestions": [],
        "conflicts": [],
        "milelion_conflicts": [],
        "cycle_unstated": [],
        "unverified": [],
        "expired_offers": [],
        "missing_tnc": [],
        "unreadable_tnc": [],
        "unmapped": [],
        "no_curated_record": [],
        "expired_aggregator_claims": _expired_claims(staged),
    }
    previous_build = paths.BUILD / "cards.json"
    previous = ({c["id"]: c for c in json.loads(previous_build.read_text())["cards"]}
                if previous_build.exists() else {})
    curated_ids = set()
    for path, card in load_curated():
        if isinstance(card, Exception):
            old = previous.get(path.stem)
            report["invalid"].append(f"{path.name}: {card}" + (
                " (previous build entry kept)" if old else ""))
            if old:
                cards_out.append({**old, "carried_over": True})
                curated_ids.add(path.stem)
            continue
        curated_ids.add(card.id)
        reason = _stale_reason(card)
        if reason:
            card.review.status = ReviewStatus.stale
            report["stale"].append(f"{card.id}: {reason}")
        if card.review.status != ReviewStatus.reviewed:
            report["unverified"].append(f"{card.id} ({card.review.status.value})")
        if not any(c.source_type.value == "official" for c in card.citations):
            report["missing_tnc"].append(card.id)
        tnc_path = paths.STAGING / "tnc" / f"{card.id}.json"
        if tnc_path.exists():
            for d in json.loads(tnc_path.read_text()).get("documents", []):
                if d.get("no_text_layer"):
                    report["unreadable_tnc"].append(f"{card.id}: {d['url']} (image-only PDF)")
                elif d.get("error"):
                    report["unreadable_tnc"].append(f"{card.id}: {d['url']} ({d['error']})")
        report["conflicts"] += [f"{card.id}: {i}" for i in _compare(card, staged)]
        if review := next(iter(milelion.reviews_for(card.id, reviews)), None):
            report["milelion_conflicts"] += [f"{card.id}: {i}" for i in _compare_milelion(card, review)]
        if _cycle_unstated(card):
            report["cycle_unstated"].append(card.id)
        report["expired_offers"] += [f"{card.id}: {i}" for i in _expired_offers(card)]
        card.tags = tagging.card_tags(card)
        data = json.loads(card.model_dump_json(exclude_none=True))
        data["tag_coverage"] = tagging.coverage(card)
        data["excluded_categories"] = tagging.excluded_categories(card)
        cards_out.append(data)

    registry_ids = {c["id"] for c in config.active_cards()}
    for source, items in staged.items():
        for s in items:
            if not s.card_id:
                report["unmapped"].append(f"{source}: {s.name} ({s.source_id})")
    report["no_curated_record"] = sorted(registry_ids - curated_ids)
    report["suggestions"] = [f"{cid}: data/staging/suggestions/{cid}.yaml (+ .diff)"
                             for cid in pending_suggestions()]

    shortlists = _shortlists(cards_out)
    paths.BUILD.mkdir(parents=True, exist_ok=True)
    (paths.BUILD / "cards.json").write_text(json.dumps({
        "built_at": datetime.now().isoformat(timespec="seconds"),
        "count": len(cards_out),
        "shortlists": shortlists,
        "cards": cards_out,
    }, indent=1, ensure_ascii=False))
    (paths.BUILD / "report.md").write_text(_render(report, len(cards_out), shortlists))
    return {k: len(v) for k, v in report.items()}


def _shortlists(cards: list[dict]) -> dict[str, list[dict]]:
    """The card types of interest in the spec. Unreviewed cards are included but labelled."""
    def best(c):
        rules = [r for r in c["earn_rules"] if r.get("tier") == "bonus"] or c["earn_rules"]
        return max(rules, key=lambda r: r["rate"], default=None)

    def row(c):
        b = best(c)
        return {"id": c["id"], "rate": b["rate"] if b else None, "unit": b["unit"] if b else None,
                "status": c["review"]["status"]}

    out = {}
    for unit in ("mpd", "percent"):
        ranked = [c for c in cards if (b := best(c)) and b["unit"] == unit]
        out[f"top_{unit}"] = [row(c) for c in sorted(ranked, key=lambda c: -best(c)["rate"])[:15]]
    out["no_min_spend"] = [row(c) for c in cards if "no_min_spend" in c["tags"]]
    out["uncapped_bonus"] = [row(c) for c in cards if "uncapped_bonus" in c["tags"]]
    out["uncapped_base"] = [row(c) for c in cards if "uncapped_base" in c["tags"]]
    return out


SECTIONS = [
    ("config", "Config problems"),
    ("invalid", "Invalid curated records"),
    ("stale", "Stale reviews (official T&C changed)"),
    ("suggestions", "Reviewed cards whose sources changed (merge suggestions by hand, then delete them)"),
    ("conflicts", "Curated value disagrees with an aggregator"),
    ("milelion_conflicts", "Curated value disagrees with, or lacks, what The MileLion review states"),
    ("cycle_unstated", "Monthly min spend or caps, but no source states calendar vs statement month"),
    ("expired_offers", "Expired sign-up offers in curated records"),
    ("expired_aggregator_claims", "Aggregator text referring to past dates (likely outdated)"),
    ("missing_tnc", "Curated cards without an official citation"),
    ("unreadable_tnc", "Official T&C documents that could not be read automatically"),
    ("unverified", "Not yet reviewed"),
    ("no_curated_record", "Registered cards with no curated record (run `pocketaces curate`)"),
    ("unmapped", "Aggregator cards not in config/cards.yaml (run `pocketaces discover`)"),
]


def _render(report: dict, n: int, shortlists: dict) -> str:
    lines = [f"# Data build report — {date.today().isoformat()}", "", f"{n} curated cards built.", ""]
    lines += ["## Shortlists", "", "Unreviewed cards are marked; treat their figures as unverified.", ""]
    for name, rows in shortlists.items():
        items = ", ".join(f"{r['id']} ({r['rate']} {r['unit']}{'' if r['status'] == 'reviewed' else ', ' + r['status']})"
                          for r in rows)
        lines.append(f"- **{name}**: {items or 'none'}")
    lines.append("")
    for key, title in SECTIONS:
        items = report[key]
        lines.append(f"## {title} ({len(items)})")
        lines.append("")
        lines += [f"- {i}" for i in items] or ["None."]
        lines.append("")
    return "\n".join(lines)
