import { ExternalLink, Gift, Info, Star, StickyNote } from "lucide-react";
import type { CatalogCard } from "../types";
import { useUser } from "../lib/store";
import {
  activeBonuses, bonusHeadline, capPeriod, OFFERED_BY, effectivePct, fmtMoney, fmtRate, PERIOD_SHORT, spendCap, withinLabel,
} from "../lib/catalog";
import { fmtDate, today } from "../lib/dates";
import { useWalletActions } from "../lib/wallet";
import { CardArt, NoteField, REWARD_LABEL, RewardBadge, Sheet } from "./ui";

const MODE_LABEL: Record<string, string> = {
  online: "online", in_app: "in-app", contactless: "contactless", mobile_wallet: "mobile wallet",
  chip_pin: "chip & PIN", recurring: "recurring", foreign_currency: "foreign currency",
  local_currency: "SGD", overseas_in_sgd: "overseas in SGD",
};

export function CardDetail({ card, onClose }: { card: CatalogCard | null; onClose: () => void }) {
  const { state, update } = useUser();
  const { owned, add, remove } = useWalletActions();
  if (!card) return <Sheet open={false} onClose={onClose} title="">{null}</Sheet>;
  const isMine = owned.has(card.id);
  const cpm = state.settings.centsPerMile;
  const on = today();
  const offers = activeBonuses(card, on, cpm);
  const rules = [...card.rules].sort((a, b) => (a.tier === b.tier ? b.rate - a.rate : a.tier === "bonus" ? -1 : 1));
  const official = card.sources.filter((s) => s.type === "official");
  const note = state.notes[card.id] ?? "";

  return (
    <Sheet open onClose={onClose} title={card.name} wide>
      <div className="detail-hero">
        <CardArt src={card.image} name={card.name} />
        <div className="detail-facts">
          <p className="bank">{card.bank}{card.network ? ` · ${card.network === "amex" ? "Amex" : card.network[0].toUpperCase() + card.network.slice(1)}` : ""}</p>
          <dl className="facts">
            <div><dt>Rewards</dt><dd><RewardBadge kind={card.kind} /> {REWARD_LABEL[card.kind]}</dd></div>
            <div><dt>Annual fee</dt><dd>{card.fee ? (card.fee.amount ? fmtMoney(card.fee.amount, 2) : "Free") : "—"}
              {card.fee?.firstYearWaived && <span className="sub">1st year waived</span>}</dd></div>
            <div><dt>Min income</dt><dd>{card.income ? `${fmtMoney(card.income)}/yr` : "—"}</dd></div>
          </dl>
          <div className="detail-actions">
            <button type="button" className={`btn ${isMine ? "" : "primary"}`}
              onClick={() => (isMine ? remove(card.id) : add(card))}>
              <Star size={16} fill={isMine ? "currentColor" : "none"} /> {isMine ? "In my cards" : "Add to my cards"}
            </button>
            {card.url && <a className="btn ghost" href={card.url} target="_blank" rel="noreferrer">Bank page <ExternalLink size={14} /></a>}
          </div>
        </div>
      </div>

      {card.status !== "reviewed" && (
        <p className="callout warn"><Info size={16} aria-hidden />
          <span>These details were compiled automatically from aggregators and bank T&Cs and haven't been checked by a
            person yet. Treat the rates as “up to” figures and confirm them in the official T&Cs.</span></p>
      )}

      <h3 className="section-title">How it earns</h3>
      <ul className="rules">
        {rules.map((r) => {
          const cap = spendCap(r);
          const period = capPeriod(r);
          const pct = effectivePct(r, cpm);
          return (
            <li key={r.id} className={r.tier}>
              <div className="rule-rate">
                <span className="big">{fmtRate(r)}</span>
                {r.unit === "mpd" && pct != null && <span className="sub">≈ {pct.toFixed(1)}%</span>}
              </div>
              <div className="rule-body">
                <p className="rule-label">{r.tier === "base" ? "Everything else" : r.label}</p>
                {r.desc && r.tier === "bonus" && <p className="rule-desc">{r.desc}</p>}
                <p className="rule-meta">
                  {r.minSpend != null && <span>Min {fmtMoney(r.minSpend)}{r.minSpendPeriod ? PERIOD_SHORT[r.minSpendPeriod] : ""}</span>}
                  {Number.isFinite(cap)
                    ? <span>Bonus on first {fmtMoney(cap)}{period ? PERIOD_SHORT[period] : ""}</span>
                    : r.tier === "bonus" && <span>No cap listed</span>}
                  {r.modes.length > 0 && <span>{r.modes.map((m) => MODE_LABEL[m] ?? m).join(" / ")} only</span>}
                </p>
              </div>
            </li>
          );
        })}
        {rules.length === 0 && <li className="muted">No earn rates on file yet.</li>}
      </ul>

      {offers.length > 0 && (
        <>
          <h3 className="section-title"><Gift size={16} aria-hidden /> Sign-up offers</h3>
          <ul className="offers">
            {offers.map((b, i) => {
              const head = bonusHeadline(b, cpm);
              return (
                <li key={i}>
                  <p className="offer-head"><strong>{head.big}</strong>{head.sub && <span className="sub"> {head.sub}</span>}</p>
                  <p className="sub">{b.title ?? "Offer"} via {OFFERED_BY[b.by] ?? b.by}{b.validTo ? ` · until ${fmtDate(b.validTo, true)}` : ""}
                    {b.url && <> · <a href={b.url} target="_blank" rel="noreferrer">terms</a></>}</p>
                  <p className="pills">
                    {b.minSpend != null && <span className="pill">Spend {fmtMoney(b.minSpend)}{b.withinDays ? ` ${withinLabel(b.withinDays)}` : ""}</span>}
                    {b.newToBank && <span className="pill">New to {card.bank} only</span>}
                    {b.stackable === true && <span className="pill good">Stacks with bank offer</span>}
                    {b.stackable === false && <span className="pill">Doesn't stack</span>}
                  </p>
                  {b.options.length > 1 && (
                    <details className="offer-more">
                      <summary>Choose from {b.options.length} gifts</summary>
                      <ul>{b.options.map((o) => <li key={o}>{o}</li>)}</ul>
                    </details>
                  )}
                  {b.terms && (
                    <details className="offer-more">
                      <summary>Qualifying terms</summary>
                      <p>{b.terms}</p>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <h3 className="section-title"><StickyNote size={16} aria-hidden /> My notes</h3>
      <NoteField value={note} placeholder="e.g. applied 3 Mar, waiting for card; good for Grab rides"
        onChange={(v) => update((s) => {
          const notes = { ...s.notes };
          if (v) notes[card.id] = v; else delete notes[card.id];
          return { ...s, notes };
        })} />

      {card.notes.length > 0 && (
        <details className="fine-print">
          <summary>Fine print & review notes</summary>
          <ul>{card.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        </details>
      )}
      {official.length > 0 && (
        <details className="fine-print">
          <summary>Official documents ({official.length})</summary>
          <ul>{official.map((s) => <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer">{s.title ?? new URL(s.url).pathname.split("/").pop()}</a></li>)}</ul>
        </details>
      )}
    </Sheet>
  );
}
