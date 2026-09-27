import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, CircleHelp, Gift, Layers, Percent, Search, Star, StickyNote } from "lucide-react";
import type { Bonus, CatalogCard, RewardKind, Rule } from "../types";
import { useUser } from "../lib/store";
import {
  activeBonuses, bonusHeadline, bonusValue, capPeriod, isFlashDeal, OFFERED_BY, effectivePct, fmtMoney, fmtRate, hasMinSpend, minSpend,
  PERIOD_SHORT, rateRules, spendCap, withinLabel,
} from "../lib/catalog";
import { daysBetween, fmtDate, today } from "../lib/dates";
import {
  CardArt, CATEGORY_ICONS, Empty, EXCLUSION_ICONS, MODE_ICONS, NoteField, REWARD_ICONS, RewardBadge, Segmented, TagIcons,
} from "../components/ui";
import { CardDetail } from "../components/CardDetail";
import { useWalletActions } from "../lib/wallet";

type Kind = "all" | RewardKind;
/** The list shows either ongoing earn rates or sign-up offers, in the same columns. */
type View = "rates" | "bonus";
type SortKey = "value" | "cap" | "min" | "fee" | "name" | "bonus" | "ends";

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const SORTS: Record<View, { key: SortKey; label: string; defaultDir: 1 | -1 }[]> = {
  rates: [
    { key: "value", label: "Reward value", defaultDir: -1 },
    { key: "cap", label: "Spend cap", defaultDir: -1 },
    { key: "min", label: "Min spend", defaultDir: 1 },
    { key: "fee", label: "Annual fee", defaultDir: 1 },
    { key: "name", label: "Name", defaultDir: 1 },
  ],
  bonus: [
    { key: "bonus", label: "Bonus value", defaultDir: -1 },
    { key: "min", label: "Min spend", defaultDir: 1 },
    { key: "ends", label: "Ending soonest", defaultDir: 1 },
    { key: "fee", label: "Annual fee", defaultDir: 1 },
    { key: "name", label: "Name", defaultDir: 1 },
  ],
};

const HEADINGS: Record<View, string[]> = {
  rates: ["Reward rate", "Earns on", "Min spend", "Bonus cap"],
  bonus: ["Sign-up bonus", "Who qualifies", "Min spend", "Offer ends"],
};

/**
 * One card. Rates view: `rules` are its reward-rate rows, best first; min spend and cap follow the first.
 * Bonus view: `offers` are its open sign-up offers, best first; `value`, `min` and `ends` rank the card.
 */
interface Row {
  card: CatalogCard; rules: Rule[]; rule: Rule | null; offers: Bonus[];
  value: number | null; cap: number; min: number; ends: string;
}

