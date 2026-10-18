# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

pocket-aces helps pick Singapore credit cards and tracks bills, fees and spend on cards held. Two parts
share one repo: a Python data pipeline (`src/pocketaces/`) that produces `data/build/cards.json`, and a
static PWA (`app/`) built from that file. Requirements and design notes live in `specs/`
(`data-collection*.md`, `app-*.md`) — read the relevant plan before non-trivial changes.

## Commands

Data pipeline (Python ≥3.11, uv):

```sh
uv sync --extra browser               # --extra llm for LLM T&C extraction (needs ANTHROPIC_API_KEY)
uv run playwright install chromium    # Moneysmart is behind Cloudflare
uv run pocketaces refresh [--llm]     # full pipeline
uv run pocketaces build               # curated YAML → data/build/cards.json + report.md
uv run pocketaces validate            # check config files and curated records
uv run --group dev pytest             # all tests
uv run --group dev pytest tests/test_curate.py -k <pattern>   # single test
```

Other subcommands: `fetch <source|all>`, `discover [--write]`, `tnc [card_id …] [--llm]`,
`tnc import <card_id> <file> --url <url>`, `reference all`, `curate --all|<card_id>`,
`merchants add|candidates`, `awards log|ranges` (see `src/pocketaces/cli.py`).

App (Node ≥20, run from `app/`):

```sh
npm install
npm run dev        # regenerates public/catalog.json, then Vite on :5173 (service worker off in dev)
npm test           # vitest; single test: npx vitest run -t "bill cycles"
npm run build      # regenerates catalog, tsc -b, vite build → app/dist
npm run preview    # serve dist with the service worker on
npm run dev:api    # Worker (accounts/sync API) on :8787 via wrangler dev; needs .dev.vars (see .dev.vars.example)
npm run deploy     # test + build + wrangler deploy to Cloudflare
```

Pushing to `main` (touching `app/**`, `data/build/cards.json` or `config/categories.yaml`) triggers
`.github/workflows/pages.yml`, which runs `npm test` + `npm run build` and deploys to GitHub Pages
(no accounts there). Cloudflare hosting with accounts: `specs/app-hosting-cloudflare.md`.

## Data pipeline architecture

Flow: `fetch` → `data/raw/<source>/` (snapshots + `manifest.json`) → `data/staging/<source>/<card_id>.json`
→ `curate` → `data/curated/cards/<card_id>.yaml` → `build` → `data/build/`.

Core principles (from `specs/data-collection-plan.md`) that shape the code:

- **Every fact carries a citation.** Each fetch is snapshotted with URL/time/sha256 in `manifest.json`;
  fields in the model carry `sources: [citation_id]` keyed into `Card.citations`.
- **Official T&Cs are truth; aggregators (SingSaver, Moneysmart, Milelion) are for discovery and
  cross-checking.** The build reports disagreements rather than silently picking a value. Exception:
  Milelion reviews (overview table + text, `sources/milelion.py`) are the primary draft source for points
  expiry, miles conversion block/fee and `spend_cycle`; T&C spend-cycle evidence cross-checks it.
- **Machines draft, humans approve.** `curate` overwrites `review.status: draft` files on every run but
  **never overwrites `reviewed` or `stale` records** — for those it writes
  `data/staging/suggestions/<card_id>.yaml` (+ `.diff` against the record) instead — only when the
  machine draft changed versus the baseline in `data/staging/drafts/`. Pending suggestions are listed in
  `report.md`; the user merges by hand and deletes them. A changed T&C hash flips reviewed cards to `stale` unless `review.reviewed_at` is on/after when that change was pulled.
- **Refresh keeps the last good copy on failure** at every stage (fetch, parse, T&C download, build).
  Failed build entries are kept and marked `carried_over`. Preserve this behaviour when editing steps;
  `tests/test_refresh_semantics.py` covers it.
- **Card-specific knowledge lives in YAML, not code.** Adding a card = an entry in `config/cards.yaml`
  (bank, `official.product_page` or `official.tnc_urls`, per-aggregator slugs). Parsers read embedded
  structured data (Next.js flight data, Nuxt `__NUXT_DATA__`, WordPress REST, PDF text), not CSS selectors.
- LLM extraction (`extract/llm.py`) is cross-checked: MCCs not literally present in the source text are
  rejected.

Key modules: `models.py` (pydantic `Card` model, `extra="forbid"`; curated YAML and build output both
validate against it), `paths.py` (all paths relative to repo root, override with `POCKETACES_ROOT`),
`sources/` (one module per source), `extract/` (PDF text, MCC regex extraction, embedded-data parsing,
LLM), `tagging.py` (maps earn rules to spend tags from `config/categories.yaml` → `tag_coverage`).

Git: `data/raw/**` is ignored except `manifest.json` and extracted `*.txt` T&C text. HSBC disallows PDF
fetching via robots.txt — use `pocketaces tnc import`.

## App architecture

Vite + React 19 + TypeScript PWA, local-first: every device keeps its full copy. Optional accounts sync
it end-to-end encrypted through a Cloudflare Worker (design and security model: `specs/app-sync-plan.md`).

- **Catalogue**: `app/scripts/prepare-data.mjs` slims `data/build/cards.json` + `config/categories.yaml`
  into `app/public/catalog.json` (gitignored, generated). If the build schema changes, update this script
  and `src/types.ts` together. `scripts/rule-limits.mjs` reads each earn rule's text: limited-time
  promotional rates are dropped (listed in the card's fine print), and rates limited to named merchants or
  select countries get a `limit` flag, a caution pill, and don't count toward ranking (`headlineRule`).
  A curated `valid_to` / `eligibility.include_merchants` overrides the text.
- **State**: `src/lib/store.tsx` (React context: catalog, `UserState`, reminders, SW update prompt).
  `src/lib/storage.ts` persists to IndexedDB (`idb-keyval`) mirrored to localStorage; `normalise()`
  back-fills fields for older/hand-edited backups — extend it when adding `UserState` fields.
- **Pure logic** in `src/lib/` (`catalog.ts` rates/caps/miles valuation, `dates.ts` bill cycles and spend
  windows, `reminders.ts`, `ics.ts`, `wallet.ts`) is what `logic.test.ts` tests. `reminders.ts` is shared
  by the in-app list, the service worker's Periodic Background Sync (`src/sw.ts`, reads the same IndexedDB
  keys), and the `.ics` calendar export.
- Check-offs roll over by key (bills keyed by statement date, fees by fee date) — there is no reset job.
- `sw.ts` uses `injectManifest`; it has its own `tsconfig.sw.json`. `base: "./"` so the app works under
  a GitHub Pages project path.
- All cards are currently `draft` (unreviewed); the UI badges them and links to sources.
- **Accounts/sync**: `worker/index.ts` (Worker for `/api/*` + `Vault` Durable Object per account, own
  `tsconfig.worker.json`; `wrangler.jsonc` serves `dist/` as static assets). Client: `src/lib/crypto.ts`
  (PBKDF2 → auth key + key-encryption key; AES-GCM data key), `src/lib/merge.ts` (three-way merge
  against the last synced copy), `src/lib/sync.ts` (`SyncEngine`: WebSocket protocol, account record in
  IndexedDB key `account`), UI in `components/AccountPanel.tsx`. The server must never see plaintext
  state or the password. When adding `UserState` fields, check they merge sensibly (arrays of records
  need an `id`), and add per-device fields to `toShared`/`withDevice` in `sync.ts`. `USERNAME_RE` is
  duplicated in `crypto.ts` and the worker. `sync.test.ts` covers crypto and merge.
