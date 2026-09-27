"""SingSaver (singsaver.com.sg).

Product pages are Next.js App Router pages; each embeds the product record (with ~50 typed
"attributes": earn rates per category, caps, fees, income) in the RSC flight data. We parse that
rather than the DOM.
"""

from __future__ import annotations

import logging
import re
from urllib.parse import urljoin, urlparse

from .. import config, registry
from ..extract.embedded import flight_text_chunks, iter_json_objects, next_flight_text, resolve_ref
from ..fetch import FetchError, Fetcher
from ..models import SourceType, StagedCard
from .common import citation, html_to_text, num, write_staging

log = logging.getLogger(__name__)

SOURCE = "singsaver"
_PRODUCT_PATH = re.compile(r"^/credit-card/products/[a-z0-9-]+$")
_EARN_PREFIX = {
    "AIRMILES_": "mpd",
    "CASHBACK_": "percent",
    "REWARDS_POINTS_": "points_per_dollar",
}
_CAP_NAMES = {"AIRMILES_BONUS_CAP", "CASHBACK_BONUS_CAP", "REWARDS_BONUS_CAP", "NO_CASHBACK_CAP"}


def discover_product_paths(f: Fetcher) -> set[str]:
    cfg = config.sources()[SOURCE]
    found: set[str] = set()
    for page in cfg["listing_pages"]:
        try:
            snap = f.get(page)
        except FetchError as e:
            log.warning("listing page failed: %s", e)
            continue
        found.update(re.findall(r'"url_alias":"(/credit-card/products/[a-z0-9-]+)"',
                                next_flight_text(snap.read_text())))
    if cfg.get("use_sitemap", True):
        snap = f.get(cfg["sitemap"])
        for loc in re.findall(r"<loc>([^<]+)</loc>", snap.read_text()):
            path = urlparse(loc).path.rstrip("/")
            if _PRODUCT_PATH.match(path):
                found.add(path)
    skip = [re.compile(p) for p in cfg.get("skip_patterns", [])]
    return {p for p in found if not any(s.search(p) for s in skip)}


def _attr_value(a: dict):
    t = a.get("__typename", "")
    if t.endswith("NumberRange"):
        return {"min": num(a.get("value_start")), "max": num(a.get("value_end"))}
    if t.endswith("Number"):
        return num(a.get("value"))
    return a.get("value")


def _attr_note(a: dict) -> str | None:
    parts = [a.get("prefix"), a.get("additional_information"), a.get("empty_value_text")]
    note = " | ".join(p for p in parts if p and p != "$undefined")
    return note or None


def _d(x) -> dict:
    """RSC fields are sometimes references ('$14:props:...') instead of objects."""
    return x if isinstance(x, dict) else {}


def _offers(product: dict, chunks: dict) -> list[dict]:
    out = []
    for key in ("welcome_offers", "exclusive_offers", "bundle_exclusive_offers"):
        for o in product.get(key) or []:
            if not isinstance(o, dict):  # unresolved RSC reference
                continue
            gifts = []
            for g in o.get("list_of_gifts") or []:
                gift = _d(_d(g).get("gift"))
                gifts.append({
                    "title": gift.get("gift_title"),
                    "value_sgd": _d(gift.get("gift_value")).get("price"),
                })
            period = _d(o.get("period"))
            out.append({
                "kind": key.removesuffix("s"),
                "title": resolve_ref(o.get("offer_title"), chunks),
                "offer_id": o.get("uid"),
                "valid_from": period.get("start_date"),
                "valid_to": period.get("end_date"),
                "gifts": gifts,
                "terms": html_to_text(resolve_ref(o.get("description"), chunks)),
                "tnc_url": o.get("tncLink") or None,
                "bundle_with": [_d(b).get("uid") for b in o.get("bundle_options") or []],
            })
    return out


def parse_product(html: str, path: str) -> dict | None:
    flight = next_flight_text(html)
    chunks = flight_text_chunks(flight)
    for obj in iter_json_objects(flight, '"attributes":['):
        if obj.get("url_alias") == path and "product_name" in obj:
            obj["_chunks"] = chunks
            return obj
    return None


