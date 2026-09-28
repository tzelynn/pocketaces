# Hosting the app on Cloudflare

The app and its accounts/sync API deploy as one Cloudflare Worker on the **Workers Free plan**: static
assets for the app, plus a SQLite-backed Durable Object per account. How it works and why it's secure:
[app-sync-plan.md](app-sync-plan.md).

All commands run from `app/`.

## 1. One-time setup

1. Create a free Cloudflare account at <https://dash.cloudflare.com/sign-up>.
2. Install and sign in:

   ```sh
   cd app
   npm install
   npx wrangler login          # opens the browser to authorise wrangler
   ```

## 2. First deploy

```sh
npm run deploy                  # npm test → npm run build → wrangler deploy
```

This creates the Worker `pocketaces` (the `name` in `wrangler.jsonc`) with its Durable Object, and
prints its URL, `https://pocketaces.<your-subdomain>.workers.dev`.

Then set the auth pepper, a random secret the server uses to hash login keys:

```sh
openssl rand -base64 48 | npx wrangler secret put AUTH_PEPPER
```

Until it's set, sign-up and sign-in fail with "Server isn't configured". **Don't change or lose
`AUTH_PEPPER` once accounts exist**: every account's login check depends on it, so changing it locks
everyone out. The encrypted data isn't lost, but each user would need a new account and would re-upload
from their devices. Keep a copy in a password manager.

Optional: require a code to create accounts, so strangers can't use your deployment's free quota:

```sh
npx wrangler secret put SIGNUP_CODE      # type any phrase; share it with the people you want to invite
```

Remove it later with `npx wrangler secret delete SIGNUP_CODE`.

## 3. Use it

Open the URL, go to **Settings → Sync across devices**, and create an account. On each other device,
open the same URL (install it with *Add to Home Screen* as before) and sign in. Changes then show up on
the other devices within about a second while they're open. Devices that were offline or closed catch
up when they reconnect.

**Moving from GitHub Pages:** browser storage belongs to one website address, so the Cloudflare URL
starts empty. On the old GitHub Pages site, use **Settings → Download backup**. On the new site, use
**Restore**, then create your account, or sign in and the restored cards will merge into it. After
that, you can turn off the Pages deployment (disable `.github/workflows/pages.yml` or set
**Settings → Pages** to *None*). On Pages the app still works, but without accounts: the sync panel
hides itself there.

## 4. Updates

Run `npm run deploy` again after changing the app or refreshing card data (`pocketaces build`).
Installed apps pick up the new version through **Settings → Check for updates**, as before. Accounts
and data are untouched by deploys.

### Automatic deploys from GitHub (optional)

Workers Builds deploys on every push without storing Cloudflare credentials in GitHub:

1. Dashboard → **Workers & Pages** → `pocketaces` → **Settings → Build** → **Connect** your GitHub repo.
2. Set **Root directory** to `app` and **Build command** to `npm ci && npm test && npm run build`. Leave
   **Deploy command** as `npx wrangler deploy`.
3. Under **Build watch paths**, include `app/*`, `data/build/cards.json` and `config/categories.yaml`
   so data refreshes trigger a deploy. The build reads those files from the repo root, which Workers
   Builds checks out in full.

Secrets set with `wrangler secret put` stay as they are across builds.

## 5. Custom domain (optional, recommended)

If you have a domain on Cloudflare: dashboard → `pocketaces` → **Settings → Domains & Routes → Add →
Custom domain** (e.g. `cards.example.com`). Then, in that domain's zone:

- **SSL/TLS → Edge Certificates → Always Use HTTPS**: on. (The API refuses plain HTTP anyway.)
- **Security → WAF → Rate limiting rules** (the free plan includes one rule): *URI Path starts with
  `/api/`*, *10 requests per 10 seconds* per IP → **Block** for 10 seconds. This adds a per-IP limit on
  top of each account's lock-out after 5 wrong passwords.

Browser data is per address here too, so pick the domain before anyone starts using the app, or move
via backup/restore as above.

## Free-plan limits, in practice

| Limit (per day, resets 00:00 UTC) | What uses it |
|---|---|
| 100,000 Worker requests | `/api/*` calls only: sign-in, a session check per (re)connect, WebSocket upgrades. Static files are free and unmetered. |
| 100,000 Durable Object requests | Each connect is 1. Incoming WebSocket messages count 1 per 20 (a push, a hello, a 25-second ping while the app is open). |
| 100,000 SQLite row writes; 5 GB stored | One or two writes per push. A wallet's encrypted state is typically a few KB (1.5 MB max). |

A household comes nowhere near these. If a limit is ever hit, sync pauses until the daily reset while
each device keeps working offline. Nothing is lost, and changes sync once the quota resets.

## Local development

```sh
cp .dev.vars.example .dev.vars    # local-only secrets (gitignored)
npm run dev:api                   # terminal 1: the Worker + Durable Object on :8787 (wrangler dev)
npm run dev                       # terminal 2: Vite on :5173, proxying /api (incl. WebSockets) to :8787
```

Local accounts live in `app/.wrangler/state` (gitignored). Delete that folder to start over. Use two
browser profiles (or a normal and a private window) to watch sync between "devices". To test the
production build with the service worker, run `npm run build` and open <http://localhost:8787> with
`npm run dev:api` running.

## Operations

- Logs: `npx wrangler tail`, or dashboard → `pocketaces` → **Observability**.
- Nobody, including you as the operator, can read users' wallets. There's no admin reset, and deleting an
  account is done from the app (**Settings → Delete account**).
- To remove the whole deployment: `npx wrangler delete`. This deletes all accounts' synced copies; each
  device keeps its own.
