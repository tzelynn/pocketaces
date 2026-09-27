import { useEffect, useState } from "react";
import { Layers, RefreshCw, Settings, Spade, TriangleAlert, Wallet, type LucideIcon } from "lucide-react";
import { useAppUpdate, useUser } from "./lib/store";
import { CardsPage } from "./pages/CardsPage";
import { WalletPage } from "./pages/WalletPage";
import { SettingsPage } from "./pages/SettingsPage";

type Tab = "cards" | "wallet" | "settings";
const TABS: { key: Tab; label: string; icon: LucideIcon }[] = [
  { key: "cards", label: "Cards", icon: Layers },
  { key: "wallet", label: "Wallet", icon: Wallet },
  { key: "settings", label: "Settings", icon: Settings },
];

const fromHash = (): Tab => {
  const h = location.hash.replace("#", "");
  return TABS.some((t) => t.key === h) ? (h as Tab) : "cards";
};

export function App() {
  const [tab, setTab] = useState<Tab>(fromHash);
  const { reminders, saveError } = useUser();
  const upd = useAppUpdate();

  useEffect(() => {
    const on = () => setTab(fromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [tab]);

  const go = (t: Tab) => { location.hash = t; };
  const badge = reminders.length;

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#cards" aria-label="pocket aces home">
          <span className="brand-mark"><Spade size={18} fill="currentColor" aria-hidden /></span>
          <span className="brand-name">pocket aces</span>
        </a>
        <nav className="topnav" aria-label="Main">
          {TABS.map((t) => (
            <button key={t.key} type="button" className={tab === t.key ? "on" : ""} aria-current={tab === t.key ? "page" : undefined} onClick={() => go(t.key)}>
              <t.icon size={16} aria-hidden /> {t.label}
              {t.key === "wallet" && badge > 0 && <span className="badge" aria-label={`${badge} reminders`}>{badge}</span>}
            </button>
          ))}
        </nav>
      </header>

      {upd.status === "available" && (
        <div className="banner">
          <RefreshCw size={16} aria-hidden /> A fresh deck is ready.
          <button type="button" className="btn small primary" onClick={upd.apply}>Update</button>
        </div>
      )}
      {saveError && (
        <div className="banner error" role="alert">
          <TriangleAlert size={16} aria-hidden /> {saveError}. Your latest changes may not survive a restart.
          Download a backup from Settings.
        </div>
      )}

      <main>
        {tab === "cards" && <CardsPage />}
        {tab === "wallet" && <WalletPage />}
        {tab === "settings" && <SettingsPage />}
      </main>

      <nav className="bottomnav" aria-label="Main">
        {TABS.map((t) => (
          <button key={t.key} type="button" className={tab === t.key ? "on" : ""} aria-current={tab === t.key ? "page" : undefined} onClick={() => go(t.key)}>
            <span className="bn-icon">
              <t.icon size={22} aria-hidden />
              {t.key === "wallet" && badge > 0 && <span className="badge">{badge}</span>}
            </span>
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
