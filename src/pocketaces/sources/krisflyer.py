"""KrisFlyer award data.

1. The official Singapore Airlines one-way Saver/Advantage award chart (PDF), discovered from the
   public "redeem miles" page so a new chart version is picked up without code changes.
2. Observed redemption prices (data/reference/krisflyer/observations.csv), logged by hand or by
   other tools, used to derive price ranges under conditions such as days booked in advance.
"""

from __future__ import annotations

import csv
import io
import json
import logging
import re
import statistics
from datetime import date
from pathlib import Path
from urllib.parse import urljoin

import pdfplumber
from bs4 import BeautifulSoup

from .. import config, paths
from ..fetch import Fetcher, Snapshot

log = logging.getLogger(__name__)

CABINS = {
    "ECONOMY": "economy",
    "PREMIUM ECONOMY": "premium_economy",
    "BUSINESS": "business",
    "SUITES/FIRST": "first",
    "FIRST": "first",
}
_LEGEND = re.compile(r"(SUITES/FIRST|PREMIUM ECONOMY|ECONOMY|BUSINESS|FIRST)\s+(SAVER|ADVANTAGE)")
_EFFECTIVE = re.compile(r"Effective\s+(\d{1,2}\s+\w+\s+\d{4})")
_ZONE = re.compile(r"ZONE\s+(\d+):?\s*(.*)", re.S)

OUT_DIR = paths.REFERENCE / "krisflyer"
OBSERVATIONS = OUT_DIR / "observations.csv"
OBS_FIELDS = [
    "observed_on", "origin", "destination", "zone_from", "zone_to", "cabin", "award_type",
    "one_way_miles", "taxes_sgd", "departure_date", "days_in_advance", "flight_no",
    "source_url", "note",
]


def discover_chart_url(fetcher: Fetcher) -> tuple[str, Snapshot]:
    cfg = config.sources()["krisflyer"]
    snap = fetcher.get(cfg["redeem_page"])
    soup = BeautifulSoup(snap.read_text(), "lxml")
    pattern = re.compile(cfg.get("chart_link_pattern", r"(?i)one-?way.*award.*chart.*\.pdf"))
    for a in soup.find_all("a", href=True):
        if pattern.search(a["href"]) and "upgrade" not in a["href"].lower():
            return urljoin(snap.final_url, a["href"]), snap
    raise RuntimeError(f"no award chart link on {cfg['redeem_page']} matching {pattern.pattern}")


def _value(cell: str | None) -> tuple[float | None, list[str], str | None]:
    """'28.5*' → (28500, ['*'], None); '^' → (None, [], 'not_available'); '-' → (None, [], 'n/a')."""
    if cell is None:
        return None, [], "blank"
    s = cell.strip()
    notes = [c for c in "*†‡#" if c in s]
    s = re.sub(r"[*†‡#\s]", "", s)
    if s in ("^",):
        return None, notes, "not_available"
    if s in ("-", "--", ""):
        return None, notes, "not_applicable"
    try:
        return round(float(s) * 1000), notes, None
    except ValueError:
        return None, notes, f"unparsed:{cell!r}"


def parse_award_chart(pdf_bytes: bytes) -> dict:
    """Parse the one-way Saver/Advantage chart into a flat list of prices.

    Layout (stable across 2024-2026 editions): one table per page, 13 zone columns, each origin zone
    spans one row per cabin. The page legend ("ECONOMY SAVER PREMIUM ECONOMY SAVER ...") gives the
    award type and cabin order of those rows.
    """
    prices: list[dict] = []
    zones: dict[str, str] = {}
    effective = None
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page_no, page in enumerate(pdf.pages, start=1):
            text = page.extract_text() or ""
            legend = _LEGEND.findall(text)
            if not legend:
                continue
            if m := _EFFECTIVE.search(text):
                effective = m.group(1)
            award_types = {t for _, t in legend}
            if len(award_types) != 1:
                raise ValueError(f"page {page_no}: ambiguous legend {legend}")
            award_type = award_types.pop().lower()
            cabins = [CABINS[c] for c, _ in legend]
            tables = [t.extract() for t in page.find_tables()]
            table = max(tables, key=len)
            header = table[0]
            dest_zones = [re.sub(r"\D", "", h or "") for h in header[1:]]
            current_zone = None
            row_in_zone = 0
            for row in table[1:]:
                label = row[0]
                if label and (m := _ZONE.match(label.strip())):
                    current_zone = m.group(1)
                    zones[current_zone] = " ".join(m.group(2).split())
                    row_in_zone = 0
                if current_zone is None:
                    continue
                if row_in_zone >= len(cabins):
                    raise ValueError(
                        f"page {page_no} zone {current_zone}: more rows than legend cabins {cabins}"
                    )
                cabin = cabins[row_in_zone]
                row_in_zone += 1
                for dest, cell in zip(dest_zones, row[1:]):
                    miles, notes, status = _value(cell)
                    if status in ("not_applicable", "blank"):
                        continue
                    prices.append({
                        "award_type": award_type,
                        "cabin": cabin,
                        "zone_from": current_zone,
                        "zone_to": dest,
                        "one_way_miles": miles,
                        "available": status is None,
                        "footnotes": notes,
                        "page": page_no,
                        **({"parse_issue": status} if status and status != "not_available" else {}),
                    })
    return {"effective": effective, "zones": zones, "prices": prices}


