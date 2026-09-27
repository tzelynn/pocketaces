// Device storage: IndexedDB is the primary copy, mirrored to localStorage so either one alone is
// enough to recover. The service worker reads the same IndexedDB keys (see sw.ts).
import { get, set } from "idb-keyval";
import { emptyState, DEFAULT_SETTINGS, type UserState } from "../types";

export const STATE_KEY = "state";
/** Reminder keys already notified → ISO timestamp. Separate key so the SW never clobbers state. */
export const NOTIFIED_KEY = "notified";
const LS_KEY = "pocketaces:state";

export function normalise(raw: unknown): UserState {
  const s = raw as Partial<UserState> | null;
  if (!s || typeof s !== "object" || !Array.isArray(s.myCards)) throw new Error("not a pocket aces backup");
  return {
    ...emptyState(),
    ...s,
    version: 1,
    notes: s.notes ?? {},
    settings: { ...DEFAULT_SETTINGS, ...s.settings },
    // fill fields a hand-edited or older backup may lack
    myCards: s.myCards.map((c) => ({
      ...c,
      spends: c.spends ?? [],
      bills: c.bills ?? {},
      fees: c.fees ?? {},
    })),
  };
}

export async function loadState(): Promise<UserState> {
  try {
    const s = await get(STATE_KEY);
    if (s) return normalise(s);
  } catch (e) {
    console.warn("IndexedDB read failed, trying localStorage", e);
  }
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return normalise(JSON.parse(raw));
  } catch (e) {
    console.warn("localStorage read failed", e);
  }
  return emptyState();
}

export async function saveState(state: UserState): Promise<void> {
  let saved = false;
  try {
    await set(STATE_KEY, state);
    saved = true;
  } catch (e) {
    console.warn("IndexedDB write failed", e);
  }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    saved = true;
  } catch (e) {
    console.warn("localStorage write failed", e);
  }
  if (!saved) throw new Error("Couldn't save on this device");
}

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function isPersisted(): Promise<boolean> {
  try {
    return (await navigator.storage?.persisted?.()) ?? false;
  } catch {
    return false;
  }
}

export function backupBlob(state: UserState): Blob {
  const payload = { app: "pocket-aces", exportedAt: new Date().toISOString(), state };
  return new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
}

export function parseBackup(text: string): UserState {
  const parsed = JSON.parse(text);
  return normalise(parsed?.app === "pocket-aces" ? parsed.state : parsed);
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
