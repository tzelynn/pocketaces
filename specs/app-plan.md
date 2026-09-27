# pocket-aces app — implementation plan

Companion to [app-functionalities.md](app-functionalities.md). Describes how the app is built, and why.

## Shape

- **Installable PWA** in `app/` (Vite + React + TypeScript, `vite-plugin-pwa`). One codebase serves the
  website and the Android/iOS "Add to Home Screen" app; no app-store builds.
- **Static hosting** (GitHub Pages via `.github/workflows/pages.yml`). No backend, so no accounts and no
  server-side copy of anyone's card data.
- **Data in**: `app/scripts/prepare-data.mjs` slims `data/build/cards.json` and `config/categories.yaml`
  into `app/public/catalog.json` at build time. The pipeline stays the single source of truth.

## Pages

| Page | Covers |
|---|---|
| Cards | Catalogue: filter by reward type / min spend / spend category, sort by reward value / spend cap / min spend, star to add to *My cards* (pinned and highlighted at top), per-card notes (column on desktop, detail sheet on phone) |
| Wallet | My cards: bill issue/due dates with a paid check-off per statement, annual fee date with waived/paid check-off per year, manual spend log with min-spend and cap progress, "use next" guidance |
| Settings | Update button, install hint, reminders, reward valuation, backup/restore |

## Key decisions

- **Comparing miles with cashback**: miles are valued at a user-set cents per mile (default 1.5¢) to
  get an effective %. Points have no conversion data in the build yet, so they are shown in their own
  unit and sorted after valued cards, not guessed.
- **Headline rate per category**: with a spend category selected, the rate shown is the best rule that
  covers it (`tag_coverage`), otherwise the best bonus rule.
- **Spend cap** is expressed as S$ of spend: `max_spend`, or `bonus_cap` divided by the rate
  (e.g. S$60 cashback cap at 8% → S$750 spend). Uncapped sorts first.
- **Check-offs roll over by keying**: bills are keyed by statement date and fees by fee date, so each
  new month/year starts unchecked with no reset job.
- **Due date without a statement day**: the statement is estimated as 21 days before the due day and
  labelled as an estimate.
- **Reminders** (1 week before an unpaid bill is due; fee reminders from 7 days before the fee date
  until 30 days after it or until checked off) are computed by one pure module (`src/lib/reminders.ts`)
  used in three places:
  1. in-app "Heads up" list and a system notification whenever the app is opened or refocused;
  2. the service worker's Periodic Background Sync (installed PWA on Chromium/Android) for
     notifications without opening the app;
  3. calendar export (`.ics` with alarms), which covers iOS and any device where background web
     notifications aren't available. Calendar alarms can't know a bill was paid, which the UI says.
- **Storage**: IndexedDB (primary) mirrored to localStorage, `navigator.storage.persist()` requested,
  and JSON backup export/import. Losing browser data is the main risk for a server-less app, so the
  app nudges for a backup when the last one is older than 30 days.
- **Updates**: the service worker precaches the app and catalogue. The update button checks for a
  newer deployment and reloads into it. The same prompt appears automatically when one is found.
- **Data honesty**: every card in the build is still `draft` (unreviewed), so the UI badges unreviewed
  cards and links to the sources.

## Data pipeline change made for the app

`curate` previously dropped the aggregators' card-level `min_monthly_spend`, so every card was tagged
`no_min_spend`. Drafts now carry it onto bonus rules (`statement_month`, with a "confirm the period"
condition for review).
