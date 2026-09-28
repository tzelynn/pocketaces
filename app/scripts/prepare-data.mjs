// Slims the pipeline's build output (data/build/cards.json) into the catalogue the app ships
// (public/catalog.json). Run automatically by `npm run dev` / `npm run build`.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { limitedTime, narrowScope } from "./rule-limits.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const build = JSON.parse(readFileSync(resolve(repo, "data/build/cards.json"), "utf8"));
const { categories, transaction_modes: modeLabels = {} } = YAML.parse(
  readFileSync(resolve(repo, "config/categories.yaml"), "utf8"),
);

const shortLabel = (label) => label.replace(/\s*\(.*\)\s*$/, "");

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
    label: shortLabel(c.label),
    parent: parentOf[key] ?? null,
    group: Boolean(c.children?.length) && !aggregates.has(key),
  }));

// Explicitly stated inclusions: categories a rule names outright, plus those whose MCC lists the
// rule fully covers (partial overlaps are inference, not a statement). A group's children fold into
// it, and aggregates are dropped since their children are already listed.
const order = Object.keys(categories);
// MCC list entries are single codes or inclusive ranges ("3000-3350")
const codesOfList = (list) =>
  new Set((list ?? []).flatMap((m) => {
    const [a, b = a] = String(m).split("-").map(Number);
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }));
const codesOf = (tag) => {
  const c = categories[tag];
  return new Set([...codesOfList(c.mcc), ...(c.children ?? []).flatMap((ch) => [...codesOf(ch)])]);
};
// a tag whose codes all sit inside another listed tag (jewellery ⊂ retail shopping) adds nothing
const subsumed = (t, tags) => [...tags].some((u) => u !== t && [...codesOf(t)].every((m) => codesOf(u).has(m)));
const byOrder = (a, b) => order.indexOf(a) - order.indexOf(b);
function ruleIncludes(c, r) {
  const tags = new Set(r.eligibility.tags);
  for (const [tag, v] of Object.entries(c.tag_coverage ?? {}))
    if (v.level === "full" && v.rules.includes(r.id)) tags.add(tag);
  const kept = [...tags].filter((t) => !aggregates.has(t) && !excluded.has(t) && !(parentOf[t] && tags.has(parentOf[t])));
  return kept.filter((t) => !subsumed(t, kept)).sort(byOrder);
}

// Transaction modes a rule applies to: those it requires, plus those its aggregator label names
// ("local online shopping", "contactless spend", "overseas"). Overseas only counts when the label
// doesn't also say local, since "local, overseas" is just general spend.
const MODE_GROUP = "transaction_mode";
const modeOrder = Object.keys(modeLabels);
function ruleModes(r) {
  const modes = new Set(r.eligibility.modes_required);
  const parts = cleanLabel(r.label).toLowerCase().split(/\s*,\s*/);
  if (parts.some((p) => p.includes("online"))) modes.add("online");
  if (parts.some((p) => p.includes("contactless"))) modes.add("contactless");
  if (parts.some((p) => /^(overseas|forex)/.test(p)) && !parts.some((p) => p.startsWith("local"))) modes.add("foreign_currency");
  return [...modes].filter((m) => m in modeLabels).sort((a, b) => modeOrder.indexOf(a) - modeOrder.indexOf(b));
}
// Filter tags a rule counts for: its own and covered tags, the groups above them, the children of
// groups it names, and its transaction modes.
function ruleTags(c, r, modes) {
  const tags = new Set(r.eligibility.tags.flatMap((t) => [t, ...(categories[t]?.children ?? [])]));
  for (const [tag, v] of Object.entries(c.tag_coverage ?? {})) if (v.rules.includes(r.id)) tags.add(tag);
  for (const t of [...tags]) if (parentOf[t]) tags.add(parentOf[t]);
  if (modes.length) tags.add(MODE_GROUP);
  return [...tags, ...modes].filter((t) => !excluded.has(t));
}
// Explicitly stated exclusions: commonly-excluded categories the card's general exclusions hit, plus
// spend categories they mostly take away (Citi Rewards excludes airlines, hotels …). One stray code
// (hospitals 8062 in healthcare) doesn't count. A group whose children are all hit folds into it; a
// partly-hit group lists just the children hit.
const EXCLUDED_SHARE = 0.5;
const spendLeaves = Object.entries(categories)
  .filter(([key, c]) => c.mcc && !excluded.has(key) && !aggregates.has(key))
  .map(([key]) => key);
function excludes(c) {
  const codes = codesOfList(c.general_exclusions.exclude_mcc);
  const hit = new Set(spendLeaves.filter((t) => {
    const own = [...codesOf(t)];
    return own.filter((m) => codes.has(m)).length >= EXCLUDED_SHARE * own.length;
  }));
  for (const [key, cat] of Object.entries(categories)) {
    if (aggregates.has(key) || excluded.has(key) || !cat.children?.length) continue;
    if (cat.children.every((ch) => hit.has(ch))) {
      cat.children.forEach((ch) => hit.delete(ch));
      hit.add(key);
    }
  }
  const spend = [...hit].filter((t) => !subsumed(t, hit));
  const common = [...(c.excluded_categories ?? []), ...c.general_exclusions.tags].filter((t) => excluded.has(t));
  return [...new Set([...spend, ...common])].sort(byOrder);
}

