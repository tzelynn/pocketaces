"""The MileLion (milelion.com), read via the WordPress REST API.

Used for (1) card reviews: each review's "Overview" table (points validity, transfer fee and
block, annual fee, income, earn rates) and its statements of whether caps / min spend count per
calendar or statement month. These are the primary source for points expiry, conversion fees and
the spend cycle in curated drafts, and cross-check the rest (see `build._compare_milelion`).
(2) Mining "MCC ####" mentions next to merchant names as merchant→MCC *candidates* (never
auto-accepted; see `pocketaces merchants`).
"""

from __future__ import annotations

import json
import logging
import re
from html import unescape

from bs4 import BeautifulSoup

from .. import config, paths, registry
from ..fetch import Fetcher
from ..models import SourceType
from .common import citation, html_to_text

log = logging.getLogger(__name__)

SOURCE = "milelion"
_REVIEW_TITLE = re.compile(r"^(?:\d{4} Edition:\s*)?Review:\s*(.+)$", re.I)
_MCC_MENTION = re.compile(r"\bMCCs?\s*(?:of|:|=)?\s*(\d{4})\b")
_MPD_CLAIM = re.compile(r"[^.\n]*\b\d+(?:\.\d+)?\s*(?:mpd|miles per dollar|% cashback)[^.\n]*[.\n]", re.I)


# -- review overview table -----------------------------------------------------------------------

# Overview table labels (lowercased, letters only) → our keys
_LABELS = {
    "incomereq": "income", "minincome": "income", "pointsvalidity": "points_validity",
    "annualfee": "annual_fee", "mintransfer": "min_transfer", "mileswithannualfee": "miles_with_fee",
    "mileswithaf": "miles_with_fee", "transferpartners": "transfer_partners", "fcyfee": "fcy_fee",
    "transferfee": "transfer_fee", "localearn": "local_earn", "pointspool": "points_pool",
    "fcyearn": "fcy_earn", "loungeaccess": "lounge_access", "specialearn": "special_earn",
    "airportlimo": "airport_limo",
}


def _label(text: str) -> str | None:
    return _LABELS.get(re.sub(r"[^a-z]", "", text.lower()))


def overview_table(html: str) -> dict[str, list[str]]:
    """The review's key-facts table as {key: [cell text, …]}. A key has several values when the
    review covers card variants (UOB Lady's / Lady's Solitaire span one label over two rows)."""
    soup = BeautifulSoup(html, "lxml")
    table = next((t for t in soup.find_all("table")
                  if sum(bool(_label(td.get_text(" "))) for td in t.find_all("td")) >= 4), None)
    if table is None:
        return {}
    # lay the cells out on a grid, expanding rowspans, so a value in a continuation row sits
    # next to the label it belongs to
    grid: dict[tuple[int, int], object] = {}
    for r, tr in enumerate(table.find_all("tr")):
        c = 0
        for td in tr.find_all(["td", "th"]):
            while (r, c) in grid:
                c += 1
            span_r, span_c = int(td.get("rowspan") or 1), int(td.get("colspan") or 1)
            for dr in range(span_r):
                for dc in range(span_c):
                    grid[(r + dr, c + dc)] = td
            c += span_c
    out: dict[str, list[str]] = {}
    seen: set[int] = set()
    for (r, c), td in sorted(grid.items()):
        key = _label(td.get_text(" "))
        value = grid.get((r, c + 1))
        if not key or value is None or value is td or _label(value.get_text(" ")) or id(value) in seen:
            continue
        seen.add(id(value))
        text = " ".join(value.get_text(" ").split())
        if text:
            out.setdefault(key, []).append(text)
    return out


_NUM = r"(\d[\d,]*(?:\.\d+)?)"


def _n(s: str) -> float:
    return float(s.replace(",", ""))


