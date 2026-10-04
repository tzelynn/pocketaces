import { useEffect, useRef, useState } from "react";
import { Bell, CalendarPlus, Download, HardDrive, Plane, RefreshCw, Share, Smartphone, Upload } from "lucide-react";
import { enableNotifications, registerPeriodicSync, useAppUpdate, useInstall, useSync, useUser } from "../lib/store";
import { backupBlob, download, isPersisted, parseBackup, requestPersistence } from "../lib/storage";
import { buildIcs } from "../lib/ics";
import { emptyState } from "../types";
import { AccountPanel } from "../components/AccountPanel";

declare const __BUILT_AT__: string;

const fmtStamp = (iso: string) =>
  new Date(iso).toLocaleString("en-SG", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export function SettingsPage() {
  const { state, update, replace, catalog } = useUser();
  const upd = useAppUpdate();
  const inst = useInstall();
  const synced = !!useSync().status.username;
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [notifMsg, setNotifMsg] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const s = state.settings;
  const setS = (p: Partial<typeof s>) => update((st) => ({ ...st, settings: { ...st.settings, ...p } }));

  useEffect(() => { isPersisted().then(setPersisted); }, []);
  useEffect(() => { if (s.notifications) registerPeriodicSync(); }, [s.notifications]);

  const toggleNotifications = async () => {
    if (s.notifications) { setS({ notifications: false }); setNotifMsg(null); return; }
    const r = await enableNotifications();
    if (!r.ok) { setNotifMsg(r.reason ?? "Couldn't turn on notifications."); return; }
    setS({ notifications: true });
    setNotifMsg(r.background
      ? "On. You'll be notified even when the app is closed (the phone checks roughly twice a day)."
      : "On. Notifications appear when you open the app. For reminders while it's closed, add them to your calendar as well.");
  };

  const exportBackup = () => {
    download(backupBlob(state), `pocket-aces-backup-${new Date().toISOString().slice(0, 10)}.json`);
    update((st) => ({ ...st, lastBackupAt: new Date().toISOString() }));
  };

  const importBackup = async (f: File) => {
    try {
      const next = parseBackup(await f.text());
      if (!confirm(`Replace what's on this device${synced ? " and in your account" : ""} with the backup (${next.myCards.length} cards)?`)) return;
      replace(next);
      setImportMsg(`Restored ${next.myCards.length} cards and ${Object.keys(next.notes).length} notes.`);
    } catch (e) {
      setImportMsg(`That file couldn't be read: ${(e as Error).message}`);
    }
  };

  const backupAge = state.lastBackupAt ? (Date.now() - Date.parse(state.lastBackupAt)) / 86_400_000 : Infinity;

  return (
    <div className="page settings-page">
      <section className="panel">
        <h3 className="section-title"><RefreshCw size={16} aria-hidden /> App version</h3>
        <p className="sub">App built {fmtStamp(__BUILT_AT__)}{catalog && ` · card data from ${fmtStamp(catalog.builtAt)}`}</p>
        <div className="row-actions">
          {upd.status === "available" ? (
            <button type="button" className="btn primary" onClick={upd.apply}><RefreshCw size={16} /> Update now</button>
          ) : (
            <button type="button" className="btn" onClick={upd.check} disabled={upd.status === "checking"}>
              <RefreshCw size={16} className={upd.status === "checking" ? "spin" : ""} /> Check for updates
            </button>
          )}
          <span className="status-text" role="status">
            {{
              idle: "", checking: "Checking…", latest: "You're on the latest version.",
              available: "A new version is ready.", offline: "You're offline. Try again when connected.",
              unsupported: "Updates install automatically in this browser. Reload the page to get the latest.",
            }[upd.status]}
          </span>
        </div>
      </section>

      {!inst.installed && (
        <section className="panel">
          <h3 className="section-title"><Smartphone size={16} aria-hidden /> Install on your phone</h3>
          {inst.canPrompt ? (
            <button type="button" className="btn primary" onClick={inst.install}><Download size={16} /> Install app</button>
          ) : isIos() ? (
            <p>In Safari, tap <Share size={14} aria-label="Share" className="inline-icon" /> <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
              Installing is also what lets iOS show notifications.</p>
          ) : (
            <p>Open your browser's menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</p>
          )}
          <p className="hint">It works offline once installed.</p>
        </section>
      )}

      <AccountPanel />

      <section className="panel">
        <h3 className="section-title"><Bell size={16} aria-hidden /> Reminders</h3>
        <label className="toggle">
          <input type="checkbox" checked={s.notifications} onChange={toggleNotifications} />
          <span>Notifications for bills and annual fees</span>
        </label>
        {notifMsg && <p className="hint">{notifMsg}</p>}
        <div className="grid2">
          <label>Remind me about bills
            <select aria-label="Bill reminder" value={s.billReminderDays} onChange={(e) => setS({ billReminderDays: Number(e.target.value) })}>
              {[3, 5, 7, 10, 14].map((d) => <option key={d} value={d}>{d} days before due</option>)}
            </select>
          </label>
          <label>Remind me about fees
            <select aria-label="Fee reminder" value={s.feeReminderDays} onChange={(e) => setS({ feeReminderDays: Number(e.target.value) })}>
              {[0, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{d ? `${d} days before` : "On the day"}</option>)}
            </select>
          </label>
        </div>
        <button type="button" className="btn ghost" onClick={() => {
          const cards = state.myCards.filter((c) => c.dueDay || c.feeDate);
          if (!cards.length) return alert("Add a due day or annual fee date to a card first.");
          download(new Blob([buildIcs(cards, s)], { type: "text/calendar" }), "pocket-aces-reminders.ics");
        }}><CalendarPlus size={16} /> Add reminders to my calendar</button>
        <p className="hint">
          Browsers can only notify in the background on Android (installed app). Calendar reminders work on every phone,
          but they can't tell when you've already paid, so they fire every month.
        </p>
      </section>

      <section className="panel">
        <h3 className="section-title"><Plane size={16} aria-hidden /> Reward valuation</h3>
        <label className="inline">
          Value one mile at
          <input type="number" min={0.5} max={5} step={0.1} value={s.centsPerMile}
            onChange={(e) => setS({ centsPerMile: Math.max(0.1, Number(e.target.value) || 1.5) })} /> cents
        </label>
        <p className="hint">Used to compare miles cards with cashback cards (1 mpd at {s.centsPerMile}¢ ≈ {s.centsPerMile}% back). Points cards aren't valued: conversion rates vary by bank.</p>
      </section>

      <section className="panel">
        <h3 className="section-title"><HardDrive size={16} aria-hidden /> Your data</h3>
        <p>
          {synced ? "Stored on this device and, encrypted, in your account" : "Everything is stored only on this device"} ({persisted ? "protected from automatic clean-up" : "the browser may clear it if storage runs low"}).
          {!persisted && <> <button type="button" className="link" onClick={async () => setPersisted(await requestPersistence())}>Ask to keep it</button></>}
        </p>
        <p className={`sub ${backupAge > 30 && state.myCards.length ? "warn-text" : ""}`}>
          {state.lastBackupAt ? `Last backup ${fmtStamp(state.lastBackupAt)}` : "No backup yet"}
          {backupAge > 30 && state.myCards.length ? ". A backup lets you move to a new phone or recover cleared data." : ""}
        </p>
        <div className="row-actions">
          <button type="button" className="btn" onClick={exportBackup}><Download size={16} /> Download backup</button>
          <button type="button" className="btn ghost" onClick={() => fileRef.current?.click()}><Upload size={16} /> Restore</button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) importBackup(f); e.target.value = ""; }} />
        </div>
        {importMsg && <p className="hint" role="status">{importMsg}</p>}
        <button type="button" className="link danger" onClick={() => {
          if (confirm(synced
            ? "Delete all your cards, notes and check-offs from this device and your account (and so your other devices)? This can't be undone."
            : "Delete all your cards, notes and check-offs from this device? This can't be undone.")) replace(emptyState());
        }}>{synced ? "Erase everything, on every device" : "Erase everything on this device"}</button>
      </section>
    </div>
  );
}
