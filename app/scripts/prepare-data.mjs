// Slims the pipeline's build output (data/build/cards.json) into the catalogue the app ships
// (public/catalog.json). Run automatically by `npm run dev` / `npm run build`.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const build = JSON.parse(readFileSync(resolve(repo, "data/build/cards.json"), "utf8"));
const { categories } = YAML.parse(readFileSync(resolve(repo, "config/categories.yaml"), "utf8"));

// Spend categories offered as filters: everything except the "commonly excluded" group.
const excluded = new Set(["commonly_excluded", ...(categories.commonly_excluded?.children ?? [])]);
// Aggregate tags overlap other groups (day_to_day spans dining, groceries, transport …); their
// children stay top-level filters instead of being tucked under them.
const aggregates = new Set(["day_to_day"]);
const parentOf = {};
for (const [key, c] of Object.entries(categories)) {
  if (aggregates.has(key)) continue;
  for (const ch of c.children ?? []) parentOf[ch] ??= key;
}
const cats = Object.entries(categories)
  .filter(([key]) => !excluded.has(key))
  .map(([key, c]) => ({
    key,
    // drop the "(e.g. Grab, … — confirm per merchant)" asides; they belong in the pipeline docs
    label: c.label.replace(/\s*\(.*\)\s*$/, ""),
    parent: parentOf[key] ?? null,
    group: Boolean(c.children?.length) && !aggregates.has(key),
  }));

const cleanLabel = (s) => s.replace(/\s*\([^)]*verify\)\s*$/i, "");
const cleanDesc = (s) => {
  if (!s) return null;
  const parts = s
    .replace(/\[[^\]]*auto-extracted[^\]]*\]/gi, "")
    .split(/\s\/\s|\n/)
    .map((p) => p.replace(/^(\s*Up to\s*\|?\s*)+(?=\S)/i, "").replace(/^[|\s]+|[|\s]+$/g, "").trim())
    .filter((p) => p.length > 3 && !/^up to$/i.test(p));
  return [...new Set(parts)].join(" · ") || null;
};
const money = (m) => (m ? m.amount : null);

const cards = build.cards.map((c) => ({
  id: c.id,
  bank: c.bank,
  name: c.name,
  network: c.network ?? null,
  image: c.image_url ?? null,
  url: c.official_url ?? null,
  kind: c.reward_currency.kind,
  currency: c.reward_currency.name,
  fee: c.annual_fee
    ? {
        amount: c.annual_fee.amount.amount,
        firstYearWaived: c.annual_fee.first_year_waived ?? null,
      }
    : null,
  income: money(c.min_annual_income),
  rules: c.earn_rules.map((r) => ({
    id: r.id,
    label: cleanLabel(r.label),
    rate: r.rate,
    unit: r.unit,
    tier: r.tier,
    allSpend: r.eligibility.all_spend,
    desc: cleanDesc(r.eligibility.description),
    minSpend: money(r.min_spend),
    minSpendPeriod: r.min_spend_period ?? null,
    maxSpend: money(r.max_spend),
    maxSpendPeriod: r.max_spend_period ?? null,
    cap: r.bonus_cap ? { amount: r.bonus_cap.amount, unit: r.bonus_cap.unit, period: r.bonus_cap.period } : null,
    modes: r.eligibility.modes_required,
    conditions: r.conditions,
  })),
  coverage: Object.fromEntries(
    Object.entries(c.tag_coverage ?? {}).map(([tag, v]) => [tag, { level: v.level, rules: v.rules }]),
  ),
  bonuses: c.sign_up_bonuses.map((b) => ({
    by: b.offered_by,
    desc: b.description,
    value: money(b.value),
    validTo: b.valid_to ?? null,
    url: b.url ?? null,
  })),
  notes: c.notes,
  status: c.review?.status ?? "draft",
  sources: c.citations.map((s) => ({ url: s.url, type: s.source_type, title: s.title ?? null })),
}));

const out = resolve(here, "../public/catalog.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ builtAt: build.built_at, categories: cats, cards }));
console.log(`catalog.json: ${cards.length} cards, ${cats.length} categories`);
