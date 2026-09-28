// Account sign-in and real-time sync with the Worker in worker/index.ts (see specs/app-sync-plan.md).
//
// The device keeps its full state as before; the server holds one encrypted copy with a version
// number. A push names the version it was based on; if another device got there first, the server
// replies with its copy, which is merged (merge.ts) with this device's changes and pushed again.
// The last copy both agreed on (`base`) is kept here, so offline edits merge on reconnect.
import { del, get, set } from "idb-keyval";
import { emptyState, type UserState } from "../types";
import {
  deriveKeys, MIN_PASSWORD, newDataKey, normaliseUsername, openState, rewrapDataKey, sealState, unwrapDataKey,
  USERNAME_RE, type Sealed,
} from "./crypto";
import { equal, merge3 } from "./merge";
import { normalise } from "./storage";

const ACCOUNT_KEY = "account";
const WS_SIGNED_OUT = 4401;
const PING_MS = 25_000;
const PUSH_DELAY_MS = 400;

/** Persisted in IndexedDB (not the localStorage mirror: CryptoKey objects only survive there). */
interface AccountRecord {
  username: string;
  /** non-extractable AES-GCM key */
  key: CryptoKey;
  /** the data key wrapped with the password key, for password changes */
  wrapped: Sealed;
  /** server version that `base` is */
  version: number;
  /** last state this device and the server agreed on; null before the first sync */
  base: UserState | null;
  /** local changes not yet on the server */
  dirty: boolean;
}

export type SyncPhase = "checking" | "unavailable" | "signed-out" | "connecting" | "syncing" | "synced" | "offline" | "error";

export interface SyncStatus {
  phase: SyncPhase;
  username?: string;
  /** set with "error", or with "signed-out" after the server ended the session */
  message?: string;
  lastSyncedAt?: string;
  /** the server wants a sign-up code */
  signupCode?: boolean;
}

export interface SyncHost {
  /** the current in-memory state */
  getLocal(): UserState;
  /** replace and save the state with a merged copy; must not call `localChanged` back */
  applyRemote(s: UserState): Promise<void>;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly data: Record<string, unknown> = {}) { super(message); }
}

async function api<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`./api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "You're offline.");
  }
  // a static host (e.g. GitHub Pages) answers with an HTML 404 page
  if (!r.headers.get("content-type")?.includes("application/json")) throw new ApiError(-1, "Sync isn't available on this site.");
  const data = await r.json();
  if (!r.ok) {
    const wait = data.retryAfter ? ` (about ${Math.ceil(data.retryAfter / 60)} min)` : "";
    throw new ApiError(r.status, `${data.error ?? `HTTP ${r.status}`}${wait}`, data);
  }
  return data as T;
}

/**
 * The synced part of the state. Notifications stay per device (each device grants its own
 * permission), so they're left out before comparing or pushing; otherwise two devices would keep
 * overwriting each other's setting.
 */
export const toShared = (s: UserState): UserState => ({ ...s, settings: { ...s.settings, notifications: false } });
export const withDevice = (shared: UserState, local: UserState): UserState =>
  ({ ...shared, settings: { ...shared.settings, notifications: local.settings.notifications } });

export function checkCredentials(username: string, password: string, creating: boolean): string | null {
  if (!USERNAME_RE.test(username)) return "Usernames are 3–32 letters, numbers, dots, dashes or underscores.";
  if (creating && password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters for the password.`;
  return null;
}

