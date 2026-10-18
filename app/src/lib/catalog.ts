import type { Bonus, CatalogCard, Period, PointsExpiry, Rule, Ymd } from "../types";

/** Effective reward in % of spend, or null when it can't be valued (points: no conversion data). */
export function effectivePct(rule: Rule, centsPerMile: number): number | null {
  if (rule.unit === "percent") return rule.rate;
  if (rule.unit === "mpd") return rule.rate * centsPerMile;
  return null;
}

/**
 * The rule to headline and rank the card by: the best one covering `tag` if given, else the best bonus
 * rule. Rates limited to named merchants or select countries don't count while the base rate is there,
 * since it's what the card earns across the category.
 */
export function headlineRule(card: CatalogCard, tag: string | null): Rule | null {
  const pool = tag ? card.rules.filter((r) => r.tags.includes(tag)) : card.rules.filter((r) => r.tier === "bonus");
  const broad = pool.filter((r) => !r.limit);
  const base = baseRule(card);
  const rules = broad.length ? broad : base ? [base] : pool.length ? pool : card.rules;
  return rules.reduce<Rule | null>((best, r) => (!best || r.rate > best.rate ? r : best), null);
}

/**
 * Rules worth a row of their own, best first: those above 1% cashback or 1 mpd (points, which can't
 * be valued, above the base rate), restricted to `tag` if given. A base rule matched by a bonus rule
 * is dropped as a duplicate. Falls back to the headline rule alone.
 */
export function rateRules(card: CatalogCard, tag: string | null): Rule[] {
  const base = baseRule(card);
  const pool = tag ? card.rules.filter((r) => r.tags.includes(tag)) : card.rules;
  const rows = pool
    .filter((r) => r.rate > (r.unit === "points_per_dollar" ? base?.rate ?? 1 : 1))
    .filter((r) => r.tier === "bonus" || !pool.some((b) => b.tier === "bonus" && b.rate === r.rate))
    .sort((a, b) => b.rate - a.rate);
  if (rows.length) return rows;
  const head = headlineRule(card, tag);
  return head ? [head] : [];
}

export const LIMIT_LABEL: Record<NonNullable<Rule["limit"]>["kind"], string> = {
  merchants: "Select merchants only",
  countries: "Select countries only",
};

export const baseRule = (card: CatalogCard): Rule | null => card.rules.find((r) => r.tier === "base") ?? null;

/**
 * Spend (S$) that earns the rule's rate before the cap bites. Infinity = uncapped.
 * A reward cap is converted to spend via the rate, e.g. S$60 cashback at 8% → S$750.
 */
export function spendCap(rule: Rule): number {
  const caps: number[] = [];
  if (rule.maxSpend != null) caps.push(rule.maxSpend);
  if (rule.cap) {
    const { amount, unit } = rule.cap;
    if (unit === "SGD_spend") caps.push(amount);
    else if (unit === "SGD_cashback" && rule.unit === "percent" && rule.rate > 0) caps.push(amount / (rule.rate / 100));
    else if (unit === "miles" && rule.unit === "mpd" && rule.rate > 0) caps.push(amount / rule.rate);
    else if (unit === "points" && rule.unit === "points_per_dollar" && rule.rate > 0) caps.push(amount / rule.rate);
  }
  return caps.length ? Math.min(...caps) : Infinity;
}

export const capPeriod = (rule: Rule): Period | null => rule.maxSpendPeriod ?? rule.cap?.period ?? null;

/** Minimum spend needed to unlock the rule (0 = none). */
export const minSpend = (rule: Rule | null): number => rule?.minSpend ?? 0;

export const hasMinSpend = (card: CatalogCard) => card.rules.some((r) => r.minSpend != null);

export const PERIOD_SHORT: Record<Period, string> = {
  transaction: "/txn",
  statement_month: "/mo",
  calendar_month: "/mo",
  quarter: "/qtr",
  membership_year: "/yr",
  calendar_year: "/yr",
};

export const fmtMoney = (n: number, dp = 0) =>
  "S$" + n.toLocaleString("en-SG", { minimumFractionDigits: dp, maximumFractionDigits: dp });

const fmtMonths = (m: number) => (m % 12 === 0 ? `${m / 12} yr${m === 12 ? "" : "s"}` : `${m} mo`);

/** "No expiry", "3 yrs", "12–15 mo", "Up to 5 yrs"; null when not known. */
export function fmtExpiry(e: PointsExpiry | null): string | null {
  if (!e) return null;
  if (e.never) return "No expiry";
  if (e.months != null && e.monthsMax != null) {
    const both = e.months % 12 === 0 && e.monthsMax % 12 === 0;
    return both ? `${e.months / 12}–${e.monthsMax / 12} yrs` : `${e.months}–${e.monthsMax} mo`;
  }
  if (e.months != null) return fmtMonths(e.months);
  return e.monthsMax != null ? `Up to ${fmtMonths(e.monthsMax)}` : null;
}