def parse_validity(text: str) -> dict | None:
    """'No Expiry' / '3 years' / '37 months' / '12-15 months' / 'Up to 5 yrs.' → PointsExpiry
    fields, or None if the text says something else."""
    t = text.lower()
    if re.search(r"\bno\s+expiry\b|\bnever\b|\bdon.?t\s+expire|\bnon-expiring\b", t):
        return {"never": True}
    m = re.fullmatch(r"(up\s+to\s+)?(\d+)(?:\s*[-–]\s*(\d+))?\s*(years?|yrs?|months?|mths?)\.?", t.strip())
    if not m:
        return None
    k = 12 if m[4].startswith("y") else 1
    lo, hi = int(m[2]) * k, int(m[3]) * k if m[3] else None
    if m[1]:
        return {"months_max": hi or lo}
    return {"months": lo, **({"months_max": hi} if hi else {})}


def parse_fee(text: str) -> float | None:
    """'S$27.25' → 27.25; 'Free' / 'None' → 0. 'N/A' (nothing to convert) and anything else → None."""
    t = text.strip().lower()
    if t in ("free", "none", "nil", "waived", "s$0"):
        return 0.0
    m = re.fullmatch(r"s\$\s*" + _NUM + r"(?:\s*\(.*\))?\*?", t)
    return _n(m[1]) if m else None


def parse_min_transfer(text: str) -> dict | None:
    """'25,000 TY points (10,000 miles)' → {points: 25000, points_name: 'TY points', miles: 10000}.
    Footnote marks ('…miles)^', '90°N Miles*') and 'Up to' are ignored."""
    t = re.sub(r"[*^†‡#]+", "", text).strip()
    m = re.fullmatch(_NUM + r"\s+(.+?)\s*\(\s*(?:up\s+to\s+)?" + _NUM + r"\s+(?:\w+\s+)?miles?\s*\)", t, re.I)
    return {"points": _n(m[1]), "points_name": m[2], "miles": _n(m[3])} if m else None


def parse_mpd(text: str) -> float | None:
    """'1.2 mpd' → 1.2 (not 'Up to 3.2 mpd': that is a best case, not the base rate)."""
    m = re.fullmatch(_NUM + r"\s*mpd", text.strip(), re.I)
    return _n(m[1]) if m else None


def parse_annual_fee(text: str) -> dict | None:
    """'S$196.20 (First Year Free)' / '(FYF)' / '(2 Years Free)' / '(F2YF)' / 'None' →
    {amount, first_year_free}."""
    if text.strip().lower() in ("none", "free", "nil"):
        return {"amount": 0.0}
    m = re.fullmatch(r"S\$\s*" + _NUM + r"\s*(\([^)]*\))?\s*\*?", text.strip(), re.I)
    if not m:
        return None
    waived = bool(m[2] and re.search(r"\bfree\b|\bF\d?YF\b|waive", m[2], re.I))
    return {"amount": _n(m[1]), **({"first_year_free": True} if waived else {})}


def parse_income(text: str) -> float | None:
    """'S$30,000 p.a.' → 30000; several amounts ('S$30,000 p.a. (with …) S$65,000 p.a.') → None."""
    amounts = re.findall(r"S\$\s*" + _NUM + r"(K)?\s*p\.a\.", text, re.I)
    if len(amounts) != 1:
        return None
    return _n(amounts[0][0]) * (1000 if amounts[0][1] else 1)


def key_facts(table: dict[str, list[str]]) -> dict:
    """Parsed values of an overview table. Only single-valued cells are parsed: a review of card
    variants (several values per label) can't say which value is which card's."""
    def one(key, parse):
        vals = table.get(key) or []
        return parse(vals[0]) if len(vals) == 1 else None

    facts = {
        "points_expiry": one("points_validity", parse_validity),
        "transfer_fee": one("transfer_fee", parse_fee),
        "min_transfer": one("min_transfer", parse_min_transfer),
        "annual_fee": one("annual_fee", parse_annual_fee),
        "income": one("income", parse_income),
        "local_mpd": one("local_earn", parse_mpd),
        "fcy_mpd": one("fcy_earn", parse_mpd),
    }
    if (table.get("min_transfer") or [""])[0].strip().upper() == "N/A":
        facts["converts"] = False  # earns airline miles directly (e.g. AMEX KrisFlyer)
    return {k: v for k, v in facts.items() if v is not None}


