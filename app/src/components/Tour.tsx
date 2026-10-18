import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, X } from "lucide-react";

// A short guided tour, mostly of the Wallet: a quick look at picking cards, then what the app does with the ones
// you hold. Steps switch tabs as they go. Shown once per device (a per-device convenience, so it lives in
// localStorage rather than the synced UserState) and replayable from the help button in the top bar.

const SEEN_KEY = "pocketaces:tour-seen";

export function tourSeen(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === "1"; } catch { return false; }
}
function markSeen() {
  try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* private mode etc.: the tour just shows again */ }
}

interface Step {
  title: string;
  body: string;
  /** Tab to show for this step (via the URL hash, as the nav does). None leaves the current tab. */
  tab?: "cards" | "wallet" | "settings";
  /** Comma-separated selectors; the first visible match is highlighted. None (or no match) centres the card. */
  target?: string;
  /** Used instead when `target` isn't on screen. */
  fallback?: { target: string; body: string };
}

// Most wallet steps point at a card tile, which a new user won't have yet: their bodies have to read fine
// centred over the empty wallet too.
const STEPS: Step[] = [
  {
    title: "Welcome to pocket aces",
    body: "Pick the right Singapore credit card, then keep on top of the ones you hold: bills, annual fees and spend. Here's a quick tour.",
  },
  {
    title: "Find your next card",
    body: "Rank cards by what you spend on, like dining or online. Tap one for its full rates, caps and the bank's terms.",
    tab: "cards",
    target: ".cards-page .chips",
    fallback: {
      target: ".cards-page .filters",
      body: "Compare ongoing earn rates or sign-up bonuses, then tap a card for its full rates, caps and the bank's terms.",
    },
  },
  {
    title: "Star the cards you hold",
    body: "Starring a card adds it to your Wallet, where the rest of the app does its work.",
    tab: "cards",
    target: ".cards-page .card-row .star",
  },
  {
    title: "Your Wallet",
    body: "Everything about the cards you hold lives here. The badge counts bills and fees that need you.",
    tab: "wallet",
    target: ".topnav [data-tour=wallet], .bottomnav [data-tour=wallet]",
  },
  {
    title: "Add your cards",
    body: "Add cards from the catalogue, or as a custom card if yours isn't listed.",
    tab: "wallet",
    target: ".wallet-page .head-actions .btn.primary, .page .empty .btn.primary",
  },
  {
    title: "Bills and annual fees",
    body: "Tap the pencil on a card to set its statement, due and annual fee dates. Tick bills off as paid and fees as waived; they roll over to the next one by themselves. Miles cards also track when points expire.",
    tab: "wallet",
    target: ".wallet-page .tile",
  },
  {
    title: "Heads up",
    body: "Bills coming due and fees to get waived show up here, with one-tap Paid and Waived buttons.",
    tab: "wallet",
    target: ".wallet-page .heads-up",
  },
  {
    title: "Track your spend",
    body: "Log purchases as you go, or type in the running total from your banking app. The bar shows how close you are to a card's min spend and bonus cap, and resets each month or statement as its T&Cs say.",
    tab: "wallet",
    target: ".wallet-page .tile-row.spend",
  },
  {
    title: "Which card next?",
    body: "Once cards have a min spend or cap, they're ranked by which to use next: unlock a minimum first, and skip cards that are capped.",
    tab: "wallet",
    target: ".wallet-page .guide",
  },
  {
    title: "Add to your calendar",
    body: "Download bill and annual fee reminders as a calendar file for your phone or laptop.",
    tab: "wallet",
    target: ".wallet-page .head-actions .btn.ghost",
  },
  {
    title: "Reminders and sync",
    body: "In Settings, turn on notifications, install the app on your phone, back up your wallet or sync it across devices.",
    target: ".topnav [data-tour=settings], .bottomnav [data-tour=settings]",
  },
  {
    title: "Need a refresher?",
    body: "Tap the help button any time to replay this tour.",
    target: "[data-tour=help]",
  },
];

/** Frames to wait for a newly switched tab to render its target before giving up on it. */
const TAB_FRAMES = 20;