/** Transfer fee ("S$27.25", "Free") and minimum block ("25,000 pts → 10,000 miles"); null parts are unknown. */
export function fmtConversion(c: CatalogCard["conversion"]): { fee: string | null; block: string | null } | null {
  if (!c) return null;
  const n = (x: number) => x.toLocaleString("en-SG");
  return {
    fee: c.fee == null ? null : c.fee === 0 ? "Free" : fmtMoney(c.fee, 2),
    block: c.points > 1 ? `${n(c.points)} pts → ${n(c.miles)} ${c.partner} miles` : null,
  };
}

/** Some earn rule has a monthly min spend or cap, so which month it counts over matters. */
export const hasMonthlyLimits = (card: CatalogCard) =>
  card.rules.some((r) => [r.minSpendPeriod, r.maxSpendPeriod, r.cap?.period].some((p) => p === "calendar_month" || p === "statement_month"));

export const fmtRate = (rule: Pick<Rule, "rate" | "unit">) => {
  const r = +rule.rate.toFixed(2);
  return rule.unit === "percent" ? `${r}%` : rule.unit === "mpd" ? `${r} mpd` : `${r} pts/S$`;
};

/** Suggested monthly tracking targets for a new wallet card, taken from its catalogue entry. */
export function trackingDefaults(card: CatalogCard): { minSpend?: number; maxSpend?: number } {
  const bonus = card.rules.filter((r) => r.tier === "bonus");
  const mins = bonus.map((r) => r.minSpend).filter((n): n is number => n != null);
  const monthly = new Set<Period>(["statement_month", "calendar_month"]);
  const caps = bonus
    .filter((r) => { const p = capPeriod(r); return p != null && monthly.has(p); })
    .map(spendCap)
    .filter(Number.isFinite);
  return {
    minSpend: mins.length ? Math.max(...mins) : undefined,
    maxSpend: caps.length ? Math.round(Math.min(...caps)) : undefined,
  };
}

/** A flash deal only goes to the first few applicants each day, so it isn't a gift you can count on. */
export const isFlashDeal = (b: Bonus) => /flash/i.test(b.title ?? "");

/** Sign-up offers still open on `on`, most valuable first; flash deals after the offers anyone can get. */
export const activeBonuses = (card: CatalogCard, on: Ymd, centsPerMile: number): Bonus[] =>
  card.bonuses
    .filter((b) => !b.validTo || b.validTo >= on)
    .sort((a, b) => Number(isFlashDeal(a)) - Number(isFlashDeal(b))
      || (bonusValue(b, centsPerMile) ?? -1) - (bonusValue(a, centsPerMile) ?? -1));

/** Rough S$ value of an offer's best gift: cash, a gift's stated worth, or miles at `centsPerMile`. */
export function bonusValue(b: Bonus, centsPerMile: number): number | null {
  const v = Math.max(b.value ?? 0, b.worth ?? 0, b.miles ? (b.miles * centsPerMile) / 100 : 0);
  return v || null;
}

const dropWorth = (o: string) => o.replace(/\s*\((?:worth|top)[^)]*\)/gi, "").trim();

/** What to headline for an offer: its best gift, then what else is on the menu. */
export function bonusHeadline(b: Bonus, centsPerMile: number): { big: string; sub: string | null; text: boolean } {
  const others = b.options.length - 1;
  const more = others > 0 ? `or ${others} other gift${others > 1 ? "s" : ""}` : null;
  const join = (...p: (string | null)[]) => p.filter(Boolean).join(" · ") || null;
  const milesValue = b.miles ? (b.miles * centsPerMile) / 100 : 0;
  const best = Math.max(b.value ?? 0, b.worth ?? 0, milesValue);
  if (!best) return { big: dropWorth(b.options[0] ?? b.desc), sub: more, text: true };
  if (best === b.value) return { big: fmtMoney(b.value), sub: join("cash", more), text: false };
  if (best === b.worth) {
    const gift = b.options.find((o) => o.includes(fmtMoney(b.worth!).slice(2)));
    return { big: fmtMoney(b.worth), sub: join(gift ? `gift: ${dropWorth(gift)}` : "gift", more), text: false };
  }
  // "Up to 100,000 miles" is usually tiered: the full count needs far more than the min spend
  const upTo = b.options.some((o) => /\bup to\b/i.test(o) && /miles/i.test(o));
  const count = b.miles! % 1000 === 0 ? `${b.miles! / 1000}k` : b.miles!.toLocaleString("en-SG");
  return { big: `${count} miles`, sub: join(`${upTo ? "up to " : ""}≈ ${fmtMoney(milesValue)}`, more), text: false };
}

export const OFFERED_BY: Record<string, string> = { singsaver: "SingSaver", moneysmart: "Moneysmart", bank: "the bank" };

/** "in 30 days", "in 6 months" */
export const withinLabel = (days: number) =>
  days % 30 === 0 && days >= 60 ? `in ${days / 30} months` : `in ${days} days`;
