"""Generate curated card drafts from staged evidence.

A draft is a valid `Card` whose every value cites the staged source it came from. Drafts are
regenerated on every refresh. Reviewers correct a draft against the official T&Cs and set
`review.status: reviewed`; reviewed (or stale) records are never overwritten. The latest machine
draft of every card is kept in data/staging/drafts/; when a refresh changes the draft of a
reviewed card, the new draft goes to data/staging/suggestions/<card_id>.yaml, with a diff against
the curated record in <card_id>.diff, for a human to merge by hand. Delete both once handled.
"""

from __future__ import annotations

import difflib
import json
import logging
import re
from datetime import date
from pathlib import Path

import yaml

from . import paths, registry
from .models import (
    AnnualFee, Cap, Card, Citation, EarnRule, Eligibility, Money, Period, RewardCurrency, SignUpBonus,
    SpendCycle, StagedCard,
)
from .sources.common import load_staging

log = logging.getLogger(__name__)

SUGGESTIONS = paths.STAGING / "suggestions"
DRAFTS = paths.STAGING / "drafts"  # latest machine draft per card: the baseline for change detection

# SingSaver category keys → our tags (only where the meaning is unambiguous)
CATEGORY_TAGS = {
    "dining": ["dining"],
    "petrol": ["petrol"],
    "supermarket": ["groceries"],
    "grocery": ["groceries"],
    "flight_booking": ["flights"],
    "hotel_booking": ["hotels"],
    "travel": ["travel"],
    "transport": ["transport"],
    "taxi_ride_sharing": ["ride_hailing"],
    "entertainment": ["entertainment"],
    "department_store": ["shopping"],
    "retail": ["shopping"],
    "health": ["healthcare"],
}
BASE_KEYS = {"baseline", "local", "local_spending"}

_CAP = re.compile(
    r"cap(?:ped)?\s+(?:at\s+)?(?:S\$\s?)?([\d,]+(?:\.\d+)?)\s*(bonus\s+)?"
    r"(miles|points|OCBC\$|cashback|rebate)?[^.]{0,40}?\b(?:per|a|each)\s+"
    r"(calendar\s+month|statement\s+month|month|statement|quarter|year)", re.I)
_MODES = {"online": "online", "contactless": "contactless", "apple pay": "mobile_wallet",
          "google pay": "mobile_wallet", "samsung pay": "mobile_wallet", "in-app": "in_app"}


def _cap_from_text(text: str, unit: str, month: Period = Period.calendar_month):
    m = _CAP.search(text or "")
    if not m:
        return None, []
    amount = float(m.group(1).replace(",", ""))
    what = (m.group(3) or "").lower()
    cap_unit = ("miles" if "mile" in what else "points" if what in ("points", "ocbc$")
                else "SGD_cashback" if what in ("cashback", "rebate") or unit == "percent"
                else "SGD_spend")
    period = m.group(4).lower()
    period = ("statement_month" if "statement" in period else "quarter" if "quarter" in period
              else "calendar_year" if "year" in period
              else "calendar_month" if "calendar" in period else month)
    return Cap(amount=amount, unit=cap_unit, period=period), [
        f"bonus_cap parsed from aggregator text “{m.group(0)}” — confirm amount, unit and "
        "whether the period is calendar or statement month"]


def _modes_from_text(text: str) -> list[str]:
    t = (text or "").lower()
    return sorted({mode for word, mode in _MODES.items() if word in t})


def _staged(card_id: str) -> dict[str, StagedCard]:
    out = {}
    for source in ("singsaver", "moneysmart"):
        for c in load_staging(source):
            if c.card_id == card_id:
                out[source] = c
    return out


def _tnc(card_id: str) -> dict:
    p = paths.STAGING / "tnc" / f"{card_id}.json"
    return json.loads(p.read_text()) if p.exists() else {}