export function CardsPage() {
  const { catalog, catalogError, state, update } = useUser();
  const { add, remove, owned } = useWalletActions();
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>("rates");
  const [kind, setKind] = useState<Kind>("all");
  const [noMinOnly, setNoMinOnly] = useState(false);
  const [tag, setTag] = useState<string | null>(null);
  const [verifiedOnly, setVerifiedOnly] = useState(true);
  const [sort, setSort] = useState<SortKey>("value");
  const [dir, setDir] = useState<1 | -1>(-1);
  const [open, setOpen] = useState<string | null>(null);
  // bonus view: cards showing all their offers rather than just the best
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const cpm = state.settings.centsPerMile;
  const on = today();
  const bonusView = view === "bonus";
  const cats = catalog?.categories ?? [];
  const topCats = cats.filter((c) => !c.parent);
  const activeGroup = tag ? cats.find((c) => c.key === tag)?.parent ?? (cats.find((c) => c.key === tag)?.group ? tag : null) : null;
  const subCats = activeGroup ? cats.filter((c) => c.parent === activeGroup) : [];
  const catLabel = useMemo(() => Object.fromEntries(cats.map((c) => [c.key, c.label])), [cats]);
  const exclLabel = useMemo(() => Object.fromEntries((catalog?.exclusions ?? []).map((c) => [c.key, c.label])), [catalog]);
  // the key lists only icons that some card actually shows
  const keyIncludes = useMemo(() => {
    const used = new Set(catalog?.cards.flatMap((c) => c.rules.flatMap((r) => r.includes)));
    return cats.filter((c) => used.has(c.key));
  }, [catalog, cats]);
  const keyCats = keyIncludes.filter((c) => !(c.key in MODE_ICONS));
  const keyModes = keyIncludes.filter((c) => c.key in MODE_ICONS);

  const rows = useMemo(() => {
    if (!catalog) return [];
    const needle = q.trim().toLowerCase();
    const out: Row[] = [];
    for (const card of catalog.cards) {
      // cards you hold stay listed even while unverified
      if (verifiedOnly && card.status !== "reviewed" && !owned.has(card.id)) continue;
      if (kind !== "all" && card.kind !== kind) continue;
      if (needle && !`${card.name} ${card.bank}`.toLowerCase().includes(needle)) continue;
      if (bonusView) {
        // sign-up offers aren't tied to a spend category, so the category and min-spend filters don't apply
        const offers = activeBonuses(card, on, cpm);
        if (!offers.length) continue;
        const mins = offers.map((b) => b.minSpend).filter((n): n is number => n != null);
        out.push({
          card, rules: [], rule: null, offers, value: bonusValue(offers[0], cpm), cap: Infinity,
          min: mins.length ? Math.min(...mins) : Infinity,
          ends: offers.map((b) => b.validTo ?? "9999").sort()[0],
        });
        continue;
      }
      if (noMinOnly && hasMinSpend(card)) continue;
      if (tag && !card.rules.some((r) => r.tags.includes(tag))) continue;
      const rules = rateRules(card, tag);
      const rule = rules[0] ?? null;
      out.push({
        card, rules, rule, offers: [], value: rule ? effectivePct(rule, cpm) : null,
        cap: rule ? spendCap(rule) : Infinity, min: minSpend(rule), ends: "",
      });
    }
    const key = (r: Row): number | string => {
      switch (sort) {
        case "value": case "bonus": return r.value ?? -Infinity;
        case "cap": return r.cap;
        case "min": return r.min;
        case "ends": return r.ends;
        case "fee": return r.card.fee?.amount ?? Infinity;
        case "name": return r.card.name.toLowerCase();
      }
    };
    return out.sort((a, b) => {
      const ka = key(a), kb = key(b);
      // cards that can't be valued (points, gifts with no stated worth) always sink, whichever direction
      if ((sort === "value" || sort === "bonus") && (a.value == null) !== (b.value == null)) return a.value == null ? 1 : -1;
      if (ka === kb) return a.card.name.localeCompare(b.card.name);
      return (ka < kb ? -1 : 1) * dir;
    });
  }, [catalog, q, kind, noMinOnly, tag, sort, dir, cpm, verifiedOnly, owned, bonusView, on]);

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

  const keyButton = (
    <button type="button" className="key-btn" popoverTarget="icon-key">
      <CircleHelp size={14} aria-hidden /> Icon key
    </button>
  );

  const changeView = (v: View) => {
    setView(v);
    setSort(SORTS[v][0].key);
    setDir(SORTS[v][0].defaultDir);
  };

  const renderOffer = (card: CatalogCard, b: Bonus, i: number) => {
    const head = bonusHeadline(b, cpm);
    const left = b.validTo ? daysBetween(on, b.validTo) : null;
    return (
      <div key={i} className="rate-row">
        <div className="cell reward">
          <span className={`reward-badge bonus ${i > 0 ? "spacer" : ""}`} aria-hidden><Gift size={15} /></span>
          <div title={b.options.join("\n")}>
            <div className={head.text ? "big text" : "big"}>{head.big}</div>
            {head.sub && <div className="sub">{head.sub}</div>}
          </div>
        </div>
        <div className="cell c-in">
          <span className="sub" title={b.title ?? undefined}>via {OFFERED_BY[b.by] ?? b.by}</span>
          <span className="pills">
            {isFlashDeal(b) && <span className="pill warn" title="Only the first few applicants each day get this; the rest get the regular offer">Flash deal</span>}
            {b.newToBank && <span className="pill" title={`Only for customers new to ${card.bank}`}>New to bank</span>}
            {b.stackable === true && <span className="pill good" title="Can be combined with the bank's own welcome offer">Stacks</span>}
            {b.stackable === false && <span className="pill" title="Can't be combined with other welcome offers">No stacking</span>}
          </span>
        </div>
        <div className="cell c-min" data-label="Min spend">
          {b.minSpend != null
            ? <><span className="big">{fmtMoney(b.minSpend)}</span>{b.withinDays && <span className="sub">{withinLabel(b.withinDays)}</span>}</>
            : <span className="muted">See terms</span>}
        </div>
        <div className="cell c-cap" data-label="Ends">
          {b.validTo && left != null
            ? <><span className="big">{fmtDate(b.validTo)}</span>
                <span className={`sub ${left <= 7 ? "warn-text" : ""}`}>{left === 0 ? "last day" : `${left} day${left > 1 ? "s" : ""} left`}</span></>
            : <span className="muted">Not stated</span>}
        </div>
      </div>
    );
  };

  const renderRow = (r: Row) => {
    const { card, rule } = r;
    const isMine = owned.has(card.id);
    const note = state.notes[card.id] ?? "";
    const period = rule ? capPeriod(rule) : null;
    return (
      <li key={card.id} className={`card-row ${isMine ? "mine" : ""} ${bonusView ? "bonus-view" : ""}`}>
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
        {bonusView ? (
          <div className="rates offer-rows">
            {(expanded.has(card.id) ? r.offers : r.offers.slice(0, 1)).map((b, i) => renderOffer(card, b, i))}
            {r.offers.length > 1 && (
              <button type="button" className="more-offers" aria-expanded={expanded.has(card.id)} onClick={() => setExpanded((s) => {
                const next = new Set(s);
                if (!next.delete(card.id)) next.add(card.id);
                return next;
              })}>
                {expanded.has(card.id) ? "Show best offer only" : `+${r.offers.length - 1} more offer${r.offers.length > 2 ? "s" : ""}`}
              </button>
            )}
          </div>
        ) : <>
        <div className="rates">
          {r.rules.length ? r.rules.map((x, i) => (
            <div key={x.id} className="rate-row">
              <div className="cell reward">
                <RewardBadge kind={card.kind} hidden={i > 0} />
                <div>
                  <div className="big">{fmtRate(x)}</div>
                  {x.unit !== "percent" && (
                    <div className="sub">{x.unit === "mpd" ? `≈ ${effectivePct(x, cpm)!.toFixed(1)}% value` : "value varies"}</div>
                  )}
                </div>
              </div>
              <div className="cell c-in">
                {x.includes.length
                  ? <TagIcons keys={x.includes} labels={catLabel} tone="in" />
                  : <span className="muted">{x.tier === "base" || x.allSpend ? "All spend" : sentence(x.label) || "Not stated"}</span>}
              </div>
            </div>
          )) : <div className="rate-row"><div className="cell reward"><RewardBadge kind={card.kind} /><div className="big">—</div></div></div>}
        </div>
        <div className="cell c-min" data-label="Min">
          {r.min ? <><span className="big">{fmtMoney(r.min)}</span><span className="sub">{PERIOD_SHORT[rule?.minSpendPeriod ?? "statement_month"]}</span></> : <span className="muted">None</span>}
        </div>
        <div className="cell c-cap" data-label="Cap">
          {Number.isFinite(r.cap)
            ? <><span className="big">{fmtMoney(r.cap)}</span><span className="sub">{period ? PERIOD_SHORT[period] : ""} spend</span></>
            : <span className="muted">Uncapped</span>}
        </div>
        </>}
        <div className="cell c-fee" data-label="Fee">
          {card.fee ? <><span className="big">{card.fee.amount ? fmtMoney(card.fee.amount) : "Free"}</span>{card.fee.firstYearWaived && <span className="sub">1st yr free</span>}</> : <span className="muted">—</span>}
        </div>
        <div className="cell c-out" data-label="Excludes">
          {card.excludes.length
            ? <TagIcons keys={card.excludes} labels={exclLabel} tone="out" />
            : <span className="muted">Not stated</span>}
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
          <Segmented label="Show" value={view} onChange={changeView} options={[
            { value: "rates", label: "Earn rates", icon: Percent },
            { value: "bonus", label: "Sign-up bonus", icon: Gift },
          ]} />
          <Segmented label="Reward type" value={kind} onChange={setKind} options={[
            { value: "all", label: "All" },
            { value: "miles", label: "Miles", icon: REWARD_ICONS.miles },
            { value: "cashback", label: "Cashback", icon: REWARD_ICONS.cashback },
            { value: "points", label: "Points", icon: REWARD_ICONS.points },
          ]} />
          <div className="switches">
            {!bonusView && (
              <label className="switch" title="Only cards whose bonus rate needs no minimum spend">
                <input type="checkbox" role="switch" checked={noMinOnly} onChange={(e) => setNoMinOnly(e.target.checked)} />
                <span>No min spend</span>
              </label>
            )}
            <label className="switch" title="Only cards checked against the official T&Cs">
              <input type="checkbox" role="switch" checked={verifiedOnly} onChange={(e) => setVerifiedOnly(e.target.checked)} />
              <span>Verified only</span>
            </label>
          </div>
          <div className="sort">
            <label>
              <span className="sr-only">Sort by</span>
              <select value={sort} onChange={(e) => {
                const k = e.target.value as SortKey;
                setSort(k);
                setDir(SORTS[view].find((s) => s.key === k)!.defaultDir);
              }}>
                {SORTS[view].map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </label>
            <button type="button" className="icon-btn" onClick={() => setDir((d) => (d === 1 ? -1 : 1))}
              aria-label={dir === 1 ? "Ascending" : "Descending"} title={dir === 1 ? "Ascending" : "Descending"}>
              {dir === 1 ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
            </button>
          </div>
        </div>
        {!bonusView && <>
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
        </>}
      </div>

      <div className={`table-head ${bonusView ? "bonus-view" : ""}`} aria-hidden>
        <span>Card</span>{HEADINGS[view].map((h) => <span key={h}>{h}</span>)}
        <span>Annual fee</span><span>Excludes</span><span>My notes</span><span />
      </div>

      {mine.length > 0 && (
        <section aria-label="My cards">
          <h3 className="list-label"><Star size={14} fill="currentColor" aria-hidden /> My cards {keyButton}</h3>
          <ul className="card-list">{mine.map(renderRow)}</ul>
        </section>
      )}
      <section aria-label="All cards">
        <h3 className="list-label">{mine.length ? "Everything else" : "All cards"} <span className="count">{rest.length}</span>
          {!mine.length && keyButton}</h3>
        {rest.length === 0
          ? verifiedOnly && !catalog.cards.some((c) => c.status === "reviewed")
            ? <Empty icon={Layers} title="No verified cards yet">
                None of the cards have been checked against the official T&Cs yet. Turn off <em>Verified only</em> to see them all.
              </Empty>
            : bonusView
              ? <Empty icon={Gift} title="No open sign-up offers">None of these cards has a sign-up offer running right now.</Empty>
              : <Empty icon={Layers} title="No cards match">Try loosening a filter or two.</Empty>
          : <ul className="card-list">{rest.map(renderRow)}</ul>}
      </section>

      <p className="fine">
        {bonusView && <>Sign-up offers come from SingSaver and Moneysmart listings, change often and are usually only
          for customers new to the bank. Bonus values are the best gift on offer: cash, a gift's stated worth (gifts
          needing a top-up aside) or miles. Open a card for the full terms. </>}
        Miles are valued at {cpm}¢ each (change it in Settings). Rates are headline “up to” figures from aggregators and
        bank T&Cs, and all cards are still <em>unverified</em>. Check the card's T&Cs before you apply. Data as of {new Date(catalog.builtAt).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" })}.
      </p>

      <div id="icon-key" className="icon-key" popover="auto" role="dialog" aria-label="Icon key">
        <h3>Icon key</h3>
        <p className="hint">Only categories the card's terms state outright. “Not stated” means none are listed, not that none apply.</p>
        <h4>Earns on</h4>
        <ul>
          {keyCats.map((c) => {
            const Icon = CATEGORY_ICONS[c.key];
            return <li key={c.key}><span className="tag-icon in">{Icon && <Icon size={13} strokeWidth={2.2} aria-hidden />}</span>{c.label}</li>;
          })}
        </ul>
        <h4>Transaction mode</h4>
        <ul>
          {keyModes.map((c) => {
            const Icon = MODE_ICONS[c.key];
            return <li key={c.key}><span className="tag-icon in mode">{Icon && <Icon size={13} strokeWidth={2.2} aria-hidden />}</span>{c.label}</li>;
          })}
        </ul>
        <h4>Excludes</h4>
        <ul>
          {catalog.exclusions.map((c) => {
            const Icon = EXCLUSION_ICONS[c.key];
            return <li key={c.key}><span className="tag-icon out">{Icon && <Icon size={13} strokeWidth={2.2} aria-hidden />}</span>{c.label}</li>;
          })}
        </ul>
      </div>

      <CardDetail card={openCard} onClose={() => setOpen(null)} />
    </div>
  );
}
