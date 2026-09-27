import type { CatalogCard, Period, Rule } from "../types";

/** Effective reward in % of spend, or null when it can't be valued (points: no conversion data). */
export function effectivePct(rule: Rule, centsPerMile: number): number | null {
  if (rule.unit === "percent") return rule.rate;
  if (rule.unit === "mpd") return rule.rate * centsPerMile;
  return null;
}

/** The rule to headline: the best one covering `tag` if given, else the best bonus rule. */
export function headlineRule(card: CatalogCard, tag: string | null): Rule | null {
  const pool = tag
    ? card.rules.filter((r) => card.coverage[tag]?.rules.includes(r.id))
    : card.rules.filter((r) => r.tier === "bonus");
  const rules = pool.length ? pool : card.rules;
  return rules.reduce<Rule | null>((best, r) => (!best || r.rate > best.rate ? r : best), null);
}

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

export const fmtRate = (rule: Rule) => {
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