def to_staged(product: dict, url: str, snap) -> StagedCard:
    chunks = product.pop("_chunks", {})
    attrs = {a["name"]["name"]: a for a in product.get("attributes", [])
             if isinstance(a, dict) and isinstance(a.get("name"), dict)}
    earn: dict[str, dict] = {}
    caps: dict[str, dict] = {}
    for name, a in attrs.items():
        if name in _CAP_NAMES:
            caps[name.lower()] = {"value": _attr_value(a), "note": _attr_note(a)}
            continue
        for prefix, unit in _EARN_PREFIX.items():
            if name.startswith(prefix) and not name.endswith("_CAP") and "CONVERSION" not in name:
                val = _attr_value(a)
                if val is not None or _attr_note(a):
                    earn[f"{unit}:{name[len(prefix):].lower()}"] = {
                        "value": val, "unit": unit, "note": _attr_note(a)}
    fee = attrs.get("ANNUAL_FEE", {})
    provider = _d(product.get("provider"))
    highlights = []
    for key in ("QUICK_FACTS", "THINGS_TO_CONSIDER"):
        for group in _d(attrs.get(key)).get("value") or []:
            for v in _d(group).get("values") or []:
                if v.get("value"):
                    highlights.append(f"{group.get('key')}: {html_to_text(v['value'])}")
    benefit = attrs.get("CARD_BENEFIT")
    if benefit and _attr_note(benefit):
        highlights.insert(0, _attr_note(benefit))
    path = product["url_alias"]
    return StagedCard(
        source=SOURCE,
        source_id=path.rsplit("/", 1)[-1],
        source_url=url,
        name=product["product_name"],
        bank=provider.get("provider_name", ""),
        card_id=registry.lookup(SOURCE, path.rsplit("/", 1)[-1]),
        image_url=product.get("product_image"),
        annual_fee=_attr_value(fee) if fee else None,
        annual_fee_note=_attr_note(fee) if fee else None,
        min_annual_income=_attr_value(attrs["MINIMUM_ANNUAL_INCOME"])
        if "MINIMUM_ANNUAL_INCOME" in attrs else None,
        min_monthly_spend=_attr_value(attrs["MONTHLY_SPEND_REQUIRED"])
        if "MONTHLY_SPEND_REQUIRED" in attrs else None,
        earn_rates=earn,
        caps=caps,
        highlights=highlights,
        sign_up_offers=_offers(product, chunks),
        links={"apply": l["redirected_url"]
               for l in (_d(product.get("call_to_action")).get("links") or [])[:1]
               if isinstance(l, dict) and l.get("redirected_url")},
        citation=citation(snap, SourceType.aggregator, product["product_name"]),
        extra={
            "network": _d(attrs.get("SUPPORTED_PAYMENT_NETWORK")).get("value"),
            "mobile_wallets": _d(attrs.get("SUPPORTED_PAYMENT_TYPE")).get("value"),
            "fx_fee_percent": _attr_value(attrs["FOREIGN_CURRENCY_TRANSACTION_FEE"])
            if "FOREIGN_CURRENCY_TRANSACTION_FEE" in attrs else None,
            "miles_conversion_fee": _attr_value(attrs["AIRMILES_CONVERSION_FEE"])
            if "AIRMILES_CONVERSION_FEE" in attrs else None,
            "categories": product.get("category_identifiers"),
            "tag": _d(attrs.get("PRODUCT_TAG")).get("value"),
            "description": html_to_text(resolve_ref(product.get("long_description"), chunks))
            or html_to_text(resolve_ref(product.get("description"), chunks)),
        },
    )


def run(limit: int | None = None) -> list[StagedCard]:
    cfg = config.sources()[SOURCE]
    cards: list[StagedCard] = []
    failed: set[str] = set()
    with Fetcher(SOURCE, delay=cfg.get("delay", 1.5)) as f:
        paths_ = sorted(discover_product_paths(f))
        log.info("singsaver: %d candidate product pages", len(paths_))
        for path in paths_[:limit]:
            url = urljoin(cfg["base_url"], path)
            slug = path.rsplit("/", 1)[-1]
            try:
                snap = f.get(url)
            except FetchError as e:
                if not re.search(r"HTTP (404|410)", str(e)):  # 404/410 = delisted
                    failed.add(slug)
                log.info("skip %s: %s", path, e)
                continue
            try:
                product = parse_product(snap.read_text(), path)
                if not product:
                    log.info("skip %s: no product record (discontinued or redirected)", path)
                    continue
                cards.append(to_staged(product, url, snap))
            except Exception:
                failed.add(slug)
                log.exception("failed to parse %s (snapshot %s)", path, snap.path)
    write_staging(cards, SOURCE, failed=failed)
    log.info("singsaver: staged %d cards (%d unmapped)", len(cards),
             sum(1 for c in cards if not c.card_id))
    return cards
