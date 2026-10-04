import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { get, set } from "idb-keyval";
import { registerSW } from "virtual:pwa-register";
import type { Catalog, CatalogCard, UserState } from "../types";
import { today } from "./dates";
import { REMINDER_SYNC_TAG, remindersFor, unnotified, type Reminder } from "./reminders";
import { loadState, NOTIFIED_KEY, requestPersistence, saveState } from "./storage";
import { SyncEngine, type SyncStatus } from "./sync";

interface Store {
  catalog: Catalog | null;
  catalogError: string | null;
  byId: Map<string, CatalogCard>;
  state: UserState | null;
  update: (fn: (s: UserState) => UserState) => void;
  replace: (s: UserState) => void;
  saveError: string | null;
  reminders: Reminder[];
  on: string;
  /** null until the local state has loaded */
  sync: SyncEngine | null;
}

const Ctx = createContext<Store | null>(null);

export const useStore = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside provider");
  return s;
};

/** `state` is loaded before children render, so pages can rely on it. */
export const useUser = () => {
  const s = useStore();
  return { ...s, state: s.state! };
};

export function StoreProvider({ children }: { children: ReactNode }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [state, setState] = useState<UserState | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [on, setOn] = useState(today);
  const saveTimer = useRef<number | undefined>(undefined);
  // the latest state, updated synchronously so the sync engine never merges into a stale copy
  const stateRef = useRef<UserState | null>(null);
  const [sync, setSync] = useState<SyncEngine | null>(null);

  useEffect(() => {
    fetch("./catalog.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setCatalog)
      .catch((e) => setCatalogError(String(e)));
    loadState().then((s) => { stateRef.current = s; setState(s); });
  }, []);

  // keep "today" current for an app left open overnight or resumed from the background
  useEffect(() => {
    const tick = () => setOn(today());
    const id = window.setInterval(tick, 60 * 60 * 1000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, []);

  const syncRef = useRef<SyncEngine | null>(null);

  const persist = useCallback((s: UserState) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveState(s).then(() => setSaveError(null), (e) => setSaveError(String(e.message ?? e)));
    }, 250);
  }, []);

  const commit = useCallback((next: UserState) => {
    stateRef.current = next;
    setState(next);
    persist(next);
    syncRef.current?.localChanged();
  }, [persist]);

  /** Synced changes are saved straight away: the engine records the new version only after this. */
  const applyRemote = useCallback(async (next: UserState) => {
    stateRef.current = next;
    setState(next);
    clearTimeout(saveTimer.current);
    await saveState(next).then(() => setSaveError(null), (e) => setSaveError(String(e.message ?? e)));
  }, []);

  const update = useCallback((fn: (s: UserState) => UserState) => {
    if (stateRef.current) commit(fn(stateRef.current));
  }, [commit]);

  const replace = useCallback((s: UserState) => commit(s), [commit]);

  // accounts: start syncing once the device copy is loaded
  const loaded = state !== null;
  useEffect(() => {
    if (!loaded) return;
    const engine = new SyncEngine({
      getLocal: () => stateRef.current!,
      applyRemote,
    });
    syncRef.current = engine;
    setSync(engine);
    engine.start();
    return () => { engine.stop(); syncRef.current = null; };
  }, [loaded, applyRemote]);

  // flush a pending save when the page is hidden (app switched away / closed / reloaded)
  useEffect(() => {
    const flush = (e: Event) => {
      if ((e.type === "pagehide" || document.visibilityState === "hidden") && state) { clearTimeout(saveTimer.current); saveState(state).catch(() => {}); }
    };
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", flush);
    return () => { document.removeEventListener("visibilitychange", flush); window.removeEventListener("pagehide", flush); };
  }, [state]);

  // once there's something worth keeping, ask the browser not to evict it
  const hasData = !!state && (state.myCards.length > 0 || Object.keys(state.notes).length > 0);
  useEffect(() => { if (hasData) requestPersistence(); }, [hasData]);

  const reminders = useMemo(
    () => (state ? remindersFor(state.myCards, state.settings, on) : []),
    [state, on],
  );

  // system notifications while the app is open or resumed
  const notifyOn = state?.settings.notifications;
  useEffect(() => {
    if (!notifyOn || !reminders.length || !("Notification" in window) || Notification.permission !== "granted") return;
    (async () => {
      const { fresh, notified } = unnotified(reminders, (await get(NOTIFIED_KEY)) ?? {});
      if (!fresh.length) return;
      await set(NOTIFIED_KEY, notified);
      const reg = await navigator.serviceWorker?.ready;
      for (const r of fresh) {
        const opts = { body: r.body, tag: r.key, icon: "icons/icon-192.png", data: { url: "./#wallet" } };
        if (reg) await reg.showNotification(r.title, opts);
        else new Notification(r.title, opts);
      }
    })().catch((e) => console.warn("notification failed", e));
  }, [reminders, notifyOn]);

  const byId = useMemo(() => new Map((catalog?.cards ?? []).map((c) => [c.id, c])), [catalog]);

  const value = useMemo(
    () => ({ catalog, catalogError, byId, state, update, replace, saveError, reminders, on, sync }),
    [catalog, catalogError, byId, state, update, replace, saveError, reminders, on, sync],
  );
  return <Ctx.Provider value={value}>{state ? children : null}</Ctx.Provider>;
}