def _spend_cycle(tnc: dict) -> tuple[SpendCycle | None, list[str], list[str]]:
    """The spend cycle the official T&Cs state, the citations saying so, and review notes.
    Verified LLM output wins; otherwise the regex evidence must agree across all documents, since
    campaign T&Cs often sit next to the card's own and use a different month."""
    docs = [d for d in tnc.get("documents", []) if "citation" in d]
    llm = tnc.get("llm") or {}
    if llm.get("spend_cycle") and llm.get("spend_cycle_evidence"):
        cycle = SpendCycle(llm["spend_cycle"])
        quotes = llm.get("spend_cycle_evidence") or []
        flat = lambda t: " ".join(t.split()).lower()
        cites = [d["citation"]["id"] for d in docs
                 if (paths.ROOT / d["text_path"]).exists()
                 and any(flat(q) in flat((paths.ROOT / d["text_path"]).read_text()) for q in quotes)]
        return cycle, cites or [d["citation"]["id"] for d in docs], [
            f"spend_cycle {cycle.value} from LLM T&C extraction (“{quotes[0][:200]}”) — confirm it "
            "applies to min spend and caps"]
    found: dict[str, list[str]] = {}
    for d in docs:
        for cycle in (d.get("spend_cycle") or {}):
            found.setdefault(cycle, []).append(d["citation"]["id"])
    if len(found) == 1:
        (cycle, cites), = found.items()
        quote = next(q for d in docs for q in (d.get("spend_cycle") or {}).get(cycle, []))
        return SpendCycle(cycle), cites, [
            f"spend_cycle {cycle} auto-extracted from official T&C (“{quote[:200]}”) — confirm it "
            "applies to min spend and caps"]
    if found:
        return None, [], ["T&Cs mention both statement and calendar months for spend or caps "
                          "(see spend_cycle in data/staging/tnc) — set spend_cycle by hand"]
    return None, [], []


def _reviews(card_id: str) -> list[dict]:
    """Milelion reviews of this card (editorial cross-check links)."""
    p = paths.STAGING / "milelion" / "reviews.json"
    if not p.exists():
        return []
    return [r for r in json.loads(p.read_text())
            if r.get("card_id") == card_id or card_id in registry.match_name(r["card_name"])]


# Sign-up offer terms: the qualifying spend ("make a min. spend of S$800 within 60 days", "spend at
# least S$400 …", "Reach S$1K spend"), who qualifies, stacking, and Moneysmart's "Apply … by 30th Sept 2026".
_OFFER_MIN = re.compile(
    r"(?:min(?:imum|\.)?\s+(?:spend\s+)?(?:of\s+|criteria\s*\(\s*)?|spend\s+at\s+least\s+|reach\s+)"
    r"S\$\s*([\d,]+(?:\.\d+)?)(K\b)?", re.I)
_OFFER_WITHIN = re.compile(r"within\s+(?:the\s+first\s+)?(\d+)\s+(day|month)s?", re.I)
_OFFER_NEW = re.compile(r"\bnew[- ]to[- ]\w|\bnew\s+(?:[\w/&-]+\s+){0,4}?(?:card\s?members|customers|cardholders)\b", re.I)
_OFFER_STACK = re.compile(r"(does\s+not|not)\s+stack|\bstackable\b", re.I)
_OFFER_BY = re.compile(r"\ba\s?pply\b.*?\bby\s+(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?\s+(\d{4})", re.I)
_MONTHS = {m: i for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split(), 1)}
_CASH = re.compile(r"S\$\s*([\d,]+)\s+(?:cash|cashback)\b", re.I)


def _sentences(text: str) -> list[str]:
    # "min. spend" and "incl. GST" don't end a sentence: only a stop before a capital does
    return re.split(r"(?<=[.;])\s+(?=[A-Z])|\s*•\s*|\s+-\s+", text)


def _offer_terms(terms: str) -> dict:
    """Qualifying conditions stated in a sign-up offer's terms (only what the text says outright)."""
    text = " ".join(terms.split())
    out: dict = {}
    for sentence in _sentences(text):
        m = _OFFER_MIN.search(sentence)
        if m and re.search(r"spend|charge", sentence, re.I):
            amount = float(m[1].replace(",", "")) * (1000 if m[2] else 1)
            out["min_spend"] = Money(amount=amount)
            if w := _OFFER_WITHIN.search(sentence, m.end()):
                out["spend_within_days"] = int(w[1]) * (30 if w[2].lower() == "month" else 1)
            break
    if _OFFER_NEW.search(text):
        out["new_to_bank_only"] = True
    if st := _OFFER_STACK.search(text):
        out["stackable"] = not st[1]
    for by in filter(None, map(_OFFER_BY.search, _sentences(text))):
        if by[2].lower() in _MONTHS:
            try:
                out["valid_to"] = date(int(by[3]), _MONTHS[by[2].lower()], int(by[1]))
            except ValueError:
                continue
            break
    return out


def _cash_value(options: list[str]) -> float | None:
    """Headline value of a gift list: its cash option, since other gifts often need a top-up."""
    return next((float(m[1].replace(",", "")) for o in options if (m := _CASH.search(o))), None)