# "capped at S$1,000 per statement month", "min spend of S$800 per calendar month". Sentences about
# crediting points, limo/lounge perks, redemption limits or bank accounts say nothing about when
# the card's own min spend and caps reset.
_CYCLE = re.compile(r"\b(?:per|each|every|a|in\s+a|within\s+the|the\s+same)\s+"
                    r"(calendar|statement)(?:\s+|-)(?:month|cycle)\b", re.I)
_CYCLE_TOPIC = re.compile(r"\bcap(?:s|ped)?\b|\bmin(?:imum|\.)?\s+spend|\bspend(?:s|ing)?\s+(?:at\s+least|of)\b"
                          r"|\bbonus\b|\bmax(?:imum)?\b|\bearn", re.I)
_CYCLE_OFF_TOPIC = re.compile(r"credit(?:ed|s)\b|\blimo|\blounge|\bKLIA|\bredeem|\bredemption|\bsalary"
                              r"|\bsavings?\s+account|\bOne\s+Account|\bGIRO\b|\bprevious\s+calendar", re.I)


def spend_cycle_evidence(text: str) -> dict[str, list[str]]:
    """{'calendar_month' | 'statement_month': [quotes]} from a review's body text, counting only
    mentions about caps, min spend or bonus earning. Each mention is judged by its sentence,
    clipped to ±150 characters (tables flatten into run-on "sentences")."""
    flat = " ".join(text.split())
    out: dict[str, list[str]] = {}
    for sentence in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9])", flat):
        for m in _CYCLE.finditer(sentence):
            start, end = max(0, m.start() - 150), min(len(sentence), m.end() + 150)
            if start:
                start = sentence.find(" ", start) + 1
            if end < len(sentence):
                end = sentence.rfind(" ", 0, end)
            quote = sentence[start:end].strip()
            if not _CYCLE_TOPIC.search(quote) or _CYCLE_OFF_TOPIC.search(quote):
                continue
            key = f"{m[1].lower()}_month"
            if quote not in out.get(key, []):
                out.setdefault(key, []).append(quote)
    return out


def _card_ids(slug: str, card_name: str) -> list[str]:
    """Registry ids a review covers: an explicit `sources.milelion` slug, else a name/alias match
    (one review can cover card variants, e.g. DBS Altitude AMEX and Visa)."""
    found = registry.lookup(SOURCE, slug)
    return [found] if found else registry.match_name(card_name)


def _post_index(f: Fetcher, cfg: dict) -> list[dict]:
    """Metadata of every post in the credit card category.

    Note: this WordPress install returns an empty body when a category/search filter is combined
    with `content`, so content is fetched per post afterwards (see `_content`).
    """
    out: list[dict] = []
    page = 1
    while page <= cfg.get("max_pages", 30):
        url = (f"{cfg['api']}/posts?categories={cfg['credit_card_category_id']}&per_page=100"
               f"&page={page}&_fields=id,date,modified,link,slug,title")
        try:
            _, posts = f.get_json(url, name=f"index-p{page}")
        except Exception as e:  # WP returns 400 past the last page
            log.debug("stop paging: %s", e)
            break
        if not posts:
            break
        out.extend(posts)
        page += 1
    return out


def _content(f: Fetcher, cfg: dict, post_id: int):
    snap, post = f.get_json(f"{cfg['api']}/posts/{post_id}?_fields=id,content", name=f"post-{post_id}")
    return snap, post["content"]["rendered"]


def _wanted(title: str) -> bool:
    return bool(_REVIEW_TITLE.match(title)) or bool(re.search(r"\bMCCs?\b", title))


def load_reviews() -> list[dict]:
    p = paths.STAGING / SOURCE / "reviews.json"
    return json.loads(p.read_text()) if p.exists() else []


def reviews_for(card_id: str, reviews: list[dict] | None = None) -> list[dict]:
    """Reviews covering a card, newest first. Staging written before `card_ids` existed is
    matched by name."""
    hits = [r for r in (load_reviews() if reviews is None else reviews)
            if card_id in (r.get("card_ids") or ([r["card_id"]] if r.get("card_id") else [])
                           or registry.match_name(r["card_name"]))]
    return sorted(hits, key=lambda r: r.get("modified") or r.get("published") or "", reverse=True)


