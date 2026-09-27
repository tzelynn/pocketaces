import { useMemo, useState } from "react";
import {
  CalendarPlus, Check, CircleCheck, HandCoins, Pencil, Plus, Receipt, Search, Spade, Target, Trash2, Undo2, Wallet,
} from "lucide-react";
import type { CatalogCard, MyCard, SpendPeriod } from "../types";
import { useUser } from "../lib/store";
import { billCycles, daysBetween, feeInstance, fmtDate, relDays, spendWindow, spentInWindow, toYmd } from "../lib/dates";
import { FEE_GRACE_DAYS, type Reminder } from "../lib/reminders";
import { fmtMoney, fmtRate, headlineRule } from "../lib/catalog";
import { buildIcs } from "../lib/ics";
import { download } from "../lib/storage";
import { patchCard, uid, useWalletActions } from "../lib/wallet";
import { CardArt, Empty, Segmented, Sheet, SpendBar } from "../components/ui";

type Guidance = { card: MyCard; spent: number; status: "unlock" | "room" | "open" | "capped"; text: string; order: number };

/** The catalogue card's spend cycle (custom cards count per calendar month). */
const cardCycle = (byId: Map<string, CatalogCard>, card: MyCard): SpendPeriod | undefined =>
  card.catalogId ? byId.get(card.catalogId)?.spendCycle : undefined;

function guidance(cards: MyCard[], on: string, byId: Map<string, CatalogCard>): Guidance[] {
  return cards.map((card): Guidance => {
    const spent = spentInWindow(card, on, cardCycle(byId, card));
    const { minSpend: min, maxSpend: max } = card;
    if (max && spent >= max) return { card, spent, status: "capped", text: "Capped for this period. Use another card.", order: 3e9 };
    if (min && spent < min) return { card, spent, status: "unlock", text: `${fmtMoney(min - spent)} more to hit the min spend`, order: min - spent };
    if (max) return { card, spent, status: "room", text: `${fmtMoney(max - spent)} left before the cap`, order: 1e9 - (max - spent) };
    return { card, spent, status: "open", text: min ? "Min spend met, no cap set" : "No spend targets set", order: 2e9 };
  }).sort((a, b) => a.order - b.order);
}