def _date(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


def _kind(reg: dict, ss: StagedCard | None) -> str:
    if reg.get("reward_kind"):
        return reg["reward_kind"]
    units = {v["unit"] for v in (ss.earn_rates.values() if ss else [])
             if v.get("value") is not None}
    if "mpd" in units:
        return "miles"
    if "points_per_dollar" in units:
        return "points"
    return "cashback"


def build_draft(card_id: str) -> Card:
    reg = registry.get(card_id)
    if not reg:
        raise KeyError(f"{card_id} not in config/cards.yaml")
    staged = _staged(card_id)
    tnc = _tnc(card_id)
    ss, ms = staged.get("singsaver"), staged.get("moneysmart")

    citations: dict[str, Citation] = {}
    for s in staged.values():
        citations[s.citation.id] = s.citation
    tnc_cites = []
    for d in tnc.get("documents", []):
        if "citation" in d:
            c = Citation(**d["citation"])
            citations[c.id] = c
            tnc_cites.append(c.id)

    review_notes = []
    for r in _reviews(card_id):
        c = Citation(**r["citation"])
        citations[c.id] = c
        review_notes.append(f"Editorial review for cross-checking: {r['title']} ({r['url']}, "
                            f"updated {r['modified'][:10]})")

    cycle, cycle_cites, cycle_notes = _spend_cycle(tnc)
    # an aggregator's "per month" means the T&C spend cycle when one is known
    month = Period(cycle.value) if cycle else Period.statement_month

    kind = _kind(reg, ss)
    unit = {"miles": "mpd", "cashback": "percent", "points": "points_per_dollar"}[kind]
    # One draft rule per distinct rate: SingSaver repeats the same bonus under several categories.
    grouped: dict[tuple, dict] = {}
    if ss:
        has_baseline = f"{unit}:baseline" in ss.earn_rates
        for key, v in ss.earn_rates.items():
            u, cat = key.split(":", 1)
            val = v.get("value")
            if u != unit or val is None:
                continue
            rate = val["max"] if isinstance(val, dict) else val
            if rate is None:
                continue
            is_base = cat == "baseline" or (not has_baseline and cat in BASE_KEYS)
            g = grouped.setdefault((rate, is_base),
                                   {"cats": [], "tags": [], "rate": rate, "notes": [],
                                    "base": is_base})
            g["cats"].append(cat)
            if v.get("note") and v["note"] not in g["notes"]:
                g["notes"].append(v["note"])
            g["tags"] += [t for t in CATEGORY_TAGS.get(cat, []) if t not in g["tags"]]
    tnc_include = sorted({c for d in tnc.get("documents", []) for c in d.get("mcc", {}).get("include", [])},
                         key=lambda c: (int(c[:4]), c))
    bonus_rates = {g["rate"] for g in grouped.values() if not g["base"]}
    # Aggregators give one card-level monthly minimum; attach it to every bonus rule.
    min_src = next((s for s in (ss, ms) if s and s.min_monthly_spend), None)
    rules: list[EarnRule] = []
    for g in sorted(grouped.values(), key=lambda g: (g["base"], -g["rate"])):
        top = not g["base"] and g["rate"] == max(bonus_rates, default=None)
        include = tnc_include if top and tnc_include else []
        text = " ".join(g["notes"])
        cap, cap_notes = (None, []) if g["base"] else _cap_from_text(text, unit, month)
        rules.append(EarnRule(
            id="base" if g["base"] else re.sub(r"[^a-z0-9]+", "-", g["cats"][0]),
            label=f"{', '.join(c.replace('_', ' ') for c in g['cats'])} (SingSaver — verify)",
            rate=g["rate"],
            unit=unit,
            tier="base" if g["base"] else "bonus",
            eligibility=Eligibility(
                all_spend=g["base"],
                # official MCC list supersedes aggregator category labels
                tags=[] if include else g["tags"],
                include_mcc=include,
                modes_required=[] if g["base"] else _modes_from_text(text),
                description=" / ".join(g["notes"]) + (
                    " [include_mcc auto-extracted from official T&C — check it belongs to this rule]"
                    if include else ""),
                sources=[ss.citation.id] + (tnc_cites if include else []),
            ),
            min_spend=Money(amount=min_src.min_monthly_spend) if min_src and not g["base"] else None,
            min_spend_period=month if min_src and not g["base"] else None,
            bonus_cap=Cap(**cap.model_dump(exclude={"sources"}), sources=[ss.citation.id]) if cap else None,
            conditions=cap_notes + ([f"aggregator categories: {', '.join(g['tags'])}"]
                                    if include and g["tags"] else [])
                       + ([f"min spend S${min_src.min_monthly_spend:g}/month from {min_src.source} — "
                           + ("confirm which rules it unlocks" if cycle else
                              "confirm the period (statement vs calendar month) and which rules it unlocks")]
                          if min_src and not g["base"] else []),
            sources=[ss.citation.id],
        ))

    exclude = sorted({c for d in tnc.get("documents", []) for c in d.get("mcc", {}).get("exclude", [])},
                     key=lambda c: (int(c[:4]), c))
    general = Eligibility(
        exclude_mcc=exclude,
        description="Auto-extracted from official T&Cs — confirm each code applies to this card",
        sources=tnc_cites if exclude else [],
    )

    fee = None
    fee_src = ss if ss and ss.annual_fee is not None else ms if ms and ms.annual_fee is not None else None
    if fee_src:
        note = fee_src.annual_fee_note or ""
        fee = AnnualFee(
            amount=Money(amount=fee_src.annual_fee),
            first_year_waived=True if "first year" in note.lower() and "waiv" in note.lower() else None,
            waiver_notes=note or None,
            sources=[fee_src.citation.id],
        )
    income_src = next((s for s in (ss, ms) if s and s.min_annual_income), None)

    bonuses = []
    if ss:
        for o in ss.sign_up_offers:
            gifts = [g for g in o.get("gifts") or [] if g.get("title")]
            options = [g["title"] for g in gifts]
            title = (o.get("title") or "Offer").strip()
            # headline value = the cash option (other gifts often need a top-up)
            value = next((g["value_sgd"] for g in gifts
                          if g.get("value_sgd") and "cash" in g["title"].lower()), None)
            terms = o.get("terms") or ""
            parsed = _offer_terms(terms)
            parsed.pop("valid_to", None)  # SingSaver states validity as structured dates
            bonuses.append(SignUpBonus(
                offered_by=ss.source,
                description=title + (": choice of " + "; ".join(options) if options else ""),
                options=options,
                value=Money(amount=value) if value else None,
                **parsed,
                terms=" ".join(terms.split()) or None,
                valid_from=_date(o.get("valid_from")),
                valid_to=_date(o.get("valid_to")),
                url=o.get("tnc_url") or ss.source_url,
                sources=[ss.citation.id],
            ))
    if ms and ms.sign_up_offers:
        # Moneysmart lists one entry per gift option of a single campaign
        titles = [o["title"] for o in ms.sign_up_offers if o.get("title")]
        terms = next((o["terms"] for o in ms.sign_up_offers if o.get("terms")), "")
        value = _cash_value(titles)
        bonuses.append(SignUpBonus(
            offered_by=ms.source,
            description="Choice of: " + "; ".join(titles),
            options=titles,
            value=Money(amount=value) if value else None,
            **_offer_terms(terms),
            terms=" ".join(terms.split()) or None,
            url=ms.source_url,
            sources=[ms.citation.id],
        ))

    notes = cycle_notes + review_notes
    if not rules:
        notes.insert(0, "No structured earn rates from aggregators: add earn_rules from the "
                        "official T&C before review")
    non_mcc = sorted({x for d in tnc.get("documents", []) for x in d.get("non_mcc_exclusions", [])})
    if non_mcc:
        notes.append("T&C mentions (check whether excluded): " + ", ".join(non_mcc))
    network = None
    for s in (ss, ms):
        nets = (s.extra.get("network") if s else None) or []
        if nets:
            n = nets[0].lower().replace("american express", "amex")
            network = n if n in {"visa", "mastercard", "amex", "unionpay", "jcb"} else None
            break

    return Card(
        id=card_id,
        bank=reg["bank"],
        name=reg["name"],
        network=network,
        image_url=(ss.image_url if ss else None) or (ms.image_url if ms else None),
        official_url=(reg.get("official") or {}).get("product_page"),
        annual_fee=fee,
        min_annual_income=Money(amount=income_src.min_annual_income) if income_src else None,
        reward_currency=RewardCurrency(kind=kind, name=reg.get("reward_currency_name") or kind.title()),
        earn_rules=rules,
        **({"spend_cycle": cycle, "spend_cycle_sources": cycle_cites} if cycle else {}),
        general_exclusions=general,
        sign_up_bonuses=bonuses,
        notes=notes,
        citations=list(citations.values()),
        updated_at=date.today(),
    )


class _Dumper(yaml.SafeDumper):
    pass


def _repr_list(dumper, data):
    flow = all(isinstance(x, (str, int, float)) and len(str(x)) < 40 for x in data)
    return dumper.represent_sequence("tag:yaml.org,2002:seq", data, flow_style=flow)


_Dumper.add_representer(list, _repr_list)

_KEEP_FALSE = {"first_year_waived", "new_to_bank_only", "stackable"}


def _prune(obj, key=None):
    """Drop empty lists/dicts and default False flags so drafts stay readable."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            v = _prune(v, k)
            if v in ([], {}, None) or (v is False and k not in _KEEP_FALSE):
                continue
            out[k] = v
        return out
    if isinstance(obj, list):
        return [_prune(v) for v in obj]
    return obj


def _dump(card: Card) -> str:
    data = _prune(json.loads(card.model_dump_json(exclude_none=True)))
    data.setdefault("earn_rules", [])  # required, even when empty
    if not data.get("spend_cycle_sources"):
        data.pop("spend_cycle", None)  # the model's default, not something a source stated
    header = (
        "# Curated card record. Auto-drafted from staged sources; verify every value against the\n"
        "# official T&Cs (citations below), then set review.status: reviewed.\n"
    )
    return header + yaml.dump(data, Dumper=_Dumper, sort_keys=False, allow_unicode=True, width=100)


def _facts(text: str) -> dict:
    """A record's content minus what changes without the facts changing (review state, fetch times)."""
    data = yaml.safe_load(text) or {}
    data.pop("review", None)
    for c in data.get("citations", []):
        c.pop("retrieved_at", None)
        c.pop("snapshot", None)
    return data


def _diff(old: str, new: str, card_id: str) -> str:
    strip = lambda t: [ln for ln in t.splitlines(keepends=True) if not ln.startswith("#")]
    return "".join(difflib.unified_diff(strip(old), strip(new), f"curated/cards/{card_id}.yaml",
                                        f"suggestions/{card_id}.yaml"))


def curate(card_id: str) -> Path | None:
    """Refresh a card's curated draft. Drafts are overwritten on every run; reviewed (or stale)
    records are never overwritten. Instead, if the machine draft has changed since the last run,
    it is written to suggestions/ with a diff for manual review. If the draft can't be built,
    the existing file is left as it was."""
    path = paths.CURATED_CARDS / f"{card_id}.yaml"
    try:
        draft = build_draft(card_id)
    except Exception:
        log.exception("%s: draft generation failed — keeping %s", card_id,
                      "existing record" if path.exists() else "no record")
        return None
    text = _dump(draft)
    baseline = DRAFTS / f"{card_id}.yaml"
    changed = not baseline.exists() or _facts(baseline.read_text()) != _facts(text)
    DRAFTS.mkdir(parents=True, exist_ok=True)
    baseline.write_text(text)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        current = path.read_text()
        status = ((yaml.safe_load(current) or {}).get("review") or {}).get("status", "draft")
        if status != "draft":
            out = SUGGESTIONS / f"{card_id}.yaml"
            if not changed:
                log.info("%s: record is %s and sources are unchanged — nothing to suggest", card_id, status)
                return out if out.exists() else None
            if _facts(current) == _facts(text):
                log.info("%s: record is %s and already matches the new draft", card_id, status)
                out.unlink(missing_ok=True)
                out.with_suffix(".diff").unlink(missing_ok=True)
                return None
            SUGGESTIONS.mkdir(parents=True, exist_ok=True)
            out.write_text(text)
            out.with_suffix(".diff").write_text(_diff(current, text, card_id))
            log.warning("%s: record is %s but sources changed — review %s (and .diff) and update "
                        "the record by hand", card_id, status, out.relative_to(paths.ROOT))
            return out
    path.write_text(text)
    log.info("%s: draft written to %s", card_id, path.relative_to(paths.ROOT))
    return path


def pending_suggestions() -> list[str]:
    """Card ids with a suggestion file awaiting manual review."""
    return sorted(p.stem for p in SUGGESTIONS.glob("*.yaml")) if SUGGESTIONS.exists() else []


def load_curated() -> list[tuple[Path, Card | Exception]]:
    out = []
    for p in sorted(paths.CURATED_CARDS.glob("*.yaml")):
        try:
            out.append((p, Card.model_validate(yaml.safe_load(p.read_text()))))
        except Exception as e:
            out.append((p, e))
    return out
