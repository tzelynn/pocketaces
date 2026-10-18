"""Official bank terms & conditions.

For each card in config/cards.yaml:
  1. collect T&C document URLs: explicit `official.tnc_urls`, plus PDF links on
     `official.product_page` whose URL or link text matches the bank's `tnc_link_patterns`
     (config/sources.yaml) — so renamed PDFs are found again without editing config;
  2. download and snapshot each document, extract its text (kept next to the snapshot so the exact
     wording we relied on stays in git);
  3. compare hashes with the previous run → `changed` documents mark curated records stale;
  4. extract MCC include/exclude lists, transaction-mode and spend-cycle statements for review,
     and optionally run LLM extraction (verified against the text).
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from .. import config, paths
from ..extract import mcc as mcc_extract
from ..extract.pdf import pdf_text
from ..fetch import FetchError, Fetcher, Snapshot
from ..models import SourceType
from .common import citation, html_to_text
from .mcc_reference import known_codes

log = logging.getLogger(__name__)

SOURCE = "bank"
STAGING = paths.STAGING / "tnc"

MODE_PATTERNS = {
    "online": r"\bonline\b|internet|e-?commerce|card[- ]not[- ]present",
    "in_app": r"in-?app",
    "contactless": r"contactless|pay\s?wave|tap\b",
    "mobile_wallet": r"apple pay|google pay|samsung pay|mobile (?:wallet|payment)",
    "recurring": r"recurring|standing instruction|subscription|credential-on-file",
    "foreign_currency": r"foreign currency|\bFCY\b|non-?SGD|overseas",
    "local_currency": r"\bSGD\b|local currency|Singapore dollars",
}
NON_MCC_EXCLUSIONS = (
    r"AXS|SAM kiosk|e-?wallet|top-?ups?|GrabPay|Youtrip|Revolut|balance transfer|cash advance|"
    r"instalment|IPP|annual fee|interest|late (?:payment )?charge|insurance premium|"
    r"hospital|education|government|tax|utilit|charit|bill payment|CardUp|ipaymy|RentHero"
)

# Which month min spend and caps are counted over. Only sentences that tie the period to spend,
# a minimum or a cap count: "calendar month" also appears in crediting dates ("awarded on the 7th
# of the following calendar month") and deposit balances, which say nothing about the spend cycle.
SPEND_CYCLE_PATTERNS = {
    "statement_month": r"statement\s+(?:month|cycle|period)|billing\s+(?:cycle|month|period)",
    "calendar_month": r"calendar\s+month",
}
_CYCLE_SUBJECT = re.compile(r"\bspend|\bcharge|\bminimum|\bmin\.?\s|\bcap(?:ped|s)?\b|\bmaximum|\bup\s+to\b", re.I)
_CYCLE_NOISE = re.compile(
    r"(?:next|following|preceding|subsequent)\s+calendar\s+month|average\s+(?:daily\s+)?balance", re.I)


def _doc_urls(card: dict, f: Fetcher) -> tuple[list[str], list[Snapshot], bool]:
    """T&C URLs for a card, the product page snapshots, and whether page discovery succeeded."""
    official = card.get("official") or {}
    urls: list[str] = list(official.get("tnc_urls") or [])
    pages: list[Snapshot] = []
    page = official.get("product_page")
    if page:
        try:
            snap = f.get(page)
            if _soft_404(page, snap.final_url, snap.read_text()):
                log.warning("%s: product page looks dead (soft 404 → %s); fix official.product_page",
                            card["id"], snap.final_url)
                return list(dict.fromkeys(urls)), pages, False
            pages.append(snap)
            bank_cfg = config.sources()["banks"].get(card["bank_key"], {})
            patterns = [re.compile(p, re.I) for p in bank_cfg.get("tnc_link_patterns", [])]
            patterns += [re.compile(p, re.I) for p in official.get("tnc_link_patterns", [])]
            ignore = [re.compile(p, re.I) for p in bank_cfg.get("ignore_link_patterns", [])]
            soup = BeautifulSoup(snap.read_text(), "lxml")
            for a in soup.find_all("a", href=True):
                href = urljoin(snap.final_url, a["href"])
                label = " ".join(a.get_text().split())
                blob = f"{href} {label}"
                if (href.lower().split("?")[0].endswith(".pdf")
                        and any(p.search(blob) for p in patterns)
                        and not any(p.search(blob) for p in ignore)):
                    urls.append(href)
        except FetchError as e:
            log.warning("%s: product page failed: %s", card["id"], e)
            return list(dict.fromkeys(urls)), pages, False
    return list(dict.fromkeys(urls)), pages, True


_SOFT_404 = re.compile(r"[?&](rd=err|error)|/(404|not-found|page-not-found)\b", re.I)


def _soft_404(requested: str, final: str, html: str) -> bool:
    """Banks often redirect retired product pages to a listing/error page with HTTP 200."""
    if _SOFT_404.search(final) and not _SOFT_404.search(requested):
        return True
    title = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
    return bool(title and re.search(r"page not found|404|error", title.group(1), re.I))


def _modes(text: str) -> dict[str, list[str]]:
    sentences = re.split(r"(?<=[.;])\s+|\n(?=\d+\.|\(?[a-z]\))", text)
    out: dict[str, list[str]] = {}
    for mode, pat in MODE_PATTERNS.items():
        rx = re.compile(pat, re.I)
        hits = [" ".join(s.split())[:400] for s in sentences if rx.search(s)]
        if hits:
            out[mode] = hits[:15]
    return out


def _spend_cycle(text: str) -> dict[str, list[str]]:
    """Sentences stating the month that spend/caps are counted over, by `SpendCycle` value."""
    sentences = re.split(r"(?<=[.;])\s+|\n(?=\d+\.|\(?[a-z]\))", text)
    out: dict[str, list[str]] = {}
    for cycle, pat in SPEND_CYCLE_PATTERNS.items():
        rx = re.compile(pat, re.I)
        hits = [" ".join(s.split())[:400] for s in sentences
                if rx.search(s) and _CYCLE_SUBJECT.search(s) and not _CYCLE_NOISE.search(s)]
        if hits:
            out[cycle] = list(dict.fromkeys(hits))[:10]
    return out


def _previous(card_id: str) -> dict:
    p = STAGING / f"{card_id}.json"
    return json.loads(p.read_text()) if p.exists() else {}


def _seen_since(doc: dict) -> str | None:
    return doc.get("seen_since") or doc.get("citation", {}).get("retrieved_at")


def process_card(card: dict, f: Fetcher, *, use_llm: bool = False) -> dict:
    previous = _previous(card["id"])
    prev_docs = {d["url"]: d for d in previous.get("documents", [])}
    urls, pages, discovered = _doc_urls(card, f)
    if not discovered:
        # couldn't read the product page: keep documents found through it on earlier runs
        urls += [u for u in prev_docs if u not in urls]
    if not urls:
        log.warning("%s: no T&C documents found — add official.tnc_urls in config/cards.yaml",
                    card["id"])
    known = known_codes()
    documents = []
    all_text = []
    for url in urls:
        try:
            snap = f.get(url)
        except FetchError as e:
            snap = manual_snapshot(url)
            if snap is None:
                hint = (" — download it in a browser and run `pocketaces tnc import "
                        f"{card['id']} <file> --url {url}`") if "robots.txt" in str(e) else ""
                log.warning("%s: %s%s", card["id"], e, hint)
                prev = prev_docs.get(url)
                if prev and prev.get("sha256"):
                    # keep the last good extraction rather than losing it to a transient failure
                    documents.append({**prev, "carried_over": True, "last_error": str(e),
                                      "changed": False, "new": False})
                    text_file = paths.ROOT / prev["text_path"]
                    if text_file.exists():
                        all_text.append(f"=== {url}\n{text_file.read_text()}")
                else:
                    documents.append({"url": url, "error": str(e), "changed": False})
                continue
            log.info("%s: using manually imported copy of %s (%s)", card["id"], url,
                     snap.retrieved_at)
        if snap.content_type == "application/pdf" or snap.path.endswith(".pdf"):
            text = pdf_text(snap.read_bytes())
        else:
            text = html_to_text(snap.read_text())
        no_text = len(text.strip()) < 200
        if no_text:
            log.warning("%s: %s has no text layer (scanned/image PDF) — review it manually",
                        card["id"], url)
        text_path = Path(paths.ROOT / snap.path).with_suffix(".txt")
        text_path.write_text(text)
        prev = prev_docs.get(url)
        extraction = mcc_extract.extract_mccs(text, known)
        documents.append({
            "url": url,
            "citation": citation(snap, SourceType.official).model_dump(exclude_none=True),
            "text_path": str(text_path.relative_to(paths.ROOT)),
            "sha256": snap.sha256,
            "changed": bool(prev and prev.get("sha256") and prev["sha256"] != snap.sha256),
            "new": prev is None,
            # when this content was first pulled; a review dated after it outranks it (see build)
            "seen_since": (_seen_since(prev) if prev and prev.get("sha256") == snap.sha256
                           else None) or snap.retrieved_at,
            "no_text_layer": no_text,
            "effective_dates": sorted(set(re.findall(
                r"(?:effective|with effect)\s+(?:from\s+)?(\d{1,2}\s+\w+\s+\d{4})", text, re.I))),
            "mcc": extraction.to_dict(),
            "transaction_modes": _modes(text),
            "spend_cycle": _spend_cycle(text),
            "non_mcc_exclusions": sorted({m.group(0).lower() for m in
                                          re.finditer(NON_MCC_EXCLUSIONS, text, re.I)}),
        })
        all_text.append(f"=== {url}\n{text}")
    result = {
        "card_id": card["id"],
        "product_pages": [citation(p, SourceType.official).model_dump(exclude_none=True) for p in pages],
        "documents": documents,
        "changed": any(d.get("changed") for d in documents) or
                   bool(set(prev_docs) - set(urls)),
        "removed_documents": sorted(set(prev_docs) - set(urls)),
    }
    if result["removed_documents"]:
        result["removed_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if use_llm and all_text and not any(d.get("changed") or d.get("new") for d in documents) \
            and "llm" in previous and "error" not in previous["llm"]:
        result["llm"] = previous["llm"]  # documents unchanged: reuse, don't pay for a re-run
    elif use_llm and all_text:
        from ..extract import llm

        text = "\n\n".join(all_text)
        regex_codes = {c for d in documents for pol in ("include", "exclude")
                       for c in d.get("mcc", {}).get(pol, [])}
        try:
            extracted = llm.extract(text, card["name"])
            checks = llm.verify(extracted, text, regex_codes)
            result["llm"] = {"model": llm.MODEL, **extracted.model_dump(), "checks": checks}
        except Exception as e:
            log.error("%s: LLM extraction failed: %s", card["id"], e)
            result["llm"] = {"error": str(e)}
    STAGING.mkdir(parents=True, exist_ok=True)
    (STAGING / f"{card['id']}.json").write_text(json.dumps(result, indent=1))
    return result


MANUAL = paths.STAGING / "tnc" / "_manual_imports.json"


def import_document(card_id: str, file: Path, url: str) -> Snapshot:
    """Snapshot a T&C document downloaded by hand (e.g. where robots.txt forbids automated
    fetching). It is cited exactly like a fetched copy, with its official URL."""
    body = file.read_bytes()
    ctype = "application/pdf" if body[:4] == b"%PDF" else "text/html"
    with Fetcher(SOURCE) as f:
        snap = f.save(url, url, body, ctype, name=f"manual-{card_id}")
    imports = json.loads(MANUAL.read_text()) if MANUAL.exists() else {}
    imports[url] = snap.__dict__
    MANUAL.parent.mkdir(parents=True, exist_ok=True)
    MANUAL.write_text(json.dumps(imports, indent=1))
    return snap


def manual_snapshot(url: str) -> Snapshot | None:
    if not MANUAL.exists():
        return None
    entry = json.loads(MANUAL.read_text()).get(url)
    return Snapshot(**entry) if entry else None


def run(card_ids: list[str] | None = None, *, use_llm: bool = False) -> list[dict]:
    cards = [c for c in config.cards() if c["id"] in card_ids] if card_ids else config.active_cards()
    results = []
    banks = config.sources()["banks"]
    fetchers: dict[bool, Fetcher] = {}
    for card in cards:
        respect = banks.get(card.get("bank_key"), {}).get("respect_robots", True)
        if respect not in fetchers:
            fetchers[respect] = Fetcher(SOURCE, delay=config.sources().get("banks_delay", 2),
                                        respect_robots=respect)
    try:
        for card in cards:
            f = fetchers[banks.get(card.get("bank_key"), {}).get("respect_robots", True)]
            try:
                r = process_card(card, f, use_llm=use_llm)
            except Exception:
                log.exception("%s: T&C processing failed — keeping previous data", card["id"])
                continue
            n_mcc = sum(len(d.get("mcc", {}).get("hits", [])) for d in r["documents"])
            log.info("%s: %d documents, %d MCC mentions%s", card["id"], len(r["documents"]), n_mcc,
                     " — CHANGED" if r["changed"] else "")
            results.append(r)
    finally:
        for f in fetchers.values():
            f.close()
    return results
