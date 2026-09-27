"""Optional LLM-assisted extraction of earn rules from T&C text (needs the `llm` extra and an
Anthropic credential, e.g. ANTHROPIC_API_KEY).

The model output is never trusted on its own: `verify()` rejects any MCC that does not literally
appear in the source text, and reports MCCs in the text that the model left unclassified.
"""

from __future__ import annotations

import os
import re

from pydantic import BaseModel, Field

from .mcc import expand

MODEL = os.environ.get("POCKETACES_LLM_MODEL", "claude-opus-5")

SYSTEM = """You extract credit card reward rules from Singapore bank terms and conditions.
Report only what the document states. When the document is silent, leave the field null or empty;
do not use outside knowledge about the card. Copy MCC codes exactly as written (ranges as
"3000-3350"). For each rule, quote the sentence(s) it is based on verbatim in `evidence`."""


class ExtractedRule(BaseModel):
    label: str = Field(description="short name, e.g. 'Online spend bonus'")
    rate: float | None
    unit: str | None = Field(description="'percent', 'mpd' or 'points_per_dollar'")
    tier: str = Field(description="'base' or 'bonus'")
    eligible_description: str
    include_mcc: list[str]
    exclude_mcc: list[str]
    modes_required: list[str] = Field(
        description="subset of online, in_app, contactless, mobile_wallet, recurring, "
        "foreign_currency, local_currency")
    min_monthly_spend_sgd: float | None
    max_monthly_spend_sgd: float | None
    bonus_cap_amount: float | None
    bonus_cap_unit: str | None = Field(description="'SGD_spend', 'SGD_cashback', 'miles' or 'points'")
    bonus_cap_period: str | None
    rounding_block_sgd: float | None = Field(description="e.g. 5 if rewards are per S$5 spent")
    evidence: list[str]


class ExtractedTnc(BaseModel):
    rules: list[ExtractedRule]
    general_exclude_mcc: list[str]
    general_excluded_transactions: list[str] = Field(
        description="non-MCC exclusions, e.g. 'AXS payments', 'top-ups to e-wallets'")
    redemption_min_block: str | None
    redemption_fee: str | None
    points_expiry: str | None
    spend_cycle: str | None = Field(
        description="'calendar_month' if monthly min spend and caps reset on the 1st, "
        "'statement_month' if they follow the statement/billing cycle; null if not stated")
    spend_cycle_evidence: list[str] = Field(
        description="verbatim sentence(s) stating the spend cycle")
    other_notes: list[str]


def extract(text: str, card_name: str) -> ExtractedTnc:
    try:
        import anthropic
    except ImportError as e:  # pragma: no cover
        raise RuntimeError("anthropic not installed: uv sync --extra llm") from e
    client = anthropic.Anthropic()
    response = client.messages.parse(
        model=MODEL,
        max_tokens=16000,
        thinking={"type": "adaptive"},
        system=SYSTEM,
        messages=[{
            "role": "user",
            "content": f"<card>{card_name}</card>\n<document>\n{text}\n</document>\n\n"
                       "Extract the reward rules for this card.",
        }],
        output_format=ExtractedTnc,
    )
    if response.stop_reason == "refusal":
        raise RuntimeError(f"model declined: {response.stop_details}")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("output truncated (max_tokens); split the document")
    return response.parsed_output


def _codes_in_text(text: str) -> set[int]:
    found: set[int] = set()
    for a, b in re.findall(r"(\d{4})\s*(?:-|–|—|to)\s*(\d{4})", text):
        if int(a) < int(b):
            found.update(range(int(a), int(b) + 1))
    found.update(int(c) for c in re.findall(r"(?<!\d)(\d{4})(?!\d)", text))
    return found


def verify(result: ExtractedTnc, text: str, regex_codes: set[str]) -> dict:
    """Check model output against the source text. Returns {rejected, missed} lists. A spend
    cycle whose evidence isn't quoted from the text is dropped (and listed as rejected)."""
    present = _codes_in_text(text)
    rejected: list[str] = []
    claimed: set[int] = set()
    for rule in result.rules:
        for field in ("include_mcc", "exclude_mcc"):
            kept = []
            for code in getattr(rule, field):
                if expand([code]) <= present:
                    kept.append(code)
                    claimed |= expand([code])
                else:
                    rejected.append(f"{rule.label}:{field}:{code}")
            setattr(rule, field, kept)
    kept = []
    for code in result.general_exclude_mcc:
        if expand([code]) <= present:
            kept.append(code)
            claimed |= expand([code])
        else:
            rejected.append(f"general_exclude_mcc:{code}")
    result.general_exclude_mcc = kept
    if result.spend_cycle:
        flat = " ".join(text.split()).lower()
        quoted = [q for q in result.spend_cycle_evidence if " ".join(q.split()).lower() in flat]
        if result.spend_cycle not in ("calendar_month", "statement_month") or not quoted:
            rejected.append(f"spend_cycle:{result.spend_cycle}")
            result.spend_cycle = None
        result.spend_cycle_evidence = quoted if result.spend_cycle else []
    missed = sorted(c for c in regex_codes if not expand([c]) <= claimed)
    return {"rejected": rejected, "missed_by_llm": missed}
