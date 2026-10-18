import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, X } from "lucide-react";

// A short guided tour of the main screen. Shown once per device (a per-device convenience, so it lives in
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
  /** Comma-separated selectors; the first visible match is highlighted. None (or no match) centres the card. */
  target?: string;
  /** Used instead when `target` isn't on screen. */
  fallback?: { target: string; body: string };
}

const STEPS: Step[] = [
  {
    title: "Welcome to pocket aces",
    body: "Pick the right Singapore credit card, then keep on top of the ones you hold. Here's a 30-second tour.",
  },
  {
    title: "Compare cards",
    body: "Switch between ongoing earn rates and sign-up bonuses, and narrow to miles, cashback or points.",
    target: ".cards-page .filters",
  },
  {
    title: "Rank by what you spend on",
    body: "Pick a category, like dining or online, to see which cards earn the most there.",
    target: ".cards-page .chips",
  },
  {
    title: "See the details",
    body: "Tap a card for its full rates, caps, exclusions and links to the bank's terms.",
    target: ".cards-page .card-row .row-main",
    fallback: {
      target: ".cards-page .switches",
      body: "Turn off “Verified only” to list every card, then tap one for its full rates, caps, exclusions and links to the bank's terms.",
    },
  },
  {
    title: "Star the cards you hold",
    body: "Starred cards move to the top and into your Wallet.",
    target: ".cards-page .card-row .star",
  },
  {
    title: "Your Wallet",
    body: "Track bill due dates, annual fee waivers and spend towards minimums and caps. It also suggests which card to use next.",
    target: ".topnav [data-tour=wallet], .bottomnav [data-tour=wallet]",
  },
  {
    title: "Settings",
    body: "Turn on reminders, install the app on your phone, back up your data or sync across devices.",
    target: ".topnav [data-tour=settings], .bottomnav [data-tour=settings]",
  },
  {
    title: "Need a refresher?",
    body: "Tap the help button any time to replay this tour.",
    target: "[data-tour=help]",
  },
];

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
  const [rect, setRect] = useState<Rect | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // Resolved per step, so a fallback can swap in when e.g. a filter leaves the card list empty.
  const [step, target] = useMemo(() => {
    const s = STEPS[i];
    const el = findTarget(s.target);
    if (el || !s.fallback) return [s, el] as const;
    return [{ ...s, body: s.fallback.body }, findTarget(s.fallback.target)] as const;
  }, [i]);
  const last = i === STEPS.length - 1;

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
  }, [rect, i]);

  useEffect(() => { cardRef.current?.focus(); }, [i]);

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