def review_cycle(review: dict) -> tuple[str | None, list[str]]:
    """The spend cycle a review states for caps / min spend — only when all its mentions agree —
    and the quotes saying so."""
    ev = review.get("spend_cycle") or {}
    if len(ev) == 1:
        (cycle, quotes), = ev.items()
        return cycle, quotes
    return None, []


def _key(review: dict) -> str:
    return ",".join(review.get("card_ids") or []) or review["card_name"].lower()


def run(limit: int | None = None) -> dict:
    cfg = config.sources()[SOURCE]
    reviews: list[dict] = []
    mentions: list[dict] = []
    with Fetcher(SOURCE, delay=cfg.get("delay", 1.5)) as f:
        index = _post_index(f, cfg)
        wanted = [p for p in index if _wanted(unescape(p["title"]["rendered"]))][:limit]
        log.info("milelion: %d credit card posts, fetching %d reviews/MCC posts",
                 len(index), len(wanted))
        posts = []
        failed_urls: set[str] = set()
        for p in wanted:
            try:
                snap, html = _content(f, cfg, p["id"])
            except Exception as e:
                log.warning("milelion post %s: %s", p["link"], e)
                failed_urls.add(p["link"])
                continue
            posts.append((snap, p, html))
    if not index:
        log.error("milelion: post index empty — keeping previous staging data")
        return {"reviews": 0, "mcc_mentions": 0}
    for snap, p, html in posts:
        title = unescape(p["title"]["rendered"])
        text = html_to_text(html)
        cite = citation(snap, SourceType.editorial, title).model_dump(exclude_none=True)
        cite["url"] = p["link"]  # cite the article, not the API page
        for m in _MCC_MENTION.finditer(text):
            start = max(0, text.rfind("\n", 0, m.start()))
            end = text.find("\n", m.end())
            mentions.append({"mcc": m.group(1), "context": text[start:end if end > 0 else None].strip()[:400],
                             "url": p["link"], "post_modified": p["modified"]})
        if not (tm := _REVIEW_TITLE.match(title)):
            continue
        card_name = tm.group(1).strip()
        ids = _card_ids(p["slug"], card_name)
        table = overview_table(html)
        reviews.append({
            "card_id": ids[0] if len(ids) == 1 else None,
            "card_ids": ids,
            "card_name": card_name,
            "title": title,
            "url": p["link"],
            "slug": p["slug"],
            "published": p["date"],
            "modified": p["modified"],
            "earn_claims": [" ".join(c.split()) for c in _MPD_CLAIM.findall(text)][:40],
            "mcc_mentions": sorted({m.group(1) for m in _MCC_MENTION.finditer(text)}),
            "overview": table,
            "facts": key_facts(table),
            "spend_cycle": spend_cycle_evidence(text),
            "citation": cite,
        })
    # keep only the latest review per card
    latest: dict[str, dict] = {}
    for r in sorted(reviews, key=lambda r: r["published"]):
        latest[_key(r)] = r
    out_dir = paths.STAGING / SOURCE
    out_dir.mkdir(parents=True, exist_ok=True)
    # posts that failed to download this run keep their previous entries
    if failed_urls:
        def previous(name: str) -> list[dict]:
            path = out_dir / name
            items = json.loads(path.read_text()) if path.exists() else []
            return [i for i in items if i.get("url") in failed_urls]

        for r in previous("reviews.json"):
            latest.setdefault(_key(r), r)
        mentions.extend(previous("mcc_mentions.json"))
    (out_dir / "reviews.json").write_text(json.dumps(list(latest.values()), indent=1))
    (out_dir / "mcc_mentions.json").write_text(json.dumps(mentions, indent=1))
    log.info("milelion: %d reviews (%d mapped, %d with an overview table), %d MCC mentions",
             len(latest), sum(1 for r in latest.values() if r.get("card_ids")),
             sum(1 for r in latest.values() if r.get("overview")), len(mentions))
    return {"reviews": len(latest), "mcc_mentions": len(mentions)}