const PAD = 6;
const GAP = 12;
const EDGE = 12;

function findTarget(sel?: string): HTMLElement | null {
  if (!sel) return null;
  for (const el of document.querySelectorAll<HTMLElement>(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

type Rect = { top: number; left: number; width: number; height: number };

/** Mount only while showing; unmounting resets it to the first step. */
export function Tour({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const [shown, setShown] = useState<{ step: Step; target: HTMLElement | null }>({ step: STEPS[0], target: null });
  const [rect, setRect] = useState<Rect | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const { step, target } = shown;
  const last = i === STEPS.length - 1;

  // Resolved per step, so a fallback can swap in when e.g. the wallet is still empty. A step on another tab
  // switches to it first; that tab renders after the hashchange, so keep looking for a few frames.
  useEffect(() => {
    const s = STEPS[i];
    let frames = 0;
    if (s.tab && location.hash.slice(1) !== s.tab) {
      location.hash = s.tab;
      frames = TAB_FRAMES;
    }
    let raf = 0;
    const resolve = () => {
      const el = findTarget(s.target);
      if (!el && frames-- > 0) { raf = requestAnimationFrame(resolve); return; }
      if (el || !s.fallback) setShown({ step: s, target: el });
      else setShown({ step: { ...s, body: s.fallback.body }, target: findTarget(s.fallback.target) });
    };
    raf = requestAnimationFrame(resolve);
    return () => cancelAnimationFrame(raf);
  }, [i]);

  const close = useCallback(() => { markSeen(); onClose(); }, [onClose]);

  // Find, scroll to and track the highlighted element.
  useEffect(() => {
    const el = target;
    el?.scrollIntoView({ block: "center", inline: "nearest" });
    const measure = () => {
      const r = el?.isConnected ? el.getBoundingClientRect() : null;
      setRect(r ? { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 } : null);
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [target]);

  // Place the card below the highlight, else above, else pinned to the bottom of the screen.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const { width: cw, height: ch } = card.getBoundingClientRect();
    if (!rect) { setPos({ top: (vh - ch) / 2, left: (vw - cw) / 2 }); return; }
    const left = Math.min(Math.max(rect.left + rect.width / 2 - cw / 2, EDGE), vw - cw - EDGE);
    const below = rect.top + rect.height + GAP;
    const above = rect.top - GAP - ch;
    const top = below + ch <= vh - EDGE ? below : above >= EDGE ? above : vh - ch - EDGE;
    setPos({ top, left });
  }, [rect, step]);

  useEffect(() => { cardRef.current?.focus(); }, [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") setI((n) => Math.min(n + 1, STEPS.length - 1));
      else if (e.key === "ArrowLeft") setI((n) => Math.max(n - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div className="tour">
      {/* swallow clicks so the page underneath can't be changed mid-tour */}
      <div className={`tour-block ${rect ? "" : "dim"}`} />
      {rect && <div className="tour-spot" style={rect} aria-hidden />}
      <div ref={cardRef} className="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title"
        aria-describedby="tour-body" tabIndex={-1} style={pos ?? { visibility: "hidden" }}>
        <div className="tour-head">
          <span className="tour-step">{i + 1} of {STEPS.length}</span>
          <button type="button" className="icon-btn" onClick={close} aria-label="Close tour"><X size={18} /></button>
        </div>
        <h2 id="tour-title">{step.title}</h2>
        <p id="tour-body">{step.body}</p>
        <div className="tour-foot">
          <div className="tour-dots" aria-hidden>
            {STEPS.map((_, n) => <span key={n} className={n === i ? "on" : ""} />)}
          </div>
          <div className="tour-nav">
            {i > 0
              ? <button type="button" className="btn small ghost" onClick={() => setI(i - 1)}><ArrowLeft size={14} /> Back</button>
              : <button type="button" className="btn small ghost" onClick={close}>Skip</button>}
            {last
              ? <button type="button" className="btn small primary" onClick={close}>Done</button>
              : <button type="button" className="btn small primary" onClick={() => setI(i + 1)}>Next <ArrowRight size={14} /></button>}
          </div>
        </div>
      </div>
    </div>
  );
}