export function WalletPage() {
  const { state, update, reminders, on, byId } = useUser();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const cards = state.myCards;
  const guide = useMemo(() => guidance(cards.filter((c) => c.minSpend || c.maxSpend), on, byId), [cards, on, byId]);

  const checkBill = (card: MyCard, statement: string, paid: boolean) =>
    update((s) => patchCard(s, card.id, (c) => {
      const bills = { ...c.bills };
      if (paid) bills[statement] = { paidAt: new Date().toISOString() }; else delete bills[statement];
      return { ...c, bills };
    }));
  const checkFee = (card: MyCard, date: string, status: "waived" | "paid" | null) =>
    update((s) => patchCard(s, card.id, (c) => {
      const fees = { ...c.fees };
      if (status) fees[date] = { status, at: new Date().toISOString() }; else delete fees[date];
      return { ...c, fees };
    }));
  const act = (r: Reminder, what: "paid" | "waived") => {
    const card = cards.find((c) => c.id === r.cardId)!;
    if (r.kind === "bill") checkBill(card, r.instance, true); else checkFee(card, r.instance, what);
  };

  const exportCalendar = () => {
    const withDates = cards.filter((c) => c.dueDay || c.feeDate);
    if (!withDates.length) return alert("Add a due day or annual fee date to a card first.");
    download(new Blob([buildIcs(withDates, state.settings)], { type: "text/calendar" }), "pocket-aces-reminders.ics");
  };

  if (!cards.length) {
    return (
      <div className="page">
        <Empty icon={Spade} title="Your hand is empty">
          <p>Add the cards you hold to track bill dates, annual fee waivers and spend.</p>
          <button type="button" className="btn primary" onClick={() => setAdding(true)}><Plus size={16} /> Add a card</button>
        </Empty>
        <AddCardSheet open={adding} onClose={() => setAdding(false)} onAdded={(id) => { setAdding(false); setEditing(id); }} />
      </div>
    );
  }

  const editCard = cards.find((c) => c.id === editing) ?? null;

  return (
    <div className="page wallet-page">
      <div className="page-head">
        <h2>Your hand <span className="count">{cards.length}</span></h2>
        <div className="head-actions">
          <button type="button" className="btn ghost" onClick={exportCalendar} title="Download reminders for your calendar app">
            <CalendarPlus size={16} /> <span className="hide-sm">Add to calendar</span>
          </button>
          <button type="button" className="btn primary" onClick={() => setAdding(true)}><Plus size={16} /> Add card</button>
        </div>
      </div>

      <section className="panel heads-up" aria-label="Heads up">
        <h3 className="section-title">Heads up</h3>
        {reminders.length === 0 ? (
          <p className="all-clear"><CircleCheck size={18} aria-hidden /> Clean table. Nothing due in the next {state.settings.billReminderDays} days.</p>
        ) : (
          <ul className="reminders">
            {reminders.map((r) => (
              <li key={r.key} className={r.severity}>
                {r.kind === "bill" ? <Receipt size={18} aria-hidden /> : <HandCoins size={18} aria-hidden />}
                <div className="rem-text"><p className="rem-title">{r.title}</p><p className="sub">{r.body}</p></div>
                <div className="rem-actions">
                  {r.kind === "bill"
                    ? <button type="button" className="btn small" onClick={() => act(r, "paid")}><Check size={14} /> Paid</button>
                    : <>
                      <button type="button" className="btn small" onClick={() => act(r, "waived")}><Check size={14} /> Waived</button>
                      <button type="button" className="btn small ghost" onClick={() => act(r, "paid")}>Paid</button>
                    </>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {guide.length > 0 && (
        <section className="panel" aria-label="Which card next">
          <h3 className="section-title"><Target size={16} aria-hidden /> Which card next?</h3>
          <ol className="guide">
            {guide.map((g, i) => {
              const cat = g.card.catalogId ? byId.get(g.card.catalogId) : undefined;
              const rule = cat ? headlineRule(cat, null) : null;
              return (
                <li key={g.card.id} className={`${g.status} ${i === 0 && g.status !== "capped" ? "top" : ""}`}>
                  <span className="rank">{i + 1}</span>
                  <div>
                    <p className="g-name">{g.card.nickname}{rule && <span className="sub"> · up to {fmtRate(rule)}</span>}</p>
                    <p className="sub">{g.text}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      <div className="tiles">
        {cards.map((c) => (
          <CardTile key={c.id} card={c} onEdit={() => setEditing(c.id)} onBill={checkBill} onFee={checkFee} />
        ))}
      </div>

      <p className="fine">
        Check-offs reset each statement (bills) and each year (annual fees). Spend is logged by hand. Add purchases as you
        go, or type in the running total from your banking app.
      </p>

      <AddCardSheet open={adding} onClose={() => setAdding(false)} onAdded={(id) => { setAdding(false); setEditing(id); }} />
      <EditCardSheet card={editCard} onClose={() => setEditing(null)} />
    </div>
  );
}

function CardTile({ card, onEdit, onBill, onFee }: {
  card: MyCard;
  onEdit: () => void;
  onBill: (c: MyCard, statement: string, paid: boolean) => void;
  onFee: (c: MyCard, date: string, status: "waived" | "paid" | null) => void;
}) {
  const { update, on, byId, state } = useUser();
  const cat = card.catalogId ? byId.get(card.catalogId) : undefined;
  const { current, next } = billCycles(card, on);
  const fee = feeInstance(card, on, FEE_GRACE_DAYS);
  const win = spendWindow(card, on, cat?.spendCycle);
  const spent = spentInWindow(card, on, cat?.spendCycle);
  const entries = card.spends.filter((s) => s.date >= win.start && s.date <= win.end).sort((a, b) => b.date.localeCompare(a.date));
  const [amt, setAmt] = useState("");
  const [note, setNote] = useState("");
  const [showLog, setShowLog] = useState(false);

  const addSpend = (e: React.FormEvent) => {
    e.preventDefault();
    const amount = parseFloat(amt);
    if (!Number.isFinite(amount) || amount === 0) return;
    update((s) => patchCard(s, card.id, (c) => ({
      ...c, spends: [...c.spends, { id: uid(), date: on, amount, note: note.trim() || undefined }],
    })));
    setAmt(""); setNote("");
  };
  const delSpend = (id: string) => update((s) => patchCard(s, card.id, (c) => ({ ...c, spends: c.spends.filter((x) => x.id !== id) })));

  const paid = current ? card.bills[current.statement] : undefined;
  const dueIn = current ? daysBetween(on, current.due) : 0;
  const feeDone = fee ? card.fees[fee] : undefined;
  const feeIn = fee ? daysBetween(on, fee) : 0;
  const billSoon = state.settings.billReminderDays;

  return (
    <article className="tile">
      <header className="tile-head">
        <CardArt src={cat?.image ?? null} name={card.nickname} small />
        <div className="tile-name">
          <h3>{card.nickname}{card.last4 && <span className="last4"> ··{card.last4}</span>}</h3>
          <p className="sub">{cat ? cat.bank : "Custom card"}</p>
        </div>
        <button type="button" className="icon-btn" onClick={onEdit} aria-label={`Edit ${card.nickname}`}><Pencil size={16} /></button>
      </header>

      <div className="tile-row">
        <Receipt size={18} className="row-icon" aria-hidden />
        {current || next ? (
          <>
            <div className="row-text">
              {current ? (
                <>
                  <p>Due <strong>{fmtDate(current.due)}</strong>{current.estimated && <span className="sub"> (est.)</span>}</p>
                  <p className="sub">Statement {fmtDate(current.statement)}{next && ` · next ${fmtDate(next.statement)}`}</p>
                </>
              ) : (
                <p>First statement {fmtDate(next!.statement)}</p>
              )}
            </div>
            {current && (
              <button type="button" className={`check ${paid ? "done" : dueIn < 0 ? "overdue" : dueIn <= billSoon ? "soon" : ""}`}
                aria-pressed={!!paid} onClick={() => onBill(card, current.statement, !paid)}>
                {paid ? <><Check size={14} /> Paid</> : dueIn < 0 ? "Overdue" : relDays(dueIn)}
              </button>
            )}
          </>
        ) : (
          <button type="button" className="link" onClick={onEdit}>Add bill dates</button>
        )}
      </div>

      <div className="tile-row">
        <HandCoins size={18} className="row-icon" aria-hidden />
        {fee ? (
          <>
            <div className="row-text">
              <p>Annual fee <strong>{fmtDate(fee, true)}</strong></p>
              <p className="sub">
                {feeDone ? `${feeDone.status === "waived" ? "Waived" : "Paid"} ${fmtDate(toYmd(new Date(feeDone.at)))}`
                  : `${cat?.fee?.amount ? `${fmtMoney(cat.fee.amount, 2)} · ` : ""}${relDays(feeIn)}`}
              </p>
            </div>
            {feeDone ? (
              <button type="button" className="check done" onClick={() => onFee(card, fee, null)} title="Undo">
                <Undo2 size={14} /> Undo
              </button>
            ) : (
              <div className="fee-actions">
                <button type="button" className={`check ${feeIn <= 0 ? "overdue" : feeIn <= state.settings.feeReminderDays ? "soon" : ""}`}
                  onClick={() => onFee(card, fee, "waived")}>Waived</button>
                <button type="button" className="check" onClick={() => onFee(card, fee, "paid")}>Paid</button>
              </div>
            )}
          </>
        ) : (
          <button type="button" className="link" onClick={onEdit}>Add annual fee date</button>
        )}
      </div>

      <div className="tile-row spend">
        <Target size={18} className="row-icon" aria-hidden />
        <div className="row-text">
          <p>
            <strong>{fmtMoney(spent, spent % 1 ? 2 : 0)}</strong> spent
            <span className="sub"> · {fmtDate(win.start)}–{fmtDate(win.end)}</span>
          </p>
          {(card.minSpend || card.maxSpend) ? (
            <>
              <SpendBar spent={spent} min={card.minSpend} max={card.maxSpend} />
              <p className="sub bar-legend">
                {card.minSpend ? <span className={spent >= card.minSpend ? "met" : ""}>min {fmtMoney(card.minSpend)}{spent >= card.minSpend && <Check size={12} className="inline-icon" aria-label="met" />}</span> : null}
                {card.maxSpend ? <span className={spent >= card.maxSpend ? "over" : ""}>cap {fmtMoney(card.maxSpend)}</span> : null}
              </p>
            </>
          ) : <p className="sub"><button type="button" className="link" onClick={onEdit}>Set min spend / cap</button></p>}
          <form className="spend-form" onSubmit={addSpend}>
            <input inputMode="decimal" type="number" step="0.01" placeholder="S$" value={amt} onChange={(e) => setAmt(e.target.value)} aria-label="Amount" />
            <input type="text" placeholder="What for?" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
            <button type="submit" className="btn small" disabled={!amt}><Plus size={14} /> Log</button>
          </form>
          {entries.length > 0 && (
            <>
              <button type="button" className="link small" onClick={() => setShowLog((v) => !v)}>
                {showLog ? "Hide" : "Show"} {entries.length} {entries.length === 1 ? "entry" : "entries"}
              </button>
              {showLog && (
                <ul className="spend-log">
                  {entries.map((s) => (
                    <li key={s.id}>
                      <span className="sub">{fmtDate(s.date)}</span>
                      <span className="log-note">{s.note ?? ""}</span>
                      <span>{fmtMoney(s.amount, 2)}</span>
                      <button type="button" className="icon-btn" onClick={() => delSpend(s.id)} aria-label="Delete entry"><Trash2 size={14} /></button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function AddCardSheet({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (id: string) => void }) {
  const { catalog } = useUser();
  const { owned, add } = useWalletActions();
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const list = (catalog?.cards ?? [])
    .filter((c) => !owned.has(c.id) && (!needle || `${c.name} ${c.bank}`.toLowerCase().includes(needle)))
    .slice(0, 40);
  return (
    <Sheet open={open} onClose={onClose} title="Add a card">
      <label className="search">
        <Search size={16} aria-hidden />
        <input type="search" autoFocus placeholder="Search cards or banks" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <ul className="pick-list">
        {list.map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => onAdded(add(c).id)}>
              <CardArt src={c.image} name={c.name} small />
              <span><span className="name">{c.name}</span><span className="sub">{c.bank}</span></span>
            </button>
          </li>
        ))}
        <li>
          <button type="button" onClick={() => onAdded(add(undefined, q.trim() || "My card").id)}>
            <span className="card-art small fallback"><Wallet size={16} /></span>
            <span><span className="name">{q.trim() ? `Add “${q.trim()}” as a custom card` : "Custom card"}</span>
              <span className="sub">Not in the list? Track it anyway</span></span>
          </button>
        </li>
      </ul>
    </Sheet>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const num = (v: string) => (v === "" ? undefined : Number(v));

function EditCardSheet({ card, onClose }: { card: MyCard | null; onClose: () => void }) {
  const { update, byId } = useUser();
  if (!card) return <Sheet open={false} onClose={onClose} title="">{null}</Sheet>;
  const cat = card.catalogId ? byId.get(card.catalogId) : undefined;
  const defaultCycle: SpendPeriod = cat?.spendCycle ?? "calendar";
  const period = card.spendPeriod ?? defaultCycle;
  const set = (p: Partial<MyCard>) => update((s) => patchCard(s, card.id, (c) => ({ ...c, ...p })));
  const [fm, fd] = card.feeDate ? card.feeDate.split("-").map(Number) : [0, 0];
  const setFee = (m: number, d: number) =>
    set({ feeDate: m && d ? `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : undefined });
  const day = (v: string) => { const n = num(v); return n == null ? undefined : Math.min(31, Math.max(1, Math.round(n))); };
  const del = () => {
    if (!confirm(`Remove ${card.nickname}? Its bill dates and spend log will be deleted.`)) return;
    update((s) => ({ ...s, myCards: s.myCards.filter((c) => c.id !== card.id) }));
    onClose();
  };

  return (
    <Sheet open onClose={onClose} title={`Edit ${card.nickname}`}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); onClose(); }}>
        {cat && <p className="sub">{cat.name}</p>}
        <div className="grid2">
          <label>Nickname<input value={card.nickname} onChange={(e) => set({ nickname: e.target.value })} /></label>
          <label>Last 4 digits<input inputMode="numeric" maxLength={4} value={card.last4 ?? ""} placeholder="optional"
            onChange={(e) => set({ last4: e.target.value.replace(/\D/g, "") || undefined })} /></label>
        </div>

        <fieldset>
          <legend>Bill</legend>
          <div className="grid2">
            <label>Statement day<input type="number" min={1} max={31} inputMode="numeric" placeholder="e.g. 25"
              value={card.statementDay ?? ""} onChange={(e) => set({ statementDay: day(e.target.value) })} /></label>
            <label>Payment due day<input type="number" min={1} max={31} inputMode="numeric" placeholder="e.g. 15"
              value={card.dueDay ?? ""} onChange={(e) => set({ dueDay: day(e.target.value) })} /></label>
          </div>
          <p className="hint">Day of the month, as printed on your statement. If you only know the due day, the statement date is estimated as 3 weeks earlier.</p>
        </fieldset>

        <fieldset>
          <legend>Annual fee</legend>
          <div className="grid2">
            <label>Month<select aria-label="Annual fee month" value={fm || ""} onChange={(e) => setFee(Number(e.target.value), fd || 1)}>
              <option value="">Not set</option>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select></label>
            <label>Day<input aria-label="Annual fee day" type="number" min={1} max={31} inputMode="numeric" disabled={!fm} value={fd || ""}
              onChange={(e) => setFee(fm, day(e.target.value) ?? 1)} /></label>
          </div>
          <p className="hint">Usually the month you were approved. It shows on the statement where the fee first appeared.</p>
        </fieldset>

        <fieldset>
          <legend>Spend targets</legend>
          <div className="grid2">
            <label>Min spend (S$)<input type="number" min={0} inputMode="decimal" placeholder="none"
              value={card.minSpend ?? ""} onChange={(e) => set({ minSpend: num(e.target.value) || undefined })} /></label>
            <label>Bonus cap (S$ spend)<input type="number" min={0} inputMode="decimal" placeholder="none"
              value={card.maxSpend ?? ""} onChange={(e) => set({ maxSpend: num(e.target.value) || undefined })} /></label>
          </div>
          <Segmented label="Spend resets" value={period}
            // only store a choice that differs from the card's T&Cs, so corrected data still flows through
            onChange={(v) => set({ spendPeriod: v === defaultCycle ? undefined : v })}
            options={[{ value: "calendar", label: "Resets on the 1st" }, { value: "statement", label: "Resets at statement" }]} />
          {period === "statement" && !card.statementDay && <p className="hint warn">Set a statement day to reset at statement. Until then spend is counted per calendar month.</p>}
          {cat && <p className="hint">
            The card's T&Cs count spend per {cat.spendCycle === "statement" ? "statement cycle" : "calendar month"}
            {card.spendPeriod && card.spendPeriod !== defaultCycle && <> (you changed this). <button type="button" className="link" onClick={() => set({ spendPeriod: undefined })}>Use the T&Cs</button></>}.
          </p>}
          {cat && <p className="hint">Prefilled from the card's listed min spend and bonus cap, where known. Check them against the T&Cs.</p>}
        </fieldset>

        <div className="form-actions">
          <button type="button" className="btn danger ghost" onClick={del}><Trash2 size={16} /> Remove card</button>
          <button type="submit" className="btn primary">Done</button>
        </div>
      </form>
    </Sheet>
  );
}
