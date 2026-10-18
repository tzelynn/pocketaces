// Reads what an earn rule's text says about how far its rate reaches: a limited-time promotion, or a
// rate that only applies at named merchants or in select countries. Aggregator descriptions merge
// several blurbs, so each is judged on the sentences that quote the rule's own rate. A curated
// `valid_to` / `include_merchants` settles it without the text.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Sentences of an eligibility description ("a. B" and "a; b" split, "min. spend" doesn't). */
export function sentences(text) {
  if (!text) return [];
  return text
    .replace(/\[[^\]]*auto-extracted[^\]]*\]/gi, "")
    .split(/\s\/\s|\n|\s*\|\s*|;\s*|\s{2,}|(?<=\.)(?<!\b(?:min|max|incl|excl|approx|no|vs)\.)\s+(?=[A-Z(])/i)
    .map((s) => s.replace(/^[\s/]+|^\s*Up to\s*$/gi, "").trim())
    .filter((s) => s.length > 3);
}

const num = (n) => String(+n.toFixed(2)).replace(".", "\\.");
/** "3.25%", "6 miles", "10 mpd", "21 Linkpoints": the rate quoted with a reward unit. */
const quotes = (rate) =>
  new RegExp(`(?<![\\d.,])${num(rate)}(?:\\.0+)?\\s*(?:%|mpd\\b|miles?\\b|(?:link|thankyou )?points?\\b|pts\\b|x\\b)`, "i");

/** The sentences about this rate, or all of them when none quotes it. */
function relevant(r) {
  const all = sentences(r.eligibility.description);
  const q = quotes(r.rate);
  const about = all.filter((s) => q.test(s));
  return about.length ? about : all;
}

// -- limited time ---------------------------------------------------------------------------

const UNTIL = /\b(?:valid|now|available|runs?)\s+(?:till|until|to|through)\s+(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/i;
const INTRO = /\b(?:for|in|during) the first \d+\s+(?:calendar\s+)?(?:days?|months?|quarters?)\b|\bfor a limited time\b|\bpromotion(?:al)? period\b/i;
const THEREAFTER = /\bthereafter,?\s+(?:earn\s+)?(?:up to\s+)?(\d+(?:\.\d+)?)%/i;

const ymd = (d, m, y) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * Whether the rule's rate is a promotion: `{ until, text, after }` (`until` the end date if stated,
 * `after` the rate the text says applies once it ends), or null for an ongoing rate.
 */
export function limitedTime(r) {
  if (r.tier === "base") return null;
  if (r.valid_to || r.valid_from) return { until: r.valid_to ?? null, text: r.eligibility.description ?? r.label, after: null };
  const q = quotes(r.rate);
  const hits = sentences(r.eligibility.description).filter((s) => q.test(s) && (UNTIL.test(s) || INTRO.test(s)));
  if (!hits.length) return null;
  const m = UNTIL.exec(hits[0]);
  const mon = m && MONTHS[m[2].toLowerCase()];
  const after = THEREAFTER.exec(r.eligibility.description ?? "");
  return { until: mon ? ymd(+m[1], mon, m[3]) : null, text: hits[0], after: after ? Number(after[1]) : null };
}

// -- narrow scope ---------------------------------------------------------------------------

const MERCHANT_WORDS =
  /\b(?:select(?:ed)?|participating|bonus|partner|eligible)\s+(?:[\w-]+\s+){0,2}(?:merchants?|partners?|outlets?|brands?)\b|\b10Xcelerator\b/i;
const COUNTRY_WORDS =
  /\bselect(?:ed)? (?:countries|markets|currencies)\b|\b(?:regional )?spend in (?:Malaysia|Indonesia|Thailand|Vietnam|Japan|Korea|China|Taiwan|Hong Kong|Philippines|Australia)|\bin (?:Malaysian Ringgit|Indonesian Rupiah|Thai Baht|Japanese Yen)\b|\bin (?:MYR|IDR|THB|JPY)\b/i;
