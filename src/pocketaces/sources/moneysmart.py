"""Moneysmart (moneysmart.sg).

Behind a Cloudflare challenge, so pages are loaded with headless Chromium (BrowserFetcher). The
listing page is a Nuxt 3 app; the full product records (highlights, key features, fee/income
groups, current promotion) are in the `__NUXT_DATA__` payload.
"""

from __future__ import annotations

import logging
import re

from .. import config, registry
from ..extract.embedded import nuxt_payload
from ..fetch import BrowserFetcher, Fetcher
from ..models import SourceType, StagedCard
from .common import citation, html_to_text, load_staging, num, write_staging

log = logging.getLogger(__name__)

SOURCE = "moneysmart"


def _listing(payload: dict) -> dict:
    data = payload.get("data") or {}
    for key, value in data.items():
        if key.startswith("product-listings") and isinstance(value, dict) and "products" in value:
            return value
    raise ValueError("no product-listings entry in Nuxt payload")


def _groups(attrs: dict) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    for g in (attrs.get("more_details") or {}).get("group_attributes") or []:
        items = {}
        for it in g.get("items") or []:
            value = html_to_text(str(it.get("value", "")))
            subs = [s.get("description") for s in it.get("subvalues") or [] if s.get("description")]
            items[it["title"]] = value + (f" ({'; '.join(subs)})" if subs else "")
        out[g.get("feature_group_slug") or g.get("title")] = items
    return out


def _income(groups: dict) -> float | None:
    """Lowest S$ amount stated for Singaporeans/PRs (the headline requirement)."""
    for title, value in (groups.get("minimum-income-requirements") or {}).items():
        if "singaporean" in title.lower():
            amounts = [num(a) for a in re.findall(r"(?:S\$|SGD)\s?([\d,]+)", value)]
            amounts = [a for a in amounts if a and a >= 10000]
            return min(amounts) if amounts else None
    return None


def to_staged(product: dict, snap) -> StagedCard:
    a = product["attributes"]
    groups = _groups(a)
    fees = groups.get("annual-interest-rate-and-fees", {})
    provider = (a.get("provider") or {}).get("attributes") or {}
    highlights = [f"{h.get('value')} {h.get('label')}".strip() for h in a.get("highlights") or []]
    highlights += [html_to_text(k) for k in a.get("key_features") or [] if k]
    offers = []
    campaign = a.get("campaign") or {}
    for r in a.get("reward_items") or []:
        offers.append({
            "kind": r.get("type"),
            "title": r.get("title"),
            "subtitle": r.get("sub_title"),
            "is_cash": r.get("is_cash_reward"),
            "terms": html_to_text(r.get("eligibility_criteria")),
            "campaign": campaign.get("name"),
        })
    networks = [t for t, v in (groups.get("card-association") or {}).items() if v == "true"]
    wallets = [t for t, v in (groups.get("wireless-payment") or {}).items() if v == "true"]
    return StagedCard(
        source=SOURCE,
        source_id=a["slug"],
        source_url=a.get("pdp_url") or snap.final_url,
        name=a["name"],
        bank=provider.get("name", ""),
        card_id=registry.lookup(SOURCE, a["slug"]),
        image_url=a.get("image_url"),
        annual_fee=num(fees.get("Annual Principal Fee")),
        annual_fee_note=None,
        min_annual_income=_income(groups),
        highlights=highlights,
        sign_up_offers=offers,
        links={k: v for k, v in {"product": a.get("pdp_url"),
                                 "review": (a.get("related_articles_links") or [None])[0]}.items()
               if v},
        citation=citation(snap, SourceType.aggregator, a["name"]),
        extra={
            "summary": a.get("summary"),
            "badges": a.get("badges"),
            "network": networks,
            "mobile_wallets": wallets,
            "groups": groups,
            "our_takes": {t.get("slug"): html_to_text(t.get("detail")) for t in a.get("our_takes") or []},
            "updated_at": a.get("updated_at"),
        },
    )


def run(limit: int | None = None) -> list[StagedCard]:
    cfg = config.sources()[SOURCE]
    cards: list[StagedCard] = []
    seen: set[str] = set()
    partial = False
    with Fetcher(SOURCE, delay=cfg.get("delay", 3)) as f, BrowserFetcher(f) as browser:
        page, total_pages = 1, 1
        while page <= total_pages:
            url = cfg["listing_url"] + (f"?page={page}" if page > 1 else "")
            try:
                snap = browser.get(url, name=f"credit-cards-p{page}")
                listing = _listing(nuxt_payload(snap.read_text()))
            except Exception as e:
                log.error("moneysmart: listing page %d failed: %s", page, e)
                partial = True
                break
            total_pages = int((listing.get("meta") or {}).get("total_page_count") or 1)
            for product in listing["products"]:
                slug = product["attributes"]["slug"]
                if slug not in seen:
                    seen.add(slug)
                    cards.append(to_staged(product, snap))
            log.info("moneysmart: page %d/%d, %d cards so far", page, total_pages, len(cards))
            page += 1
            if limit and len(cards) >= limit:
                break
    # a failed page means we can't tell delisted cards from unseen ones: keep all previous files
    failed = {c.source_id for c in load_staging(SOURCE)} - seen if partial else set()
    write_staging(cards, SOURCE, failed=failed)
    log.info("moneysmart: staged %d cards (%d unmapped)", len(cards),
             sum(1 for c in cards if not c.card_id))
    return cards
