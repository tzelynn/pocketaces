from pathlib import Path

import pytest

from pocketaces.sources import krisflyer

FIXTURE = Path(__file__).parent / "fixtures" / "krisflyer_award_chart.pdf"


@pytest.fixture(scope="module")
def chart():
    return krisflyer.parse_award_chart(FIXTURE.read_bytes())


def _price(chart, award, cabin, a, b):
    return next(p for p in chart["prices"] if p["award_type"] == award and p["cabin"] == cabin
                and p["zone_from"] == a and p["zone_to"] == b)


def test_zones_and_effective_date(chart):
    assert chart["effective"] == "1 November 2025"
    assert chart["zones"]["11"] == "Europe"
    assert len(chart["zones"]) == 13


def test_known_values(chart):
    # values read directly off the PDF
    assert _price(chart, "saver", "economy", "1", "11")["one_way_miles"] == 44000
    assert _price(chart, "saver", "business", "1", "11")["one_way_miles"] == 108500
    assert _price(chart, "advantage", "economy", "1", "2")["one_way_miles"] == 16500
    assert _price(chart, "saver", "economy", "1", "2")["one_way_miles"] == 8000


def test_unavailable_and_footnotes(chart):
    pe = _price(chart, "saver", "premium_economy", "1", "2")
    assert pe["available"] is False and pe["one_way_miles"] is None
    starred = _price(chart, "saver", "economy", "2", "4")
    assert starred["one_way_miles"] == 16000 and "*" in starred["footnotes"]


def test_no_parse_issues(chart):
    assert not [p for p in chart["prices"] if "parse_issue" in p]


def test_observation_ranges(tmp_path, monkeypatch):
    monkeypatch.setattr(krisflyer, "OUT_DIR", tmp_path)
    monkeypatch.setattr(krisflyer, "OBSERVATIONS", tmp_path / "obs.csv")
    for miles, dep in [(107000, "2027-03-01"), (115000, "2027-03-05"), (150000, "2026-10-01")]:
        krisflyer.log_observation({
            "origin": "SIN", "destination": "LHR", "cabin": "business", "award_type": "saver",
            "one_way_miles": miles, "departure_date": dep, "observed_on": "2026-09-27",
            "source_url": "https://example.test"})
    ranges = {r["days_in_advance"]: r for r in krisflyer.observation_ranges()}
    assert ranges["61-180"]["min"] == 107000 and ranges["61-180"]["n"] == 2
    assert ranges["0-14"]["max"] == 150000
