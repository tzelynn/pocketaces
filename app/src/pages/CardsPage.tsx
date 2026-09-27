import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Layers, Search, Star, StickyNote } from "lucide-react";
import type { CatalogCard, RewardKind, Rule } from "../types";
import { useUser } from "../lib/store";
import {
  capPeriod, effectivePct, fmtMoney, fmtRate, hasMinSpend, headlineRule, minSpend, PERIOD_SHORT, spendCap,
} from "../lib/catalog";
import { CardArt, CATEGORY_ICONS, Empty, NoteField, REWARD_ICONS, RewardBadge, Segmented } from "../components/ui";
import { CardDetail } from "../components/CardDetail";
import { useWalletActions } from "../lib/wallet";

type Kind = "all" | RewardKind;
type MinFilter = "any" | "none" | "has";
type SortKey = "value" | "cap" | "min" | "fee" | "name";

const SORTS: { key: SortKey; label: string; defaultDir: 1 | -1 }[] = [
  { key: "value", label: "Reward value", defaultDir: -1 },
  { key: "cap", label: "Spend cap", defaultDir: -1 },
  { key: "min", label: "Min spend", defaultDir: 1 },
  { key: "fee", label: "Annual fee", defaultDir: 1 },
  { key: "name", label: "Name", defaultDir: 1 },
];

interface Row { card: CatalogCard; rule: Rule | null; value: number | null; cap: number; min: number }

