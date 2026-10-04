# pocket-aces app — accounts and sync

Companion to [app-plan.md](app-plan.md). Accounts let one person's wallet (cards, notes, bill/fee
check-offs, spend logs, settings) follow them across devices, updating live. Hosting steps are in
[app-hosting-cloudflare.md](app-hosting-cloudflare.md).

## Shape

- **One Cloudflare Worker** (`app/worker/index.ts`, config `app/wrangler.jsonc`) serves the built app
  as static assets and handles `/api/*`. Only `/api/*` runs Worker code (`run_worker_first`), so static
  requests don't count towards the free plan's Worker request quota.
- **One Durable Object per account** (`Vault`, SQLite-backed, the kind on the Workers Free plan),
  addressed by `idFromName(username)`. It holds the account row, sessions and the encrypted state, and
  relays updates between that account's open WebSockets. There's no D1 database: real-time push needs a
  Durable Object anyway, and keeping each account in its own object means no shared table to leak.
- The app is still **local-first**. Each device keeps its full copy in IndexedDB as before and works
  offline; sync is an optional layer (`src/lib/sync.ts`). On a static host (GitHub Pages) `/api` is
  missing, so the account panel hides itself.

## Security model

Why not rely on the database's own encryption: D1 and Durable Object storage are encrypted at rest,
but Cloudflare holds those keys, and anyone with access to the Cloudflare account (or a leaked API
token) can read the data in plain text. So the app encrypts on the device, and the server only ever
stores ciphertext. That makes the free storage fine to use.

**Keys** (`src/lib/crypto.ts`):

1. `PBKDF2-SHA256(password, salt = SHA-256("pocketaces/v1/" + username), 600 000 rounds)` → master secret.
   The salt is unique per user and needs no round trip before login.
2. HKDF splits the master secret into `auth` (sent to the server as the login secret) and `kek` (never
   leaves the device). You can't derive one from the other.
3. A random 256-bit **data key** encrypts the state (gzip, then AES-256-GCM, with username + version as
   associated data so the server can't swap in another account's blob or relabel an old version).
   The server stores the data key wrapped with `kek`. A password change re-wraps the same key, so the data
   doesn't need re-encrypting.
4. On the device the data key is kept in IndexedDB as a **non-extractable** `CryptoKey`: page scripts
   can use it but can't read it out.

**Server side** (`worker/index.ts`):

- It stores `HMAC-SHA256(AUTH_PEPPER, auth)` (the pepper is a Worker secret), compared in constant time.
  `auth` is already a 256-bit key, so a fast keyed hash is enough; the slow part is the client's PBKDF2.
- Sessions: 32 random bytes in an `HttpOnly; Secure; SameSite=Strict` cookie with the `__Host-` prefix
  (the page's JavaScript can't read it). Only the token's SHA-256 is stored. They last 90 days, and each
  reconnect extends them. There are at most 20 per account.
- Every POST and the WebSocket upgrade must carry a same-origin `Origin` header (blocks CSRF and
  cross-site WebSocket hijacking). HTTP is refused except on localhost.
- Lock-out: after 5 wrong passwords an account waits 1, 2, 4 … minutes (max 60) between tries. This
  applies to login, password change and account deletion, and the right password is refused too during
  a wait. Unknown usernames get the same error as wrong passwords. Accounts are created only on sign-up,
  so logins with made-up names store nothing.
- Optional `SIGNUP_CODE` secret: if set, a code is needed to create an account (for a personal or
  family deployment).
- Password change signs out every other device (their sockets close with code 4401). Account deletion
  wipes the Durable Object.
- Static files get a strict CSP and related headers from `app/public/_headers`.

**Limits of this model** (stated in the UI where it matters):

- **A forgotten password can't be recovered.** Devices keep their local copy, and a backup file or a new
  account restores sync.
- If someone gets a copy of the stored data, they can try passwords offline against the wrapped key.
  The pepper doesn't help against that. What slows them down is the 600k PBKDF2 rounds per guess, so the
  UI asks for 10+ characters and a password used nowhere else.
- As with any web app that encrypts in the browser, whoever controls the deployed code could ship a
  version that captures passwords. Self-hosting from this repo is the guard.
- The server sees usernames, when and how often a device syncs, blob sizes, coarse device labels
  (e.g. "iOS Safari"), and IPs in Cloudflare logs. Usernames can be probed through sign-up.
- The device copy in IndexedDB is plain text, as it was before accounts.

## Sync protocol

JSON text frames over `wss://…/api/sync` (the session cookie authenticates the upgrade):

| client → server | server → client |
|---|---|
| `hello {v}` on connect and when the app returns to the foreground | `welcome {v}`, plus `blob` (or `null` if the account has no copy yet) when `v` differs |
| `push {base, blob}` (blob sealed for version `base+1`) | `ack {v}`; the account's other sockets get `state {v, blob}` |
| | `state {v, blob}` instead of `ack` when `base` is stale |
| `ping` (every 25 s) | `pong`, answered by the runtime without waking the object |

The Durable Object uses the WebSocket Hibernation API, so idle connections cost no duration. Incoming
messages bill at 20:1, which keeps a single user far below the free limits.

Client state (`account` key in IndexedDB): username, data key, wrapped key, `version`, `base` (the last
copy this device and the server agreed on) and `dirty`. Local edits set `dirty` and push after 400 ms,
with one push in flight at a time. When a newer copy arrives the client merges it into the local state,
**saves the state, then saves the record**. The other order could leave a device believing it's up to
date while holding older data. Settings → notifications stays per device and is left out of the synced
copy.

**Merging** (`src/lib/merge.ts`) is a three-way merge against `base`. Objects merge key by key, and
arrays of `{id}` records (cards, spend entries) merge record by record. So edits to different cards,
spends, bills, fees or notes on two devices all survive, including offline ones. If both devices changed
the same field, the one that syncs second wins. A deletion wins over a concurrent edit of the same
record. First sign-in on a device with its own cards merges them into the account (base = empty state),
so nothing is lost. The same catalogue card added separately on two devices shows up twice, and can be
removed by hand.

Reconnects back off exponentially (1–30 s) and are also triggered by `online` and returning to the
foreground. Before each reconnect the client checks `GET /api/session` over HTTP, because a rejected
WebSocket upgrade doesn't say why.
