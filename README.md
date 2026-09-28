# pocketaces

https://pocketaces.pocket-aces.workers.dev/

pocket-aces helps you decide which Singapore credit card to apply for and which card to use for
which spend, and tracks the bills, fees and spend on the cards you hold. The repo has two parts:

- **Data collection** (Python, `src/`): scrapes, curates and builds the card data. Requirements are in
  [specs/data-collection.md](specs/data-collection.md); design notes are in
  [specs/data-collection-plan.md](specs/data-collection-plan.md).
- **The app** (`app/`): an installable web app (PWA) built from `data/build/cards.json`.
  Requirements are in [specs/app-functionalities.md](specs/app-functionalities.md); design notes are in
  [specs/app-plan.md](specs/app-plan.md).

## App

```sh
cd app
npm install
npm run dev        # http://localhost:5173 (service worker is disabled in dev)
npm test
npm run build      # → app/dist; `npm run preview` serves it with the service worker on
```

`npm run dev` and `npm run build` first regenerate `app/public/catalog.json` from
`data/build/cards.json` and `config/categories.yaml`. After a data refresh, `pocketaces build`
followed by a push to `main` is all that's needed: `.github/workflows/pages.yml` rebuilds and
deploys to GitHub Pages. Set **Settings → Pages → Source** to *GitHub Actions* once. Installed apps
pick up the new version from **Settings → Check for updates**, or when they next detect the update.

User data (my cards, notes, bill/fee check-offs, spend logs) is kept on the device in IndexedDB
with a localStorage mirror, and can be exported as a JSON backup from Settings.

**Accounts and sync** (optional): when hosted on Cloudflare, you can sign in with a username and
password, and your data syncs live between your devices. It's encrypted on the device with a key
derived from your password, so the server only stores ciphertext. See
[specs/app-hosting-cloudflare.md](specs/app-hosting-cloudflare.md) to deploy (free plan) and
[specs/app-sync-plan.md](specs/app-sync-plan.md) for the design and security model. On GitHub Pages
the app works as before, without accounts.

```sh
cd app
npx wrangler login && npm run deploy                          # deploy app + sync API to Cloudflare
openssl rand -base64 48 | npx wrangler secret put AUTH_PEPPER   # once, after the first deploy
npm run dev:api    # local API for `npm run dev` (copy .dev.vars.example to .dev.vars first)
```

Reminders: the app shows due bills and fees when opened and can send system notifications.
Background notifications only work in the installed app on Android/Chromium (Periodic Background
Sync). On iOS, use **Add reminders to my calendar**, which exports an `.ics` file with alarms.

## Data collection

### Setup

```sh
uv sync --extra browser          # add --extra llm for LLM-assisted T&C extraction
uv run playwright install chromium   # needed for Moneysmart (Cloudflare)
```

### Refreshing data

```sh
uv run pocketaces refresh        # full pipeline; add --llm to also run LLM extraction
```

Or run the steps one at a time:

| Step | Command | Writes |
|---|---|---|
| Reference data | `pocketaces reference all` | `data/reference/mcc_codes.json`, `data/reference/krisflyer/award_chart.json` |
| Aggregators | `pocketaces fetch all` (or `singsaver`, `moneysmart`, `milelion`) | `data/staging/<source>/` |
| New cards | `pocketaces discover` / `--write` | proposals for `config/cards.yaml` |
| Official T&Cs | `pocketaces tnc [card_id …] [--llm]` | `data/staging/tnc/<card_id>.json`, T&C text in `data/raw/bank/` |
| Drafts | `pocketaces curate --all` | `data/curated/cards/<card_id>.yaml` (drafts overwritten; reviewed cards get `data/staging/suggestions/<card_id>.yaml`) |
| Build | `pocketaces build` | `data/build/cards.json`, `data/build/report.md` |

Every fetch is snapshotted under `data/raw/<source>/`, and `manifest.json` records the URL, time and
sha256. These entries are the citations that each record's `citations` list points to.

**Each refresh overwrites the data, except where a step fails**, in which case the last good copy is
kept:

| Data | Overwritten when | Kept when |
|---|---|---|
| Raw snapshots | the URL is fetched successfully | the fetch fails |
| Aggregator staging | the card's page parses | its fetch/parse fails, a Moneysmart listing page fails, or a source returns nothing at all (delisted cards are removed) |
| Milelion reviews | the post downloads | the post fails to download |
| T&C extractions | the document downloads | the download fails (entry marked `carried_over`, with `last_error`) |
| Curated drafts | the draft builds | draft generation fails; **reviewed records are never overwritten** (see below) |
| MCC list / award chart | the result passes sanity checks | the parse looks wrong |
| Build | every run | a curated record is invalid (its previous entry is kept, marked `carried_over`) |

Hosts that fail twice at the connection level (e.g. maybank2u.com.sg from some networks) are
skipped for the rest of the run instead of timing out on every card.

### Review workflow (accuracy)

Scraped data is evidence, not truth. A card only counts as verified once a person has checked it
against the official T&Cs:

1. Run `pocketaces refresh`, then open `data/build/report.md`.
2. For each card listed under *Not yet reviewed* or *Stale*, open `data/curated/cards/<id>.yaml`.
   Compare it with the official T&C text (paths are in `data/staging/tnc/<id>.json`; the MCC hits
   there include the line each code came from). Fix the earn rules, caps, min/max spend, rounding
   blocks and MCC lists.
3. Cite the official document for each rule (`sources: [bank:…]`), then set:
   ```yaml
   review: {status: reviewed, reviewed_by: <name>, reviewed_at: 2026-09-27}
   ```
4. Run `pocketaces build` again. If a cited T&C changes on a later refresh, the card is automatically
   marked `stale` and reappears in the report.

`config/cards.yaml` has one entry per card: our id, the bank, `official.product_page` (T&C PDFs are
discovered from this page) or explicit `official.tnc_urls`, and the card's slug on each aggregator.
Adding a card means adding an entry here; no code changes are needed. Set `status: discontinued` to
keep a retired card's history without refreshing it.

T&C caveats handled by the pipeline, each surfaced in `report.md`:

- **robots.txt**: HSBC disallows automated PDF fetching (`Disallow: /*.pdf$`). Download the PDF in a
  browser and run `pocketaces tnc import <card_id> <file> --url <official url>`. The imported copy
  is snapshotted and cited just like a fetched one.
- **Image-only PDFs** (no text layer) are flagged for manual reading.
- **Soft 404s**: retired product pages that redirect to a listing page with HTTP 200 are detected.
- **Split documents**: some banks keep MCC exclusions in a separate shared document (e.g. DBS Rewards
  T&C, Citi Rewards Exclusion List, Amex exclusions, SC's HTML exclusions page). List every relevant
  document in `tnc_urls`.

### Other data

- **Spend tags**: `config/categories.yaml` maps tags (travel, transport, dining, big_ticket …) to
  MCCs. The build computes each card's tag coverage from its best earn rule.
- **Merchant MCCs**: `pocketaces merchants add "Grab" 4121 --source <url>` records an observed MCC;
  a source is required. `pocketaces merchants candidates` lists MCC mentions mined from Milelion
  as leads.
- **KrisFlyer**: the official Saver/Advantage chart is parsed from SIA's PDF. For dynamic prices,
  log sightings with `pocketaces awards log …`, and `pocketaces awards ranges` summarises them by
  days booked in advance.

### Tests

```sh
uv run --group dev pytest
```
