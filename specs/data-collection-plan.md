# Data collection — implementation plan

Companion to [data-collection.md](data-collection.md). Describes how the pipeline is built, and why.

## Principles

1. **Every fact carries a citation.** Each raw fetch is snapshotted (URL, timestamp, sha256) and every
   extracted value points back to the snapshot it came from.
2. **Official sources win.** Aggregators (SingSaver, Moneysmart, Milelion) are used for *discovery*
   and *cross-checking*; bank T&Cs are the source of truth for earn rules and MCC restrictions.
3. **Machines draft, humans approve.** Scrapers write to `data/staging/`. Only human-reviewed
   records in `data/curated/` are treated as verified. The build flags every conflict and every
   unverified field instead of silently picking a value.
4. **Refresh without edits.** Parsers target embedded structured data (Next.js flight data, Nuxt
   payloads, WordPress REST, PDF tables), not CSS selectors, so layout changes rarely break them.
   Card-specific knowledge lives in YAML config, not code.

## Sources and how each is read

| Source | Access | What we take |
|---|---|---|
| SingSaver | plain HTTP; Next.js RSC flight data in page | card list, earn rates by category, caps, fees, income, sign-up gifts |
| Moneysmart | Playwright (Cloudflare); Nuxt `__NUXT_DATA__` payload | card list, highlights, key features, fees, promotions |
| Milelion | WordPress REST API | card reviews (links + text) for cross-checking; MCC mentions mined as merchant→MCC candidates |
| Bank sites | plain HTTP; product page → T&C PDF discovery | T&C PDFs (archived), MCC include/exclude lists, transaction-mode rules |
| Singapore Airlines | plain HTTP; official award chart PDF | KrisFlyer Saver/Advantage miles by zone and cabin |
| MCC reference | greggles/mcc-codes (ISO 18245 list) | code → description |

## Directory layout

```
config/
  sources.yaml        # endpoints for each source (URLs, pagination, rate limits)
  cards.yaml          # card registry: id, bank, official URLs, per-source slugs
  categories.yaml     # spend tags (travel, transport, dining, ...) → MCC codes/ranges
data/
  raw/<source>/…                   # latest snapshot per URL + manifest.json (citation store)
  staging/<source>/<card_id>.json  # normalised machine extracts, one per card per source
  curated/cards/<card_id>.yaml     # human-reviewed canonical records (source of truth)
  reference/
    mcc_codes.json
    merchants.yaml                 # merchant → MCC, each with citation
    krisflyer/award_chart.json
    krisflyer/observations.csv     # observed redemption prices (days-in-advance, dates, route)
  build/
    cards.json                     # merged, validated, tagged output for the app
    report.md                      # conflicts, unverified fields, T&C changes, unmapped cards
src/pocketaces/                    # the package (CLI: `pocketaces …`)
```

## Card data model (summary)

`Card` → identity (bank, name, network, image), fees, income requirement, `reward_currency`
(cashback / miles / points with conversion to KrisFlyer, redemption block and fee), `earn_rules[]`
(rate, unit, min/max spend, bonus cap, rounding block, eligibility: tags, include/exclude MCCs,
transaction modes), `general_exclusions`, `sign_up_bonuses[]`, `notes[]`, `citations[]`, `review`.
Every scalar that matters is stored with `sources: [citation_id]`. See `src/pocketaces/models.py`.

## Pipeline

```
pocketaces fetch <source>     # snapshot raw pages/PDFs → data/raw, parse → data/staging
pocketaces discover           # list aggregator cards missing from config/cards.yaml (+ suggested entries)
pocketaces tnc                # download official T&Cs, detect changes by hash, extract MCC lists (+ optional LLM)
pocketaces reference mcc      # refresh MCC code list
pocketaces reference awards   # refresh KrisFlyer award chart
pocketaces curate <card_id>   # create/refresh a curated draft from staging, preserving human edits
pocketaces build              # merge curated + staging, validate, tag, diff vs last build, write report
pocketaces refresh            # all of the above in order
```

## Accuracy safeguards

- MCC extraction from T&Cs is regex-based, with the section heading and line captured for every code, so a
  reviewer can see *why* a code was classed as excluded or included.
- The optional LLM extraction (`--llm`, needs `ANTHROPIC_API_KEY`) is cross-checked. Any MCC it returns that
  does not appear literally in the source text is rejected. Any MCC in the text that it did not classify is
  reported.
- `categories.yaml` codes are validated against the MCC reference list.
- A changed T&C hash marks the curated record `review.status: stale` until someone re-reviews it.
- The build reports disagreements between sources, for example SingSaver and Moneysmart giving different
  annual fees.

## Out of scope for now

- Live KrisFlyer award-search scraping (needs a logged-in session). Dynamic pricing is instead captured as
  observations (`pocketaces awards log …`), and ranges are computed from them.
- Merchant→MCC ground truth. There is no official public source, so entries need a citation and start as
  candidates.
