// Accounts and real-time sync API (Cloudflare Worker + one Durable Object per account).
// Static files are served by Workers static assets; only /api/* reaches this code (wrangler.jsonc).
//
// The server never sees a password or a readable copy of anyone's data: clients send a key derived
// from the password (`auth`) and state encrypted on the device. See specs/app-sync-plan.md.
import { DurableObject } from "cloudflare:workers";

interface Env {
  VAULT: DurableObjectNamespace<Vault>;
  /** secret: HMAC key for stored auth hashes, so a copied database alone can't be checked offline */
  AUTH_PEPPER: string;
  /** optional secret: when set, creating an account needs this code */
  SIGNUP_CODE?: string;
  /** optional, comma-separated: extra origins allowed to call the API (local dev) */
  ALLOWED_ORIGINS?: string;
}

interface Sealed { iv: string; ct: string }

// Keep in sync with src/lib/crypto.ts.
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const AUTH_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url
const SESSION_TTL = 90 * 86_400_000;
const MAX_SESSIONS = 20;
/** DO SQLite values max out at 2 MB; the state is gzipped before encryption, so this is plenty. */
const MAX_BLOB = 1_500_000;
const MAX_JSON_BODY = 16_384;
const FREE_FAILURES = 5;
/** Close code telling the client its session is gone (signed out or password changed elsewhere). */
const WS_SIGNED_OUT = 4401;

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });

const isLocal = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function authHash(env: Env, auth: string): Promise<string> {
  if (!env.AUTH_PEPPER || env.AUTH_PEPPER.length < 32) throw new HttpError(500, "Server isn't configured (AUTH_PEPPER)");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.AUTH_PEPPER), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(auth)));
}

function sameHash(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  return ea.byteLength === eb.byteLength && crypto.subtle.timingSafeEqual(ea, eb);
}

// -- request parsing --------------------------------------------------------------------------------

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_JSON_BODY) throw new HttpError(413, "Request too large");
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch { /* fall through */ }
  throw new HttpError(400, "Expected a JSON object");
}

function username(v: unknown): string {
  if (typeof v !== "string" || !USERNAME_RE.test(v)) throw new HttpError(400, "Invalid username");
  return v;
}

function authKey(v: unknown): string {
  if (typeof v !== "string" || !AUTH_RE.test(v)) throw new HttpError(400, "Invalid credentials");
  return v;
}

function sealed(v: unknown, max: number): Sealed {
  const s = v as Sealed | null;
  if (!s || typeof s.iv !== "string" || typeof s.ct !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(s.iv)
    || !/^[A-Za-z0-9_-]+$/.test(s.ct) || s.ct.length > max) throw new HttpError(400, "Invalid encrypted data");
  return { iv: s.iv, ct: s.ct };
}

// -- session cookie -----------------------------------------------------------------------------------

// `__Host-` pins the cookie to this exact host over HTTPS. Plain-HTTP localhost (wrangler dev) can't
// use the prefix, so it gets an unprefixed name.
const cookieName = (url: URL) => (url.protocol === "https:" ? "__Host-pa_session" : "pa_session");

function sessionCookie(url: URL, value: string, maxAgeMs: number): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${cookieName(url)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
}

interface Session { username: string; token: string }

function readSession(req: Request, url: URL): Session | null {
  const name = cookieName(url);
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, v] = part.trim().split("=", 2);
    if (k !== name || !v) continue;
    const dot = v.lastIndexOf(".");
    const user = v.slice(0, dot);
    const token = v.slice(dot + 1);
    if (dot > 0 && USERNAME_RE.test(user) && /^[A-Za-z0-9_-]{43}$/.test(token)) return { username: user, token };
  }
  return null;
}

function requireSession(req: Request, url: URL): Session {
  const s = readSession(req, url);
  if (!s) throw new HttpError(401, "Not signed in");
  return s;
}

// -- worker -------------------------------------------------------------------------------------------

const vault = (env: Env, user: string) => env.VAULT.get(env.VAULT.idFromName(user));

/** Blocks cross-site requests (CSRF, cross-site WebSocket hijacking) on top of SameSite=Strict. */
function checkOrigin(req: Request, url: URL, env: Env) {
  const origin = req.headers.get("origin");
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!origin || (origin !== url.origin && !allowed.includes(origin))) throw new HttpError(403, "Cross-origin request refused");
}

