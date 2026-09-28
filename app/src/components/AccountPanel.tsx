import { useState, type FormEvent } from "react";
import { Cloud, CloudCheck, CloudOff, KeyRound, LoaderCircle, LogIn, LogOut, Trash2, UserPlus } from "lucide-react";
import { useSync } from "../lib/store";
import { MIN_PASSWORD } from "../lib/crypto";
import { Segmented } from "./ui";

const ago = (iso?: string) => {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(iso).toLocaleString("en-SG", { hour: "numeric", minute: "2-digit", day: "numeric", month: "short" });
};

/** Sign in / create account, and sync status once signed in. Hidden where there's no sync server. */
export function AccountPanel() {
  const { engine, status } = useSync();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState<null | "password" | "delete">(null);

  if (!engine || status.phase === "unavailable" || status.phase === "checking") return null;

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setPassword(""); setConfirmPw(""); setCode("");
      if (done) setMsg(done);
      return true;
    } catch (e) {
      setMsg((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (status.phase === "signed-out") {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      if (mode === "up" && password !== confirmPw) return setMsg("The passwords don't match.");
      run(() => (mode === "in" ? engine.signIn(username, password) : engine.signUp(username, password, code)));
    };
    return (
      <section className="panel">
        <h3 className="section-title"><Cloud size={16} aria-hidden /> Sync across devices</h3>
        {status.message && <p className="hint warn" role="status">{status.message}</p>}
        <Segmented label="Account" value={mode} onChange={(m) => { setMode(m); setMsg(null); }}
          options={[{ value: "in", label: "Sign in", icon: LogIn }, { value: "up", label: "Create account", icon: UserPlus }]} />
        <form className="form" onSubmit={submit}>
          <label>Username
            <input autoComplete="username" autoCapitalize="none" spellCheck={false} required value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label>Password
            <input type="password" autoComplete={mode === "in" ? "current-password" : "new-password"} required
              minLength={mode === "up" ? MIN_PASSWORD : undefined} value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {mode === "up" && (
            <>
              <label>Confirm password
                <input type="password" autoComplete="new-password" required value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />
              </label>
              {status.signupCode && (
                <label>Sign-up code
                  <input autoComplete="off" required value={code} onChange={(e) => setCode(e.target.value)} />
                </label>
              )}
            </>
          )}
          <div className="row-actions">
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? <LoaderCircle size={16} className="spin" /> : mode === "in" ? <LogIn size={16} /> : <UserPlus size={16} />}
              {busy ? "Unlocking…" : mode === "in" ? "Sign in" : "Create account"}
            </button>
          </div>
          {msg && <p className="hint warn" role="alert">{msg}</p>}
        </form>
        <p className="hint">
          {mode === "in"
            ? "Cards already on this device are merged into your account."
            : <>Your data is encrypted on this device with your password before it's uploaded, so no one else, including
              the server, can read it. That also means <strong>a forgotten password can't be reset</strong>: your devices keep their copy,
              but you'd need a new account. Use a long password (at least {MIN_PASSWORD} characters) that you don't use elsewhere.</>}
        </p>
      </section>
    );
  }

  const phaseText = {
    connecting: "Connecting…",
    syncing: "Syncing…",
    synced: `Up to date${status.lastSyncedAt ? ` · ${ago(status.lastSyncedAt)}` : ""}`,
    offline: "Offline. Changes will sync when you're back online.",
    error: status.message ?? "Sync problem",
  }[status.phase];
  const Icon = status.phase === "synced" ? CloudCheck : status.phase === "offline" || status.phase === "error" ? CloudOff : Cloud;

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    const [cur, next, again] = ["current", "next", "again"].map((k) => String(f.get(k) ?? ""));
    if (next !== again) return setMsg("The new passwords don't match.");
    if (await run(() => engine.changePassword(cur, next), "Password changed. Other devices have been signed out.")) setForm(null);
  };

  const deleteAccount = (e: FormEvent) => {
    e.preventDefault();
    const pw = String(new FormData(e.currentTarget as HTMLFormElement).get("current") ?? "");
    run(() => engine.deleteAccount(pw), "Account deleted. Your data is still on this device.");
  };

  const cancel = <button type="button" className="btn ghost" onClick={() => { setForm(null); setMsg(null); }}>Cancel</button>;
  const who = <input type="text" name="username" autoComplete="username" value={status.username} readOnly hidden />;

  return (
    <section className="panel">
      <h3 className="section-title"><Cloud size={16} aria-hidden /> Sync across devices</h3>
      <p>Signed in as <strong>{status.username}</strong>. Changes appear on your other devices as you make them.</p>
      <p className={`status-text ${status.phase === "error" ? "warn-text" : ""}`} role="status">
        <Icon size={14} className={`inline-icon ${status.phase === "syncing" || status.phase === "connecting" ? "spin" : ""}`} aria-hidden /> {phaseText}
      </p>
      {form === "password" ? (
        <form className="form" onSubmit={changePassword}>
          {who}
          <label>Current password<input type="password" name="current" autoComplete="current-password" required /></label>
          <label>New password<input type="password" name="next" autoComplete="new-password" required minLength={MIN_PASSWORD} /></label>
          <label>Confirm new password<input type="password" name="again" autoComplete="new-password" required /></label>
          <div className="row-actions">
            <button type="submit" className="btn primary" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />} Change password</button>
            {cancel}
          </div>
        </form>
      ) : form === "delete" ? (
        <form className="form" onSubmit={deleteAccount}>
          <p>This deletes your account and its synced copy from the server, and signs out every device. Your devices keep their data.</p>
          {who}
          <label>Password<input type="password" name="current" autoComplete="current-password" required /></label>
          <div className="row-actions">
            <button type="submit" className="btn danger" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />} Delete account</button>
            {cancel}
          </div>
        </form>
      ) : (
        <div className="row-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => run(() => engine.signOut())}><LogOut size={16} /> Sign out</button>
          <button type="button" className="btn ghost" onClick={() => { setForm("password"); setMsg(null); }}><KeyRound size={16} /> Change password</button>
        </div>
      )}
      {msg && <p className="hint" role="status">{msg}</p>}
      <p className="hint">Encrypted on your devices with your password; the server only stores the scrambled copy.
        Signing out keeps your cards on this device.</p>
      <div className="row-actions">
        <button type="button" className="link danger" disabled={busy} onClick={() => {
          if (confirm("Sign out and erase your cards, notes and check-offs from this device? Your account keeps its copy.")) run(() => engine.signOut(true));
        }}>Sign out and erase this device</button>
        <button type="button" className="link danger" onClick={() => { setForm("delete"); setMsg(null); }}>Delete account</button>
      </div>
    </section>
  );
}
