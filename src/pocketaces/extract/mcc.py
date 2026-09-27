"""Rule-based extraction of MCC codes from T&C text.

The output is a draft for human review, not ground truth. Every code is returned with the line it
appeared on and the heading/sentence that set its polarity (include/exclude), so a reviewer can
check the classification quickly.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field

# Checked in order. Exclusion wording is checked first because "not eligible" contains "eligible".
_EXCLUDE = re.compile(
    r"\b(exclud\w*|exclusion\w*|not\s+(?:be\s+)?(?:eligible|earn|qualif\w*|entitled|count)|"
    r"will\s+not|shall\s+not|do(?:es)?\s+not\s+(?:earn|qualify|count)|ineligible|"
    r"no\s+(?:cashback|rewards?|points|miles)|non-qualifying|other\s+than)\b",
    re.I,
)
_INCLUDE = re.compile(
    r"\b(eligible|qualifying|qualify|bonus|will\s+earn|shall\s+earn|entitled|"
    r"categor(?:y|ies)\s+as\s+follows|following\s+(?:mccs?|merchant))\b",
    re.I,
)
_MCC_CONTEXT = re.compile(r"\b(MCCs?|merchant\s+category\s+codes?|merchant\s+categor(?:y|ies))\b", re.I)

# A trailing comma is a list separator, but ",123" / ".5" / "%" mean an amount, not a code.
_NOT_AFTER = r"(?!\d|,\d{3}|\.\d|\s*%|/)"
_RANGE = re.compile(r"(?<![\d$.,])(\d{4})\s*(?:-|–|—|to)\s*(\d{4})" + _NOT_AFTER)
_CODE = re.compile(r"(?<![\d$.,/])(\d{4})" + _NOT_AFTER)

# How many lines an MCC mention keeps "MCC context" alive (tables often run several lines/pages).
_CONTEXT_SPAN = 80


@dataclass
class MccHit:
    code: str  # "5812" or "3000-3350"
    polarity: str  # include | exclude | unknown
    page: int
    line: str
    reason: str  # the text that set the polarity
    in_reference: bool | None = None  # False = not in the MCC reference list; check by hand

    @property
    def is_range(self) -> bool:
        return "-" in self.code


@dataclass
class MccExtraction:
    hits: list[MccHit] = field(default_factory=list)

    def codes(self, polarity: str) -> list[str]:
        return sorted({h.code for h in self.hits if h.polarity == polarity}, key=_sort_key)

    @property
    def include(self) -> list[str]:
        return self.codes("include")

    @property
    def exclude(self) -> list[str]:
        return self.codes("exclude")

    @property
    def unknown(self) -> list[str]:
        return self.codes("unknown")

    @property
    def unrecognised(self) -> list[str]:
        return sorted({h.code for h in self.hits if h.in_reference is False}, key=_sort_key)

    @property
    def conflicting(self) -> list[str]:
        return sorted(set(self.include) & set(self.exclude), key=_sort_key)

    def to_dict(self) -> dict:
        return {
            "include": self.include,
            "exclude": self.exclude,
            "unknown": self.unknown,
            "conflicting": self.conflicting,
            "unrecognised": self.unrecognised,
            "hits": [asdict(h) for h in self.hits],
        }


def _sort_key(code: str) -> tuple[int, str]:
    return int(code[:4]), code


def _polarity(text: str) -> str | None:
    if _EXCLUDE.search(text):
        return "exclude"
    if _INCLUDE.search(text):
        return "include"
    return None


def _plausible(code: str) -> bool:
    # MCCs run 0001-9999 but years and amounts collide; drop the common false positives.
    # Codes are never dropped for being absent from the reference list (that list lags new
    # codes); they are flagged via MccHit.in_reference instead.
    n = int(code)
    return not (1900 <= n <= 2099) and n >= 700


def extract_mccs(text: str, known_codes: set[str] | None = None) -> MccExtraction:
    """Find MCC codes and ranges in `text` (pages separated by \\f)."""
    out = MccExtraction()
    # state carries across pages: MCC tables frequently continue onto the next page
    polarity: str | None = None
    reason = ""
    context_left = 0
    for page_no, page in enumerate(text.split("\f"), start=1):
        for raw in page.splitlines():
            line = " ".join(raw.split())
            if not line:
                continue
            if _MCC_CONTEXT.search(line):
                context_left = _CONTEXT_SPAN
            p = _polarity(line)
            ranges = list(_RANGE.finditer(line))
            covered = [(m.start(), m.end()) for m in ranges]
            singles = [
                m for m in _CODE.finditer(line) if not any(a <= m.start() < b for a, b in covered)
            ]
            has_codes = bool(ranges or singles)
            # Prose sets polarity for the rows that follow. A line with codes only does so when it
            # also talks about MCCs ("MCCs 4829 and 4900 are excluded"); otherwise it is a table
            # row, whose description text ("Betting, including ...") must not flip polarity.
            if p and (not has_codes or _MCC_CONTEXT.search(line)):
                polarity, reason = p, line
            if context_left <= 0 or not has_codes:
                context_left -= 1
                continue
            context_left -= 1
            line_pol = polarity
            for m in ranges:
                a, b = m.group(1), m.group(2)
                if int(a) < int(b) and _plausible(a) and _plausible(b):
                    out.hits.append(MccHit(f"{a}-{b}", line_pol or "unknown", page_no, line, reason))
            for m in singles:
                code = m.group(1)
                if _plausible(code):
                    known = None if known_codes is None else (
                        code in known_codes or 3000 <= int(code) <= 3999)
                    out.hits.append(MccHit(code, line_pol or "unknown", page_no, line, reason, known))
    return out


def expand(codes: list[str]) -> set[int]:
    """Expand ['5812', '3000-3002'] to {5812, 3000, 3001, 3002}."""
    out: set[int] = set()
    for c in codes:
        if "-" in c:
            a, b = c.split("-")
            out.update(range(int(a), int(b) + 1))
        else:
            out.add(int(c))
    return out