async function handle(req: Request, env: Env, url: URL): Promise<Response> {
  if (url.protocol !== "https:" && !isLocal(url.hostname)) throw new HttpError(400, "HTTPS required");
  const route = `${req.method} ${url.pathname}`;
  const upgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
  if (req.method !== "GET" || upgrade) checkOrigin(req, url, env);

  switch (route) {
    case "GET /api/session": {
      const s = readSession(req, url);
      const signup = { signupCode: !!env.SIGNUP_CODE };
      if (!s) return json({ username: null, ...signup });
      const r = await vault(env, s.username).touch(await sha256(s.token));
      if (!r) return json({ username: null, ...signup }, 200, { "set-cookie": sessionCookie(url, "", 0) });
      // sliding expiry: the client checks the session before every (re)connect
      return json({ username: s.username }, 200, { "set-cookie": sessionCookie(url, `${s.username}.${s.token}`, SESSION_TTL) });
    }

    case "GET /api/sync": {
      if (!upgrade) throw new HttpError(426, "Expected a WebSocket upgrade");
      const s = requireSession(req, url);
      const headers = new Headers(req.headers);
      headers.set("x-pa-session", await sha256(s.token));
      return vault(env, s.username).fetch(new Request(req, { headers }));
    }

    case "POST /api/signup": {
      const b = await body(req);
      if (env.SIGNUP_CODE && (typeof b.code !== "string" || !sameHash(await sha256(b.code), await sha256(env.SIGNUP_CODE)))) {
        throw new HttpError(403, "That sign-up code isn't right");
      }
      const user = username(b.username);
      const r = await vault(env, user).signup(user, await authHash(env, authKey(b.auth)), sealed(b.wrapped, 200), label(req));
      if ("error" in r) throw new HttpError(409, r.error);
      return json({ username: user }, 200, { "set-cookie": sessionCookie(url, `${user}.${r.token}`, SESSION_TTL) });
    }

    case "POST /api/login": {
      const b = await body(req);
      const user = username(b.username);
      const r = await vault(env, user).login(await authHash(env, authKey(b.auth)), label(req));
      if ("error" in r) throw new HttpError(r.retryAfter ? 429 : 401, r.error, r.retryAfter ? { retryAfter: r.retryAfter } : {});
      return json({ username: user, wrapped: r.wrapped }, 200, { "set-cookie": sessionCookie(url, `${user}.${r.token}`, SESSION_TTL) });
    }

    case "POST /api/logout": {
      const s = readSession(req, url);
      if (s) await vault(env, s.username).logout(await sha256(s.token));
      return json({ ok: true }, 200, { "set-cookie": sessionCookie(url, "", 0) });
    }

    case "POST /api/password": {
      const s = requireSession(req, url);
      const b = await body(req);
      const r = await vault(env, s.username).changePassword(
        await sha256(s.token), await authHash(env, authKey(b.auth)), await authHash(env, authKey(b.newAuth)), sealed(b.wrapped, 200),
      );
      if ("error" in r) throw new HttpError(r.retryAfter ? 429 : 401, r.error, r.retryAfter ? { retryAfter: r.retryAfter } : {});
      return json({ ok: true });
    }

    case "POST /api/account/delete": {
      const s = requireSession(req, url);
      const b = await body(req);
      const r = await vault(env, s.username).deleteAccount(await sha256(s.token), await authHash(env, authKey(b.auth)));
      if ("error" in r) throw new HttpError(r.retryAfter ? 429 : 401, r.error, r.retryAfter ? { retryAfter: r.retryAfter } : {});
      return json({ ok: true }, 200, { "set-cookie": sessionCookie(url, "", 0) });
    }
  }
  throw new HttpError(404, "Not found");
}