// Capitalised words that name a kind of spend, a card, a bank or a place rather than a merchant.
const NOT_MERCHANT = new Set(`
  All Any Everyday Eligible Qualifying Selected Select Local Overseas Foreign Online Offline In-store Contactless Mobile
  Retail Shopping Shop Dining Dine Food Restaurants Transport Travel Petrol Fuel Grocery Groceries Supermarket Supermarkets
  Health Healthcare Beauty Wellness Fashion Family Entertainment Play Gym Streaming Telco Utilities Bills Bill Insurance
  Education Pet Pets Shops Veterinary Services Taxi Taxis Automobile Cruises Cruise Hotel Hotels Airlines Flights Bus Train
  Department Store Stores Charging Stations Category Categories Rewards Preferred Partner Merchants Merchant Spend
  Purchases Transactions Payment Payments Facility
  Singapore SGD Mastercard Visa Amex American Express UnionPay DBS POSB UOB OCBC Citi HSBC Maybank CIMB BOC ICBC Standard Chartered
`.trim().split(/\s+/));
// "at McDonald's, Grab and Shopee", "on Kaligo", "via Agoda, Expedia and UOB Travel", "in Takashimaya"
const NAMED = /\b(?:[Aa]t|[Oo]n|[Vv]ia|[Ff]rom|[Ii]n)\s+(?:(?:your|eligible|select(?:ed)?|participating)\s+)?((?:[A-Z][\w’'&.+/$-]*)(?:\s+[A-Z][\w’'&.+/$-]*)*(?:\s*(?:,|\band\b|\bor\b|&)\s*(?:[A-Z][\w’'&.+/$-]*)(?:\s+[A-Z][\w’'&.+/$-]*)*)*)/g;
// "with at least S$800 annual spend on Singapore Airlines" is what unlocks the rate, not where it
// applies; "capped at S$25" is a cap
const NOT_WHERE = /\b(?:(?:annual|at least S\$[\d,]+|min(?:imum|\.)? (?:spend )?of S\$[\d,]+)\s+(?:\w+\s+)?spend(?:ing)?|capped|cap|max(?:imum)?)\s+$/i;

// "Capped at S$15 per month", "Minimum spend of S$800 required.": says nothing about where the rate applies
const CAP_ONLY = /^(?:capped|cap|max(?:imum)?|min(?:imum|\.)?|with (?:a )?min(?:imum|\.)?|no min(?:imum|\.)?|earned in)\b[^,;]*$/i;

function namesMerchant(s) {
  for (const m of s.matchAll(NAMED)) {
    if (NOT_WHERE.test(s.slice(0, m.index))) continue;
    const words = m[1].split(/[\s,&/]+|\band\b|\bor\b/).filter(Boolean);
    // amounts ("S$20", "UNI$12.5") aren't names
    if (words.some((w) => /^[A-Z]/.test(w) && !w.includes("$") && !NOT_MERCHANT.has(w.replace(/[’'].*$|[.]+$/g, "")))) return true;
  }
  return false;
}

/**
 * Whether the rule's rate only applies somewhere narrow: `{ kind: "merchants" | "countries", text }`,
 * `text` being the sentence that says so. Every sentence about the rate must be narrow.
 */
export function narrowScope(r) {
  if (r.tier === "base" || r.eligibility.all_spend) return null;
  if (r.eligibility.include_merchants?.length)
    return { kind: "merchants", text: r.eligibility.include_merchants.join(", ") };
  const about = relevant(r);
  if (!about.length) return null;
  const kinds = about
    .filter((s) => !CAP_ONLY.test(s))
    .map((s) => (COUNTRY_WORDS.test(s) ? "countries" : MERCHANT_WORDS.test(s) || namesMerchant(s) ? "merchants" : null));
  if (!kinds.length || kinds.some((k) => !k)) return null;
  return { kind: kinds.every((k) => k === "countries") ? "countries" : "merchants", text: about[0] };
}