export class SyncEngine {
  status: SyncStatus = { phase: "checking" };
  private listeners = new Set<(s: SyncStatus) => void>();
  private rec: AccountRecord | null = null;
  private ws: WebSocket | null = null;
  private inflight: UserState | null = null;
  private pushTimer: number | undefined;
  private retryTimer: number | undefined;
  private pingTimer: number | undefined;
  private retries = 0;
  private stopped = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private host: SyncHost) {}

  subscribe(l: (s: SyncStatus) => void) {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  private setStatus(p: Partial<SyncStatus> & { phase: SyncPhase }) {
    this.status = { username: this.rec?.username, signupCode: this.status.signupCode, lastSyncedAt: this.status.lastSyncedAt, ...p };
    this.listeners.forEach((l) => l(this.status));
  }

  /** Runs server messages and pushes one at a time, so version bookkeeping never interleaves. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private save() {
    if (this.rec) set(ACCOUNT_KEY, this.rec).catch((e) => console.warn("couldn't save sync state", e));
  }

  async start() {
    this.stopped = false;
    window.addEventListener("online", this.wake);
    document.addEventListener("visibilitychange", this.wake);
    try {
      this.rec = (await get(ACCOUNT_KEY)) ?? null;
    } catch {
      this.rec = null;
    }
    if (this.stopped) return;
    if (this.rec) this.connect();
    else this.probe();
  }

  stop() {
    this.stopped = true;
    window.removeEventListener("online", this.wake);
    document.removeEventListener("visibilitychange", this.wake);
    this.disconnect();
  }

  /** Signed out: is there a sync server at all, and does it want a sign-up code? */
  private async probe() {
    try {
      const r = await api<{ signupCode?: boolean }>("session");
      this.status.signupCode = !!r.signupCode;
    } catch (e) {
      // offline: show the sign-in form anyway
      if ((e as ApiError).status === -1) return this.setStatus({ phase: "unavailable" });
    }
    if (!this.rec) this.setStatus({ phase: "signed-out" });
  }

  // -- account actions --

  async signUp(username: string, password: string, code?: string) {
    const user = normaliseUsername(username);
    const bad = checkCredentials(user, password, true);
    if (bad) throw new Error(bad);
    const { auth, kek } = await deriveKeys(user, password);
    const { key, wrapped } = await newDataKey(kek, user);
    await api("signup", { username: user, auth, wrapped, code: code || undefined });
    // this device's data becomes the account's first copy
    await this.signedIn({ username: user, key, wrapped, version: 0, base: null, dirty: true });
  }

  async signIn(username: string, password: string) {
    const user = normaliseUsername(username);
    const bad = checkCredentials(user, password, false);
    if (bad) throw new Error(bad);
    const { auth, kek } = await deriveKeys(user, password);
    const r = await api<{ wrapped: Sealed }>("login", { username: user, auth });
    const key = await unwrapDataKey(kek, user, r.wrapped);
    // base null: whatever is on this device is merged into the account on first sync
    await this.signedIn({ username: user, key, wrapped: r.wrapped, version: 0, base: null, dirty: true });
  }

  private async signedIn(rec: AccountRecord) {
    this.rec = rec;
    await set(ACCOUNT_KEY, rec);
    this.connect();
  }

  /** Forget the account on this device. The cards stay unless `wipe`. */
  async signOut(wipe = false) {
    await api("logout", {}).catch(() => {});
    await this.forget();
    if (wipe) await this.host.applyRemote(emptyState());
  }

  private async forget(message?: string) {
    this.disconnect();
    this.rec = null;
    await del(ACCOUNT_KEY).catch(() => {});
    this.setStatus({ phase: "signed-out", username: undefined, message, lastSyncedAt: undefined });
  }

  async changePassword(current: string, next: string) {
    const rec = this.rec;
    if (!rec) throw new Error("Not signed in");
    if (next.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters for the password.`);
    const old = await deriveKeys(rec.username, current);
    const fresh = await deriveKeys(rec.username, next);
    let wrapped: Sealed;
    try {
      wrapped = await rewrapDataKey(old.kek, fresh.kek, rec.username, rec.wrapped);
    } catch {
      throw new Error("Your current password isn't right.");
    }
    await api("password", { auth: old.auth, newAuth: fresh.auth, wrapped });
    rec.wrapped = wrapped;
    this.save();
  }

  /** Deletes the server copy. This device keeps its data. */
  async deleteAccount(password: string) {
    const rec = this.rec;
    if (!rec) throw new Error("Not signed in");
    const { auth } = await deriveKeys(rec.username, password);
    await api("account/delete", { auth });
    await this.forget();
  }

  // -- connection --

  private wake = () => {
    if (document.visibilityState === "hidden" || !this.rec) return;
    // back from the background: ask for anything missed (a sleeping phone may not notice a dead socket)
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "hello", v: this.rec.version }));
      return;
    }
    clearTimeout(this.retryTimer);
    this.retries = 0;
    this.connect();
  };

  private disconnect() {
    clearTimeout(this.retryTimer);
    clearTimeout(this.pushTimer);
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    this.inflight = null;
    if (ws) { ws.onclose = null; ws.close(1000); }
  }

  private retry() {
    if (this.stopped || !this.rec) return;
    clearTimeout(this.retryTimer);
    const delay = Math.min(30_000, 1000 * 2 ** this.retries++) * (0.75 + Math.random() / 2);
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private async connect() {
    if (this.stopped || !this.rec || this.ws) return;
    this.setStatus({ phase: "connecting" });
    // a failed WebSocket upgrade doesn't say why, so check the session over HTTP first
    try {
      const r = await api<{ username: string | null; signupCode?: boolean }>("session");
      if (r.username !== this.rec.username) {
        this.status.signupCode = !!r.signupCode;
        return this.forget("You were signed out on this device. Sign in again to keep syncing.");
      }
    } catch (e) {
      const err = e as ApiError;
      this.setStatus(err.status === 0 ? { phase: "offline" } : { phase: "error", message: err.message });
      return this.retry();
    }
    if (this.stopped || !this.rec || this.ws) return;

    const url = new URL("./api/sync", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      ws.send(JSON.stringify({ t: "hello", v: this.rec?.version ?? 0 }));
      this.pingTimer = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), PING_MS);
    };
    ws.onmessage = (e) => {
      if (e.data === "pong") return;
      this.serial(() => this.onMessage(JSON.parse(e.data))).catch((err) => {
        console.warn("sync failed", err);
        this.setStatus({ phase: "error", message: "Couldn't read the synced data. Try signing out and in again." });
      });
    };
    ws.onclose = (e) => {
      clearInterval(this.pingTimer);
      if (this.ws === ws) { this.ws = null; this.inflight = null; }
      if (e.code === WS_SIGNED_OUT) return void this.forget("You were signed out, possibly because the password was changed on another device.");
      this.setStatus({ phase: navigator.onLine ? "connecting" : "offline" });
      this.retry();
    };
  }

  // -- protocol --

  private async onMessage(m: { t: string; v: number; blob?: Sealed | null; error?: string }) {
    const rec = this.rec;
    if (!rec) return;
    switch (m.t) {
      case "welcome":
        if (m.blob && m.v !== rec.version) return this.receive(m.v, m.blob);
        if (m.blob === null) {
          // the server has no copy yet (new account, or it was reset): ours becomes the copy
          Object.assign(rec, { version: m.v, base: null, dirty: true });
          this.save();
        }
        return this.flush();
      case "state":
        // an update we've already merged (e.g. the reply to a push that raced another device)
        if (m.v <= rec.version) return;
        this.inflight = null;
        return m.blob ? this.receive(m.v, m.blob) : undefined;
      case "ack":
        if (this.inflight) {
          Object.assign(rec, { version: m.v, base: this.inflight });
          rec.dirty = !equal(toShared(this.host.getLocal()), rec.base);
          this.inflight = null;
          this.save();
        }
        return this.flush();
      case "error":
        this.inflight = null;
        this.setStatus({ phase: "error", message: m.error });
    }
  }

  private async receive(version: number, blob: Sealed) {
    const rec = this.rec!;
    const remote = toShared(normalise(await openState(rec.key, rec.username, version, blob)));
    const local = this.host.getLocal();
    const merged = toShared(normalise(merge3(rec.base ?? emptyState(), toShared(local), remote)));
    const next = withDevice(merged, local);
    // state first: a record claiming this version over an older saved state would lose the update
    if (!equal(next, local)) await this.host.applyRemote(next);
    Object.assign(rec, { version, base: remote, dirty: !equal(merged, remote) });
    this.save();
    return this.flush();
  }

  /** Send local changes if there are any and nothing is in flight. */
  private async flush() {
    const rec = this.rec;
    const ws = this.ws;
    if (!rec || !ws || ws.readyState !== WebSocket.OPEN || this.inflight) return;
    const local = toShared(this.host.getLocal());
    if (!rec.dirty || (rec.base && equal(local, rec.base))) {
      if (rec.dirty) { rec.dirty = false; this.save(); }
      return this.setStatus({ phase: "synced", lastSyncedAt: new Date().toISOString() });
    }
    this.setStatus({ phase: "syncing" });
    this.inflight = local;
    const blob = await sealState(rec.key, rec.username, rec.version + 1, local);
    ws.send(JSON.stringify({ t: "push", base: rec.version, blob }));
  }

  /** Called after every local edit. */
  localChanged() {
    const rec = this.rec;
    if (!rec) return;
    if (!rec.dirty) { rec.dirty = true; this.save(); }
    clearTimeout(this.pushTimer);
    this.pushTimer = window.setTimeout(() => { this.serial(() => this.flush()).catch(() => {}); }, PUSH_DELAY_MS);
  }
}
