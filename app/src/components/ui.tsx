import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AppWindow, ArrowLeftRight, Armchair, Banknote, BedDouble, Bus, Car, CarTaxiFront, Clapperboard, Coffee, Coins, CreditCard, Dices, Fuel, Gem,
  Globe, GraduationCap, Hammer, HandHeart, HeartPulse, KeyRound, Landmark, Laptop, Luggage, MapPin, MonitorPlay,
  MousePointerClick, Nfc, Plane, PlaneTakeoff, Repeat, Ship, ShieldCheck, ShoppingBag, ShoppingBasket, Smartphone,
  SmartphoneNfc, Sofa, Sparkles, TrainFront, Utensils, X, Zap, type LucideIcon,
} from "lucide-react";
import type { RewardKind } from "../types";

/** Transaction modes (config/categories.yaml `transaction_modes`), shown outlined beside categories. */
export const MODE_ICONS: Record<string, LucideIcon> = {
  online: MousePointerClick, in_app: AppWindow, contactless: Nfc, mobile_wallet: SmartphoneNfc, chip_pin: KeyRound,
  recurring: Repeat, foreign_currency: Globe, local_currency: MapPin, overseas_in_sgd: ArrowLeftRight,
};

export const CATEGORY_ICONS: Record<string, LucideIcon> = {
  travel: Plane, flights: PlaneTakeoff, hotels: BedDouble, car_rental: Car, cruise: Ship,
  travel_agencies: Luggage, transport: Bus, ride_hailing: CarTaxiFront, public_transport: TrainFront,
  petrol: Fuel, dining: Utensils, groceries: ShoppingBasket, shopping: ShoppingBag, entertainment: Clapperboard,
  streaming_digital: MonitorPlay, telco: Smartphone, healthcare: HeartPulse, day_to_day: Coffee,
  big_ticket: Sofa, renovation: Hammer, furniture: Armchair, electronics: Laptop, jewellery: Gem,
  transaction_mode: CreditCard, ...MODE_ICONS,
};

export const EXCLUSION_ICONS: Record<string, LucideIcon> = {
  education: GraduationCap, government: Landmark, insurance: ShieldCheck, utilities: Zap, charity: HandHeart,
  financial: Banknote, gambling: Dices,
};

/** A row of small category icons, each labelled for hover and screen readers. */
export function TagIcons({ keys, labels, tone }: { keys: string[]; labels: Record<string, string>; tone: "in" | "out" }) {
  const icons = tone === "in" ? CATEGORY_ICONS : EXCLUSION_ICONS;
  return (
    <ul className={`tag-icons ${tone}`} aria-label={tone === "in" ? "Earns bonus on" : "Excluded from rewards"}>
      {keys.map((k) => {
        const Icon = icons[k] ?? CreditCard;
        const label = labels[k] ?? k;
        return <li key={k} title={label} className={k in MODE_ICONS ? "mode" : undefined}><Icon size={13} strokeWidth={2.2} aria-hidden /><span className="sr-only">{label}</span></li>;
      })}
    </ul>
  );
}

export const REWARD_ICONS: Record<RewardKind, LucideIcon> = { miles: Plane, cashback: Coins, points: Sparkles };
export const REWARD_LABEL: Record<RewardKind, string> = { miles: "Miles", cashback: "Cashback", points: "Points" };

/** `hidden` keeps the badge's space (to line up follow-on rate rows) without showing it. */
export function RewardBadge({ kind, hidden }: { kind: RewardKind; hidden?: boolean }) {
  const Icon = REWARD_ICONS[kind];
  if (hidden) return <span className="reward-badge spacer" aria-hidden />;
  return (
    <span className={`reward-badge ${kind}`} title={REWARD_LABEL[kind]}>
      <Icon size={14} aria-hidden />
      <span className="sr-only">{REWARD_LABEL[kind]}</span>
    </span>
  );
}

/** Card art from the aggregator, with a drawn fallback when it's missing or fails to load. */
export function CardArt({ src, name, small }: { src: string | null; name: string; small?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className={`card-art fallback ${small ? "small" : ""}`} aria-hidden>
        <CreditCard size={small ? 16 : 28} />
      </div>
    );
  }
  return (
    <img className={`card-art ${small ? "small" : ""}`} src={src} alt={name} loading="lazy"
      referrerPolicy="no-referrer" onError={() => setFailed(true)} />
  );
}

interface Option<T extends string> { value: T; label: ReactNode; icon?: LucideIcon }

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: Option<T>[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value}
          className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.icon && <o.icon size={14} aria-hidden />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Modal sheet: bottom sheet on phones, centred panel on wider screens. */
export function Sheet({ open, onClose, title, children, wide }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`sheet ${wide ? "wide" : ""}`} onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      {open && (
        <div className="sheet-inner">
          <header className="sheet-head">
            <h2>{title}</h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X size={20} /></button>
          </header>
          <div className="sheet-body">{children}</div>
        </div>
      )}
    </dialog>
  );
}

/** Spend progress with min-spend marker and cap as the end of the track. */
export function SpendBar({ spent, min, max }: { spent: number; min?: number; max?: number }) {
  const end = Math.max(max ?? 0, min ?? 0, spent) || 1;
  const pct = Math.min(100, (spent / end) * 100);
  const state = max && spent >= max ? "capped" : min && spent < min ? "below" : "ok";
  return (
    <div className={`spendbar ${state}`} role="img"
      aria-label={`Spent ${spent.toFixed(0)}${min ? `, min ${min}` : ""}${max ? `, cap ${max}` : ""}`}>
      <div className="fill" style={{ width: `${pct}%` }} />
      {min && max && min < end ? <div className="marker" style={{ left: `${(min / end) * 100}%` }} title="Min spend" /> : null}
    </div>
  );
}

/** Notes textarea that saves as you type and grows with its content. */
export function NoteField({ value, onChange, placeholder, compact }: {
  value: string; onChange: (v: string) => void; placeholder?: string; compact?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const t = ref.current;
    if (t) { t.style.height = "auto"; t.style.height = `${t.scrollHeight}px`; }
  }, [value]);
  return (
    <textarea ref={ref} className={`note-field ${compact ? "compact" : ""}`} value={value} rows={1}
      placeholder={placeholder ?? "Add a note…"} onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()} aria-label="Personal notes" />
  );
}

export function Empty({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon size={28} aria-hidden />
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}