export function CardsPage() {
  const { catalog, catalogError, state, update } = useUser();
  const { add, remove, owned } = useWalletActions();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [minF, setMinF] = useState<MinFilter>("any");
  const [tag, setTag] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("value");
  const [dir, setDir] = useState<1 | -1>(-1);
  const [open, setOpen] = useState<string | null>(null);

  const cpm = state.settings.centsPerMile;
  const cats = catalog?.categories ?? [];
  const topCats = cats.filter((c) => !c.parent);
  const activeGroup = tag ? cats.find((c) => c.key === tag)?.parent ?? (cats.find((c) => c.key === tag)?.group ? tag : null) : null;
  const subCats = activeGroup ? cats.filter((c) => c.parent === activeGroup) : [];

  const rows = useMemo(() => {
    if (!catalog) return [];
    const needle = q.trim().toLowerCase();
    const out: Row[] = [];
    for (const card of catalog.cards) {
      if (kind !== "all" && card.kind !== kind) continue;
      if (minF === "none" && hasMinSpend(card)) continue;
      if (minF === "has" && !hasMinSpend(card)) continue;
      if (tag && !card.coverage[tag]) continue;
      if (needle && !`${card.name} ${card.bank}`.toLowerCase().includes(needle)) continue;
      const rule = headlineRule(card, tag);
      out.push({ card, rule, value: rule ? effectivePct(rule, cpm) : null, cap: rule ? spendCap(rule) : Infinity, min: minSpend(rule) });
    }
    const key = (r: Row): number | string => {
      switch (sort) {
        case "value": return r.value ?? -Infinity;
        case "cap": return r.cap;
        case "min": return r.min;
        case "fee": return r.card.fee?.amount ?? Infinity;
        case "name": return r.card.name.toLowerCase();
      }
    };
    return out.sort((a, b) => {
      const ka = key(a), kb = key(b);
      // cards that can't be valued (points) always sink, whichever direction
      if (sort === "value" && (a.value == null) !== (b.value == null)) return a.value == null ? 1 : -1;
      if (ka === kb) return a.card.name.localeCompare(b.card.name);
      return (ka < kb ? -1 : 1) * dir;
    });
  }, [catalog, q, kind, minF, tag, sort, dir, cpm]);

  const mine = rows.filter((r) => owned.has(r.card.id));
  const rest = rows.filter((r) => !owned.has(r.card.id));
  const setNote = (id: string, v: string) =>
    update((s) => {
      const notes = { ...s.notes };
      if (v) notes[id] = v; else delete notes[id];
      return { ...s, notes };
    });

  if (catalogError) return <Empty icon={Layers} title="Couldn't load the card list">{catalogError}</Empty>;
  if (!catalog) return <div className="loading">Shuffling the deck…</div>;

  const openCard = open ? catalog.cards.find((c) => c.id === open) ?? null : null;

  const renderRow = (r: Row) => {
    const { card, rule } = r;
    const isMine = owned.has(card.id);
    const note = state.notes[card.id] ?? "";
    const period = rule ? capPeriod(rule) : null;
    return (
      <li key={card.id} className={`card-row ${isMine ? "mine" : ""}`}>
        <button type="button" className="row-main" onClick={() => setOpen(card.id)}>
          <CardArt src={card.image} name={card.name} small />
          <span className="row-name">
            <span className="name">{card.name}</span>
            <span className="bank">
              {card.bank}
              {card.status !== "reviewed" && <span className="tag-unverified" title="Not yet checked against the official T&Cs">unverified</span>}
            </span>
          </span>
        </button>
        <div className="cell reward">
          <RewardBadge kind={card.kind} />
          <div>
            <div className="big">{rule ? fmtRate(rule) : "—"}</div>
            <div className="sub">
              {rule?.unit === "mpd" && r.value != null ? `≈ ${r.value.toFixed(1)}% value` : rule?.unit === "points_per_dollar" ? "value varies" : rule?.label}
            </div>
          </div>
        </div>
        <div className="cell c-min" data-label="Min">
          {r.min ? <><span className="big">{fmtMoney(r.min)}</span><span className="sub">{PERIOD_SHORT[rule?.minSpendPeriod ?? "statement_month"]}</span></> : <span className="muted">None</span>}
        </div>
        <div className="cell c-cap" data-label="Cap">
          {Number.isFinite(r.cap)
            ? <><span className="big">{fmtMoney(r.cap)}</span><span className="sub">{period ? PERIOD_SHORT[period] : ""} spend</span></>
            : <span className="muted">Uncapped</span>}
        </div>
        <div className="cell c-fee" data-label="Fee">
          {card.fee ? <><span className="big">{card.fee.amount ? fmtMoney(card.fee.amount) : "Free"}</span>{card.fee.firstYearWaived && <span className="sub">1st yr free</span>}</> : <span className="muted">—</span>}
        </div>
        <div className="cell notes-cell">
          <NoteField compact value={note} onChange={(v) => setNote(card.id, v)} />
        </div>
        {note && <p className="note-peek" onClick={() => setOpen(card.id)}><StickyNote size={13} aria-hidden /> {note}</p>}
        <button type="button" className={`star ${isMine ? "on" : ""}`} aria-pressed={isMine}
          aria-label={isMine ? "Remove from my cards" : "Add to my cards"} title={isMine ? "In my cards" : "Add to my cards"}
          onClick={() => (isMine ? remove(card.id) : add(card))}>
          <Star size={18} fill={isMine ? "currentColor" : "none"} />
        </button>
      </li>
    );
  };

  return (
    <div className="page cards-page">
      <div className="toolbar">
        <label className="search">
          <Search size={16} aria-hidden />
          <input type="search" placeholder="Search cards or banks" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="filters">
          <Segmented label="Reward type" value={kind} onChange={setKind} options={[
            { value: "all", label: "All" },
            { value: "miles", label: "Miles", icon: REWARD_ICONS.miles },
            { value: "cashback", label: "Cashback", icon: REWARD_ICONS.cashback },
            { value: "points", label: "Points", icon: REWARD_ICONS.points },
          ]} />
          <Segmented label="Minimum spend" value={minF} onChange={setMinF} options={[
            { value: "any", label: "Any min spend" },
            { value: "none", label: "No min" },
            { value: "has", label: "Has min" },
          ]} />
          <div className="sort">
            <label>
              <span className="sr-only">Sort by</span>
              <select value={sort} onChange={(e) => {
                const k = e.target.value as SortKey;
                setSort(k);
                setDir(SORTS.find((s) => s.key === k)!.defaultDir);
              }}>
                {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </label>
            <button type="button" className="icon-btn" onClick={() => setDir((d) => (d === 1 ? -1 : 1))}
              aria-label={dir === 1 ? "Ascending" : "Descending"} title={dir === 1 ? "Ascending" : "Descending"}>
              {dir === 1 ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
            </button>
          </div>
        </div>
        <div className="chips" role="group" aria-label="Spend category">
          <button type="button" className={`chip ${!tag ? "on" : ""}`} onClick={() => setTag(null)}>All spend</button>
          {topCats.map((c) => {
            const Icon = CATEGORY_ICONS[c.key];
            const on = tag === c.key || activeGroup === c.key;
            return (
              <button key={c.key} type="button" className={`chip ${on ? "on" : ""}`}
                onClick={() => setTag(tag === c.key ? null : c.key)}>
                {Icon && <Icon size={14} aria-hidden />}{c.label}
              </button>
            );
          })}
        </div>
        {subCats.length > 0 && (
          <div className="chips sub" role="group" aria-label="Narrow category">
            {subCats.map((c) => {
              const Icon = CATEGORY_ICONS[c.key];
              return (
                <button key={c.key} type="button" className={`chip small ${tag === c.key ? "on" : ""}`}
                  onClick={() => setTag(tag === c.key ? activeGroup : c.key)}>
                  {Icon && <Icon size={13} aria-hidden />}{c.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="table-head" aria-hidden>
        <span>Card</span><span>{tag ? "Rate here" : "Top rate"}</span><span>Min spend</span><span>Bonus cap</span>
        <span>Annual fee</span><span>My notes</span><span />
      </div>

      {mine.length > 0 && (
        <section aria-label="My cards">
          <h3 className="list-label"><Star size={14} fill="currentColor" aria-hidden /> My cards</h3>
          <ul className="card-list">{mine.map(renderRow)}</ul>
        </section>
      )}
      <section aria-label="All cards">
        <h3 className="list-label">{mine.length ? "Everything else" : "All cards"} <span className="count">{rest.length}</span></h3>
        {rows.length === 0
          ? <Empty icon={Layers} title="No cards match">Try loosening a filter or two.</Empty>
          : <ul className="card-list">{rest.map(renderRow)}</ul>}
      </section>

      <p className="fine">
        Miles are valued at {cpm}¢ each (change it in Settings). Rates are headline “up to” figures from aggregators and
        bank T&Cs, and all cards are still <em>unverified</em>. Check the card's T&Cs before you apply. Data as of {new Date(catalog.builtAt).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" })}.
      </p>

      <CardDetail card={openCard} onClose={() => setOpen(null)} />
    </div>
  );
}