def refresh_award_chart() -> Path:
    with Fetcher("singaporeair") as f:
        url, page_snap = discover_chart_url(f)
        snap = f.get(url)
    chart = parse_award_chart(snap.read_bytes())
    issues = [p for p in chart["prices"] if "parse_issue" in p]
    out = {
        "source": {
            "url": snap.final_url,
            "found_on": page_snap.final_url,
            "retrieved_at": snap.retrieved_at,
            "sha256": snap.sha256,
            "snapshot": snap.path,
            "source_type": "official",
        },
        "unit": "KrisFlyer miles, one-way",
        **chart,
        "parse_issues": len(issues),
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / "award_chart.json"
    if not chart["prices"] or issues or len(chart["zones"]) < 10:
        log.error("award chart parse looks wrong (%d prices, %d zones, %d issues) — keeping "
                  "previous file; snapshot at %s", len(chart["prices"]), len(chart["zones"]),
                  len(issues), snap.path)
        return path
    previous = json.loads(path.read_text()) if path.exists() else None
    path.write_text(json.dumps(out, indent=1))
    if previous and previous["source"]["sha256"] != out["source"]["sha256"]:
        log.warning("award chart changed: %s → %s", previous.get("effective"), out["effective"])
    log.info("award chart: %d prices, %d zones, %d parse issues", len(chart["prices"]),
             len(chart["zones"]), len(issues))
    return path


# -- observations ------------------------------------------------------------------------------


def log_observation(row: dict) -> None:
    missing = [k for k in ("origin", "destination", "cabin", "award_type", "one_way_miles",
                           "departure_date", "source_url") if not row.get(k)]
    if missing:
        raise ValueError(f"missing fields: {missing}")
    row.setdefault("observed_on", date.today().isoformat())
    dep = date.fromisoformat(row["departure_date"])
    row["days_in_advance"] = (dep - date.fromisoformat(row["observed_on"])).days
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    new = not OBSERVATIONS.exists()
    with OBSERVATIONS.open("a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=OBS_FIELDS, extrasaction="ignore")
        if new:
            w.writeheader()
        w.writerow(row)


ADVANCE_BUCKETS = [(0, 14), (15, 60), (61, 180), (181, 400)]


def observation_ranges() -> list[dict]:
    """Min/median/max miles per route, cabin, award type and days-in-advance bucket."""
    if not OBSERVATIONS.exists():
        return []
    groups: dict[tuple, list[int]] = {}
    with OBSERVATIONS.open() as f:
        for r in csv.DictReader(f):
            d = int(r["days_in_advance"])
            bucket = next((f"{a}-{b}" for a, b in ADVANCE_BUCKETS if a <= d <= b), "400+")
            key = (r["origin"], r["destination"], r["cabin"], r["award_type"], bucket)
            groups.setdefault(key, []).append(int(float(r["one_way_miles"])))
    return [
        {"origin": k[0], "destination": k[1], "cabin": k[2], "award_type": k[3],
         "days_in_advance": k[4], "n": len(v), "min": min(v),
         "median": statistics.median(v), "max": max(v)}
        for k, v in sorted(groups.items())
    ]
