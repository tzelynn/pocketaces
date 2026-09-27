"""Canonical data model for card records.

Curated YAML files in data/curated/cards/ and the merged build output both validate against `Card`.
Fields that carry facts have a `sources` list of citation ids (keys into `Card.citations`).
"""

from __future__ import annotations

from datetime import date
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# -- citations & review ------------------------------------------------------------------------


class SourceType(str, Enum):
    official = "official"  # bank / airline own publication
    aggregator = "aggregator"  # singsaver, moneysmart
    editorial = "editorial"  # milelion and other blogs
    manual = "manual"  # human-entered with a note


class Citation(Strict):
    id: str
    url: str
    title: str | None = None
    source_type: SourceType
    retrieved_at: str | None = None
    sha256: str | None = None
    snapshot: str | None = None  # path to raw snapshot, relative to repo root
    note: str | None = None


class ReviewStatus(str, Enum):
    draft = "draft"  # machine-generated, not yet checked
    reviewed = "reviewed"  # checked against official sources by a human
    stale = "stale"  # was reviewed, but an underlying official document changed since


class Review(Strict):
    status: ReviewStatus = ReviewStatus.draft
    reviewed_by: str | None = None
    reviewed_at: date | None = None
    notes: str | None = None


# -- money & rewards ---------------------------------------------------------------------------


class Money(Strict):
    amount: float
    currency: str = "SGD"


class Period(str, Enum):
    transaction = "transaction"
    statement_month = "statement_month"
    calendar_month = "calendar_month"
    quarter = "quarter"
    membership_year = "membership_year"
    calendar_year = "calendar_year"


class RateUnit(str, Enum):
    percent = "percent"  # cashback %
    mpd = "mpd"  # KrisFlyer (or airline) miles per S$1
    points_per_dollar = "points_per_dollar"  # bank points per S$1 (see RewardCurrency.conversions)


class Cap(Strict):
    """A limit on bonus rewards or on eligible spend within a period."""

    amount: float
    unit: Literal["SGD_spend", "SGD_cashback", "miles", "points"]
    period: Period
    shared_with: list[str] = Field(default_factory=list, description="other earn_rule ids sharing the cap")
    sources: list[str] = Field(default_factory=list)


class RoundingBlock(Strict):
    """Rewards are awarded per block of spend, e.g. 4 mpd per S$5 → amount=5."""

    amount: float
    per: Period = Period.transaction
    rounding: Literal["down", "nearest", "none"] = "down"
    sources: list[str] = Field(default_factory=list)


class TransactionMode(str, Enum):
    online = "online"
    in_app = "in_app"
    contactless = "contactless"  # physical card tap
    mobile_wallet = "mobile_wallet"  # Apple/Google/Samsung Pay
    chip_pin = "chip_pin"
    recurring = "recurring"
    foreign_currency = "foreign_currency"
    local_currency = "local_currency"
    overseas_in_sgd = "overseas_in_sgd"  # DCC / SGD charged by overseas merchant


class Eligibility(Strict):
    """Which transactions qualify. Include lists are unioned; exclude lists always win."""

    tags: list[str] = Field(default_factory=list, description="keys of config/categories.yaml")
    include_mcc: list[str] = Field(default_factory=list, description="'5812' or '3000-3350'")
    exclude_mcc: list[str] = Field(default_factory=list)
    include_merchants: list[str] = Field(default_factory=list)
    exclude_merchants: list[str] = Field(default_factory=list)
    modes_required: list[TransactionMode] = Field(
        default_factory=list, description="transaction must be one of these modes"
    )
    modes_excluded: list[TransactionMode] = Field(default_factory=list)
    all_spend: bool = Field(False, description="true = every eligible spend (base rate)")
    description: str | None = None
    sources: list[str] = Field(default_factory=list)


class EarnRule(Strict):
    id: str
    label: str
    rate: float
    unit: RateUnit
    tier: Literal["base", "bonus"] = "bonus"
    eligibility: Eligibility
    min_spend: Money | None = Field(None, description="spend needed in `min_spend_period` to unlock")
    min_spend_period: Period | None = None
    max_spend: Money | None = Field(None, description="spend beyond this in period earns base only")
    max_spend_period: Period | None = None
    bonus_cap: Cap | None = None
    rounding: RoundingBlock | None = None
    conditions: list[str] = Field(default_factory=list, description="other conditions, plain text")
    valid_from: date | None = None
    valid_to: date | None = None
    sources: list[str] = Field(default_factory=list)

    @property
    def uncapped(self) -> bool:
        return self.bonus_cap is None and self.max_spend is None


