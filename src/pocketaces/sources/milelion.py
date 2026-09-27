"""The MileLion (milelion.com), read via the WordPress REST API.

Used for (1) card review links + key claims per card, for cross-checking curated data, and
(2) mining "MCC ####" mentions next to merchant names as merchant→MCC *candidates* (never
auto-accepted; see `pocketaces merchants`).
"""

from __future__ import annotations

import json
import logging
import re
from html import unescape

from .. import config, paths, registry
from ..fetch import Fetcher
from ..models import SourceType
from .common import citation, html_to_text

log = logging.getLogger(__name__)

SOURCE = "milelion"
_REVIEW_TITLE = re.compile(r"^(?:\d{4} Edition:\s*)?Review:\s*(.+)$", re.I)
_MCC_MENTION = re.compile(r"\bMCCs?\s*(?:of|:|=)?\s*(\d{4})\b")
_MPD_CLAIM = re.compile(r"[^.\n]*\b\d+(?:\.\d+)?\s*(?:mpd|miles per dollar|% cashback)[^.\n]*[.\n]", re.I)


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
        reviews.append({
            "card_id": registry.lookup(SOURCE, p["slug"]),
            "card_name": card_name,
            "title": title,
            "url": p["link"],
            "slug": p["slug"],
            "published": p["date"],
            "modified": p["modified"],
            "earn_claims": [" ".join(c.split()) for c in _MPD_CLAIM.findall(text)][:40],
            "mcc_mentions": sorted({m.group(1) for m in _MCC_MENTION.finditer(text)}),
            "citation": cite,
        })
    # keep only the latest review per card
    latest: dict[str, dict] = {}
    for r in sorted(reviews, key=lambda r: r["published"]):
        latest[r["card_id"] or r["card_name"].lower()] = r
    out_dir = paths.STAGING / SOURCE
    out_dir.mkdir(parents=True, exist_ok=True)
    # posts that failed to download this run keep their previous entries
    if failed_urls:
        def previous(name: str) -> list[dict]:
            path = out_dir / name
            items = json.loads(path.read_text()) if path.exists() else []
            return [i for i in items if i.get("url") in failed_urls]

        for r in previous("reviews.json"):
            latest.setdefault(r["card_id"] or r["card_name"].lower(), r)
        mentions.extend(previous("mcc_mentions.json"))
    (out_dir / "reviews.json").write_text(json.dumps(list(latest.values()), indent=1))
    (out_dir / "mcc_mentions.json").write_text(json.dumps(mentions, indent=1))
    log.info("milelion: %d reviews (%d mapped), %d MCC mentions", len(latest),
             sum(1 for r in latest.values() if r["card_id"]), len(mentions))
    return {"reviews": len(latest), "mcc_mentions": len(mentions)}