// Commonly-excluded categories, labelled for the exclusions icon key.
const exclusions = (categories.commonly_excluded?.children ?? []).map((key) => ({
  key,
  label: shortLabel(categories[key].label),
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

function slimRule(c, r) {
  const modes = ruleModes(r);
  return {
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
    // what the rule earns on, for display: spend categories, then transaction modes
    includes: [...ruleIncludes(c, r), ...modes],
    tags: ruleTags(c, r, modes),
    // named merchants or select countries only: flagged, and left out of the card's ranking
    limit: narrowScope(r),
  };
}

// Limited-time rates stay out of the catalogue: a promotion's rate is no guide to the card, and the
// aggregators keep listing them well after they end. Where the text says what the rate drops to
// ("… for the first 2 quarters. Thereafter, earn 5%"), the rule stays at that rate instead.
function splitRules(c) {
  const rules = [], promos = [];
  for (const r of c.earn_rules) {
    const t = limitedTime(r);
    if (t) promos.push({ label: cleanLabel(r.label), rate: r.rate, unit: r.unit, until: t.until, text: t.text, after: t.after });
    if (!t) rules.push(slimRule(c, r));
    else if (t.after != null && t.after > 0)
      rules.push({ ...slimRule(c, r), rate: t.after, desc: cleanDesc((r.eligibility.description ?? "").replace(t.text, "")) });
  }
  return { rules, promos };
}

// Sign-up offers: the headline ("SingSaver Exclusive Offer: choice of …" → "SingSaver Exclusive Offer"),
// the gifts on offer, and rough values for ranking them: the cash option, the priciest gift's stated
// worth, and the miles count of a miles gift (valued in the app at the user's cents per mile).
// gifts needing a top-up aren't free, so they don't set the worth; "S$1,8xx" reads as S$1,800
const num = (s) => Number(s.replace(/,/g, "").replace(/x/gi, "0"));
const topUp = (o) => /top[- ]?up/i.test(o);
const worthOf = (o) => (topUp(o) ? [] : [
  ...o.matchAll(/worth (?:over |up to )?S\$\s*(\d[\d,]*x*)/gi),
  ...o.matchAll(/S\$\s*(\d[\d,]*)\s+[\w ]*?vouchers?\b/gi),
].map((m) => num(m[1])));
const milesOf = (o) => (/(?:up to )?([\d,]{4,})\s+(?:[A-Z][\w]*\s+){0,2}miles/i.exec(o) ? num(RegExp.$1) : null);
function slimBonus(b) {
  const options = b.options?.length ? b.options : [b.description];
  const worth = Math.max(0, ...options.flatMap(worthOf));
  const miles = Math.max(0, ...options.filter((o) => !topUp(o) && !worthOf(o).length).map(milesOf).filter(Boolean));
  return {
    by: b.offered_by,
    title: b.options?.length && !/^choice of/i.test(b.description) ? b.description.split(":")[0].trim() : null,
    desc: b.description,
    options,
    value: money(b.value),
    worth: worth || null,
    miles: miles || null,
    minSpend: money(b.min_spend),
    withinDays: b.spend_within_days ?? null,
    newToBank: b.new_to_bank_only ?? null,
    stackable: b.stackable ?? null,
    terms: b.terms ?? null,
    validTo: b.valid_to ?? null,
    url: b.url ?? null,
  };
}

const slimConversion = (v) =>
  v ? { partner: v.partner, points: v.points, miles: v.partner_units, fee: v.fee?.amount ?? null } : null;

const cards = build.cards.map((c) => ({ c, ...splitRules(c) })).map(({ c, rules, promos }) => ({
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
  // absent from older builds; the model defaults to the calendar month
  spendCycle: c.spend_cycle === "statement_month" ? "statement" : "calendar",
  spendCycleStated: (c.spend_cycle_sources ?? []).length > 0,
  expiry: c.reward_currency.expiry
    ? {
        never: c.reward_currency.expiry.never ?? false,
        months: c.reward_currency.expiry.months ?? null,
        monthsMax: c.reward_currency.expiry.months_max ?? null,
      }
    : null,
  conversion: slimConversion(c.reward_currency.conversions?.[0]),
  rules,
  limitedTime: promos,
  excludes: excludes(c),
  bonuses: c.sign_up_bonuses.map(slimBonus),
  notes: c.notes,
  status: c.review?.status ?? "draft",
  sources: c.citations.map((s) => ({ url: s.url, type: s.source_type, title: s.title ?? null })),
}));

// Transaction modes join the filters as their own group, listing only modes some card earns on.
const usedModes = new Set(cards.flatMap((c) => c.rules.flatMap((r) => r.includes)));
cats.push(
  { key: MODE_GROUP, label: "Transaction mode", parent: null, group: true },
  ...modeOrder.filter((m) => usedModes.has(m)).map((key) => ({ key, label: shortLabel(modeLabels[key]), parent: MODE_GROUP, group: false })),
);

const out = resolve(here, "../public/catalog.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ builtAt: build.built_at, categories: cats, exclusions, cards }));
console.log(`catalog.json: ${cards.length} cards, ${cats.length} categories`);
