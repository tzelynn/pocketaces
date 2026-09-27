/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { get, set } from "idb-keyval";
import type { UserState } from "./types";
import { toYmd } from "./lib/dates";
import { REMINDER_SYNC_TAG, remindersFor, unnotified } from "./lib/reminders";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

// Keep in sync with lib/storage.ts (not imported: it touches DOM globals).
const STATE_KEY = "state";
const NOTIFIED_KEY = "notified";

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// The app's update button asks a waiting worker to take over.
self.addEventListener("message", (e) => {
  if (e.data?.type === "SKIP_WAITING") self.skipWaiting();
});

async function checkReminders() {
  const state = (await get(STATE_KEY)) as UserState | undefined;
  if (!state?.settings?.notifications) return;
  const all = remindersFor(state.myCards ?? [], state.settings, toYmd(new Date()));
  const { fresh, notified } = unnotified(all, (await get(NOTIFIED_KEY)) ?? {});
  await set(NOTIFIED_KEY, notified);
  await Promise.all(
    fresh.map((r) =>
      self.registration.showNotification(r.title, {
        body: r.body,
        tag: r.key,
        icon: "icons/icon-192.png",
        badge: "icons/badge-96.png",
        data: { url: "./#wallet" },
      }),
    ),
  );
}

// Chromium only (installed app). Other platforms rely on in-app checks and calendar export.
self.addEventListener("periodicsync", ((e: ExtendableEvent & { tag: string }) => {
  if (e.tag === REMINDER_SYNC_TAG) e.waitUntil(checkReminders());
}) as EventListener);

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url ?? "./", self.registration.scope).href;
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const win = wins[0];
      if (win) {
        await win.focus();
        if ("navigate" in win) await (win as WindowClient).navigate(url);
      } else await self.clients.openWindow(url);
    })(),
  );
});