/** Sync status, re-rendering on every change. */
export function useSync(): { engine: SyncEngine | null; status: SyncStatus } {
  const { sync } = useStore();
  const [status, setStatus] = useState<SyncStatus>(sync?.status ?? { phase: "checking" });
  useEffect(() => {
    if (!sync) return;
    setStatus(sync.status);
    return sync.subscribe(setStatus);
  }, [sync]);
  return { engine: sync, status };
}

// -- notifications -----------------------------------------------------------------------------

export async function enableNotifications(): Promise<{ ok: boolean; background: boolean; reason?: string }> {
  if (!("Notification" in window)) return { ok: false, background: false, reason: "This browser can't show notifications." };
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, background: false, reason: "Notifications are blocked for this site." };
  return { ok: true, background: await registerPeriodicSync() };
}

/** Background checks via Periodic Background Sync (Chromium, installed app only). */
export async function registerPeriodicSync(): Promise<boolean> {
  try {
    const reg = (await navigator.serviceWorker?.ready) as ServiceWorkerRegistration & {
      periodicSync?: { register(tag: string, o: { minInterval: number }): Promise<void> };
    };
    if (!reg?.periodicSync) return false;
    const status = await navigator.permissions.query({ name: "periodic-background-sync" as PermissionName });
    if (status.state !== "granted") return false;
    await reg.periodicSync.register(REMINDER_SYNC_TAG, { minInterval: 12 * 60 * 60 * 1000 });
    return true;
  } catch {
    return false;
  }
}

// -- app updates & install -----------------------------------------------------------------------

type UpdateStatus = "idle" | "checking" | "latest" | "available" | "offline" | "unsupported";

let swReg: ServiceWorkerRegistration | undefined;
let applySw: ((reload?: boolean) => Promise<void>) | undefined;
const listeners = new Set<(s: UpdateStatus) => void>();
let status: UpdateStatus = "idle";
const setStatus = (s: UpdateStatus) => { status = s; listeners.forEach((l) => l(s)); };

export function initPwa() {
  if (!("serviceWorker" in navigator) || import.meta.env.DEV) return;
  applySw = registerSW({
    onNeedRefresh: () => setStatus("available"),
    onRegisteredSW: (_url, reg) => {
      swReg = reg;
      // check for a new deployment every 6 hours while open
      if (reg) setInterval(() => reg.update().catch(() => {}), 6 * 60 * 60 * 1000);
    },
  });
}

export function useAppUpdate() {
  const [s, setS] = useState(status);
  useEffect(() => { listeners.add(setS); return () => { listeners.delete(setS); }; }, []);

  const check = useCallback(async () => {
    if (!swReg) return setStatus("unsupported");
    if (!navigator.onLine) return setStatus("offline");
    setStatus("checking");
    try {
      await swReg.update();
      const installing = swReg.installing;
      if (installing) {
        await new Promise<void>((res) => {
          installing.addEventListener("statechange", () => { if (installing.state !== "installing") res(); });
        });
      }
      setStatus(swReg.waiting ? "available" : "latest");
    } catch {
      setStatus("offline");
    }
  }, []);

  const apply = useCallback(() => {
    if (applySw) applySw(true);
    else location.reload();
  }, []);

  return { status: s, check, apply };
}

interface InstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }
let installEvt: InstallPromptEvent | null = null;
const installListeners = new Set<() => void>();
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvt = e as InstallPromptEvent;
  installListeners.forEach((l) => l());
});

export const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

export function useInstall() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    installListeners.add(l);
    return () => { installListeners.delete(l); };
  }, []);
  const install = async () => {
    if (!installEvt) return;
    await installEvt.prompt();
    await installEvt.userChoice;
    installEvt = null;
    force((n) => n + 1);
  };
  return { canPrompt: !!installEvt, install, installed: isStandalone() };
}
