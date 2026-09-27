"""ISO 18245 merchant category code list, plus the curated merchant → MCC table."""

from __future__ import annotations

import json
import logging
from functools import cache
from pathlib import Path

import yaml

from .. import config, paths
from ..fetch import Fetcher

log = logging.getLogger(__name__)

MCC_FILE = paths.REFERENCE / "mcc_codes.json"
MERCHANTS_FILE = paths.REFERENCE / "merchants.yaml"
MIN_CODES = 500  # sanity floor: the ISO list has ~1,000 codes


def refresh_mcc_codes() -> Path:
    cfg = config.sources()["mcc_reference"]
    with Fetcher("mcc-reference", respect_robots=False) as f:
        snap, rows = f.get_json(cfg["url"])
    codes = {
        r["mcc"].zfill(4): {
            "description": r.get("edited_description") or r.get("combined_description"),
            "irs_description": r.get("irs_description"),
        }
        for r in rows
    }
    supplement = paths.CONFIG / "mcc_supplement.yaml"
    if supplement.exists():
        for code, spec in (yaml.safe_load(supplement.read_text()) or {}).get("codes", {}).items():
            codes.setdefault(str(code).zfill(4), {"description": spec["description"],
                                                  "source": spec["source"]})
    out = {
        "source": {"url": snap.final_url, "retrieved_at": snap.retrieved_at, "sha256": snap.sha256,
                   "note": cfg.get("note")},
        "codes": dict(sorted(codes.items())),
    }
    if len(codes) < MIN_CODES:
        log.error("mcc reference: only %d codes parsed (expected ≥ %d) — keeping previous file",
                  len(codes), MIN_CODES)
        return MCC_FILE
    MCC_FILE.parent.mkdir(parents=True, exist_ok=True)
    MCC_FILE.write_text(json.dumps(out, indent=1, ensure_ascii=False))
    load_mcc_codes.cache_clear()
    log.info("mcc reference: %d codes", len(codes))
    return MCC_FILE


@cache
def load_mcc_codes() -> dict[str, dict]:
    if not MCC_FILE.exists():
        return {}
    return json.loads(MCC_FILE.read_text())["codes"]


def known_codes() -> set[str] | None:
    codes = load_mcc_codes()
    return set(codes) if codes else None


def describe(code: str) -> str | None:
    return (load_mcc_codes().get(code) or {}).get("description")


def load_merchants() -> list[dict]:
    if not MERCHANTS_FILE.exists():
        return []
    return (yaml.safe_load(MERCHANTS_FILE.read_text()) or {}).get("merchants", [])


def add_merchant(name: str, mcc: str, source_url: str, *, channel: str | None = None,
                 note: str | None = None, verified: bool = False) -> None:
    """Record an observed merchant MCC. A source is mandatory: there is no official public
    merchant→MCC registry, so every entry must say where it came from."""
    if not source_url:
        raise ValueError("source_url is required")
    data = yaml.safe_load(MERCHANTS_FILE.read_text()) if MERCHANTS_FILE.exists() else None
    data = data or {"merchants": []}
    entry = {"name": name, "mcc": mcc.zfill(4), "channel": channel, "verified": verified,
             "sources": [{"url": source_url, "note": note}]}
    for m in data["merchants"]:
        if m["name"].lower() == name.lower() and m.get("channel") == channel:
            if m["mcc"] != entry["mcc"]:
                log.warning("%s: MCC %s conflicts with recorded %s — keeping both sources",
                            name, entry["mcc"], m["mcc"])
                m.setdefault("conflicts", []).append({"mcc": entry["mcc"], **entry["sources"][0]})
            else:
                m["sources"].append(entry["sources"][0])
            break
    else:
        data["merchants"].append({k: v for k, v in entry.items() if v is not None})
    MERCHANTS_FILE.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True))