/** A rough device label for the sessions table, e.g. "iPhone Safari". */
function label(req: Request): string {
  const ua = req.headers.get("user-agent") ?? "";
  const os = /iphone|ipad/i.test(ua) ? "iOS" : /android/i.test(ua) ? "Android" : /mac os/i.test(ua) ? "Mac" : /windows/i.test(ua) ? "Windows" : /linux/i.test(ua) ? "Linux" : "";
  const br = /edg\//i.test(ua) ? "Edge" : /firefox\//i.test(ua) ? "Firefox" : /chrome\//i.test(ua) ? "Chrome" : /safari\//i.test(ua) ? "Safari" : "";
  return `${os} ${br}`.trim() || "Unknown device";
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    try {
      return await handle(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
      console.error(e);
      return json({ error: "Server error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

// -- one Durable Object per account -------------------------------------------------------------------

type Fail = { error: string; retryAfter?: number };

interface AccountRow extends Record<string, SqlStorageValue> {
  auth_hash: string;
  wrapped: string;
  failures: number;
  locked_until: number;
}

/**
 * Holds one account: its auth hash, wrapped data key, sessions and the encrypted state, and relays
 * updates between the account's open WebSockets. Hibernation keeps idle sockets free of duration
 * charges; "ping" is answered by the runtime without waking the object.
 */
export class Vault extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Tables are created only on sign-up, so logins for unknown names leave nothing stored. */
  private exists(): boolean {
    return this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'account'").toArray().length > 0;
  }

  private account(): AccountRow | null {
    if (!this.exists()) return null;
    return this.sql.exec<AccountRow>("SELECT auth_hash, wrapped, failures, locked_until FROM account WHERE id = 1").toArray()[0] ?? null;
  }

  /** The cookie holds the token; only its hash is stored. Keeps the newest MAX_SESSIONS. */
  private async newSession(label: string): Promise<string> {
    const now = Date.now();
    this.sql.exec("DELETE FROM sessions WHERE expires_at < ?", now);
    this.sql.exec(
      "DELETE FROM sessions WHERE hash IN (SELECT hash FROM sessions ORDER BY created_at DESC LIMIT -1 OFFSET ?)",
      MAX_SESSIONS - 1,
    );
    const token = randomToken();
    this.sql.exec("INSERT INTO sessions (hash, created_at, expires_at, label) VALUES (?, ?, ?, ?)", await sha256(token), now, now + SESSION_TTL, label);
    return token;
  }

  private validSession(hash: string): boolean {
    if (!this.exists()) return false;
    return this.sql.exec("SELECT 1 FROM sessions WHERE hash = ? AND expires_at > ?", hash, Date.now()).toArray().length > 0;
  }

  /** Checks the password key, with a growing lock-out after repeated failures. */
  private verify(acct: AccountRow, hash: string): Fail | null {
    const now = Date.now();
    if (acct.locked_until > now) {
      return { error: "Too many attempts. Try again later.", retryAfter: Math.ceil((acct.locked_until - now) / 1000) };
    }
    if (sameHash(hash, acct.auth_hash)) {
      if (acct.failures) this.sql.exec("UPDATE account SET failures = 0, locked_until = 0 WHERE id = 1");
      return null;
    }
    const failures = acct.failures + 1;
    // 5 free tries, then 1, 2, 4 … minutes, up to an hour
    const lock = failures >= FREE_FAILURES ? now + Math.min(60, 2 ** (failures - FREE_FAILURES)) * 60_000 : 0;
    this.sql.exec("UPDATE account SET failures = ?, locked_until = ? WHERE id = 1", failures, lock);
    return { error: "Wrong username or password" };
  }

  private closeSockets(keep?: string) {
    for (const ws of this.ctx.getWebSockets()) {
      if (keep && this.ctx.getTags(ws).includes(keep)) continue;
      try { ws.close(WS_SIGNED_OUT, "Signed out"); } catch { /* already closed */ }
    }
  }

  // -- RPC from the worker --

  async signup(user: string, hash: string, wrapped: Sealed, label: string): Promise<{ token: string } | Fail> {
    if (this.account()) return { error: "That username is taken" };
    this.sql.exec(`CREATE TABLE IF NOT EXISTS account (
      id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL, auth_hash TEXT NOT NULL, wrapped TEXT NOT NULL,
      created_at INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, label TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS state (
      id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, blob TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    this.sql.exec("INSERT INTO account (id, username, auth_hash, wrapped, created_at) VALUES (1, ?, ?, ?, ?)", user, hash, JSON.stringify(wrapped), Date.now());
    return { token: await this.newSession(label) };
  }

  async login(hash: string, label: string): Promise<{ token: string; wrapped: Sealed } | Fail> {
    const acct = this.account();
    if (!acct) return { error: "Wrong username or password" };
    const fail = this.verify(acct, hash);
    if (fail) return fail;
    return { token: await this.newSession(label), wrapped: JSON.parse(acct.wrapped) };
  }

  /** Is the session live? Extends it if so. */
  async touch(sessionHash: string): Promise<boolean> {
    if (!this.validSession(sessionHash)) return false;
    this.sql.exec("UPDATE sessions SET expires_at = ? WHERE hash = ?", Date.now() + SESSION_TTL, sessionHash);
    return true;
  }

  async logout(sessionHash: string): Promise<void> {
    if (!this.exists()) return;
    this.sql.exec("DELETE FROM sessions WHERE hash = ?", sessionHash);
    for (const ws of this.ctx.getWebSockets(sessionHash)) {
      try { ws.close(WS_SIGNED_OUT, "Signed out"); } catch { /* already closed */ }
    }
  }

  /** Re-keys the login and signs out every other device. */
  async changePassword(sessionHash: string, hash: string, newHash: string, wrapped: Sealed): Promise<{ ok: true } | Fail> {
    const acct = this.account();
    if (!acct || !this.validSession(sessionHash)) return { error: "Not signed in" };
    const fail = this.verify(acct, hash);
    if (fail) return fail;
    this.sql.exec("UPDATE account SET auth_hash = ?, wrapped = ? WHERE id = 1", newHash, JSON.stringify(wrapped));
    this.sql.exec("DELETE FROM sessions WHERE hash != ?", sessionHash);
    this.closeSockets(sessionHash);
    return { ok: true };
  }

  async deleteAccount(sessionHash: string, hash: string): Promise<{ ok: true } | Fail> {
    const acct = this.account();
    if (!acct || !this.validSession(sessionHash)) return { error: "Not signed in" };
    const fail = this.verify(acct, hash);
    if (fail) return fail;
    this.closeSockets();
    await this.ctx.storage.deleteAll();
    return { ok: true };
  }

  // -- WebSocket sync --

  async fetch(req: Request): Promise<Response> {
    const hash = req.headers.get("x-pa-session") ?? "";
    if (!this.validSession(hash)) return new Response("Not signed in", { status: 401 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [hash]);
    return new Response(null, { status: 101, webSocket: client });
  }

  private current(): { version: number; blob: string | null } {
    const row = this.sql.exec<{ version: number; blob: string }>("SELECT version, blob FROM state WHERE id = 1").toArray()[0];
    return row ? { version: row.version, blob: row.blob } : { version: 0, blob: null };
  }

  /**
   * Protocol (JSON text frames):
   *   → hello {v}          ← welcome {v, blob?}   blob (or null for none) only when v differs
   *   → push {base, blob}  ← ack {v}              and state {v, blob} to the account's other sockets
   *                        ← state {v, blob}      if base is stale: merge and push again
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const [hash] = this.ctx.getTags(ws);
    if (!hash || !this.validSession(hash)) return ws.close(WS_SIGNED_OUT, "Signed out");
    if (typeof message !== "string" || message.length > MAX_BLOB + 1000) return ws.close(1009, "Message too large");

    let msg: { t?: string; v?: unknown; base?: unknown; blob?: unknown };
    try { msg = JSON.parse(message); } catch { return ws.close(1003, "Bad message"); }
    const cur = this.current();
    const send = (w: WebSocket, m: unknown) => { try { w.send(JSON.stringify(m)); } catch { /* closing */ } };

    if (msg.t === "hello") {
      send(ws, msg.v === cur.version
        ? { t: "welcome", v: cur.version }
        : { t: "welcome", v: cur.version, blob: cur.blob && JSON.parse(cur.blob) });
    } else if (msg.t === "push") {
      let blob: Sealed;
      try { blob = sealed(msg.blob, MAX_BLOB); } catch { return send(ws, { t: "error", error: "Invalid or oversized data" }); }
      if (msg.base !== cur.version) return send(ws, { t: "state", v: cur.version, blob: cur.blob && JSON.parse(cur.blob) });
      const v = cur.version + 1;
      this.sql.exec(
        "INSERT INTO state (id, version, blob, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, blob = excluded.blob, updated_at = excluded.updated_at",
        v, JSON.stringify(blob), Date.now(),
      );
      send(ws, { t: "ack", v });
      for (const other of this.ctx.getWebSockets()) if (other !== ws) send(other, { t: "state", v, blob });
    } else {
      send(ws, { t: "error", error: "Unknown message" });
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "Closing"); } catch { /* already closed */ }
  }
}