class Conversion(Strict):
    """Conversion of bank points into a partner currency."""

    partner: str  # e.g. "KrisFlyer"
    points: float
    partner_units: float
    fee: Money | None = None
    min_block_points: float | None = None
    sources: list[str] = Field(default_factory=list)


class Redemption(Strict):
    min_block: float | None = Field(None, description="minimum redeemable, in `min_block_unit`")
    min_block_unit: Literal["SGD", "miles", "points"] | None = None
    fee: Money | None = None
    fee_per: str | None = Field(None, description="e.g. 'conversion', 'redemption'")
    auto_redeemed: bool = False
    expiry_months: int | None = Field(None, description="None = never expires")
    sources: list[str] = Field(default_factory=list)


class RewardCurrency(Strict):
    kind: Literal["cashback", "miles", "points"]
    name: str  # e.g. "Cashback", "KrisFlyer miles", "DBS Points"
    conversions: list[Conversion] = Field(default_factory=list)
    redemption: Redemption = Field(default_factory=Redemption)


class SignUpBonus(Strict):
    offered_by: str  # "bank" or aggregator name
    description: str
    value: Money | None = None
    min_spend: Money | None = None
    spend_within_days: int | None = None
    new_to_bank_only: bool | None = None
    valid_from: date | None = None
    valid_to: date | None = None
    url: str | None = None
    sources: list[str] = Field(default_factory=list)


class AnnualFee(Strict):
    amount: Money
    first_year_waived: bool | None = None
    waiver_notes: str | None = None
    sources: list[str] = Field(default_factory=list)


class Network(str, Enum):
    visa = "visa"
    mastercard = "mastercard"
    amex = "amex"
    unionpay = "unionpay"
    jcb = "jcb"


# -- card --------------------------------------------------------------------------------------


class Card(Strict):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]*$")
    bank: str
    name: str
    network: Network | None = None
    image_url: str | None = None
    official_url: str | None = None

    annual_fee: AnnualFee | None = None
    min_annual_income: Money | None = None
    reward_currency: RewardCurrency
    earn_rules: list[EarnRule]
    general_exclusions: Eligibility = Field(
        default_factory=Eligibility, description="exclusions that apply to all earn rules"
    )
    sign_up_bonuses: list[SignUpBonus] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list, description="additional T&Cs worth knowing")

    tags: list[str] = Field(default_factory=list, description="computed by the build")
    citations: list[Citation] = Field(default_factory=list)
    review: Review = Field(default_factory=Review)
    updated_at: date | None = None

    @model_validator(mode="after")
    def _check_refs(self) -> Card:
        ids = {c.id for c in self.citations}
        missing: set[str] = set()

        def visit(obj):
            if isinstance(obj, BaseModel):
                for name in type(obj).model_fields:
                    val = getattr(obj, name)
                    if name == "sources" and isinstance(val, list):
                        missing.update(s for s in val if s not in ids)
                    else:
                        visit(val)
            elif isinstance(obj, list):
                for v in obj:
                    visit(v)

        visit(self)
        if missing:
            raise ValueError(f"unknown citation ids: {sorted(missing)}")
        rule_ids = [r.id for r in self.earn_rules]
        if len(rule_ids) != len(set(rule_ids)):
            raise ValueError("earn_rules ids must be unique")
        return self

    def best_rule(self) -> EarnRule | None:
        bonus = [r for r in self.earn_rules if r.tier == "bonus"] or self.earn_rules
        return max(bonus, key=lambda r: r.rate, default=None)


# -- staging (per-source machine extracts) ------------------------------------------------------


class StagedCard(BaseModel):
    """Normalised output of one aggregator/source for one card. Loosely typed on purpose: it is
    evidence for curation, not a canonical record."""

    source: str
    source_id: str
    source_url: str
    name: str
    bank: str
    card_id: str | None = None  # registry id once mapped
    image_url: str | None = None
    annual_fee: float | None = None
    annual_fee_note: str | None = None
    min_annual_income: float | None = None
    min_monthly_spend: float | None = None
    earn_rates: dict[str, dict] = Field(
        default_factory=dict, description="category → {value, unit, note}"
    )
    caps: dict[str, dict] = Field(default_factory=dict)
    highlights: list[str] = Field(default_factory=list)
    sign_up_offers: list[dict] = Field(default_factory=list)
    links: dict[str, str] = Field(default_factory=dict)
    citation: Citation
    extra: dict = Field(default_factory=dict)
