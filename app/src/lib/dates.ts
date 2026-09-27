import type { MyCard, SpendPeriod, Ymd } from "../types";

/** Used when a card has a due day but no statement day (typical SG grace period is 20–25 days). */
export const ESTIMATED_GRACE_DAYS = 21;

const pad = (n: number) => String(n).padStart(2, "0");

export const toYmd = (d: Date): Ymd => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const parseYmd = (s: Ymd): Date => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

export const today = (): Ymd => toYmd(new Date());

export const daysInMonth = (y: number, m0: number) => new Date(y, m0 + 1, 0).getDate();

/** Date for `day` in month (y, m0), clamped so 31 becomes the last day of short months. */
export const dayInMonth = (y: number, m0: number, day: number): Date => {
  const yy = y + Math.floor(m0 / 12);
  const mm = ((m0 % 12) + 12) % 12;
  return new Date(yy, mm, Math.min(day, daysInMonth(yy, mm)));
};

export const addDays = (s: Ymd, n: number): Ymd => {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return toYmd(d);
};

/** Whole days from a to b (b − a). */
export const daysBetween = (a: Ymd, b: Ymd): number =>
  Math.round((Date.UTC(...ymdParts(b)) - Date.UTC(...ymdParts(a))) / 86_400_000);

const ymdParts = (s: Ymd): [number, number, number] => {
  const [y, m, d] = s.split("-").map(Number);
  return [y, m - 1, d];
};

export interface BillCycle {
  statement: Ymd;
  due: Ymd;
  estimated: boolean;
}

/** The statement issued in month (y, m0) and its due date. */
function cycleFor(card: MyCard, y: number, m0: number): BillCycle | null {
  const { statementDay, dueDay } = card;
  if (statementDay) {
    const statement = dayInMonth(y, m0, statementDay);
    if (!dueDay) return { statement: toYmd(statement), due: addDays(toYmd(statement), ESTIMATED_GRACE_DAYS), estimated: true };
    let due = dayInMonth(y, m0, dueDay);
    if (due <= statement) due = dayInMonth(y, m0 + 1, dueDay);
    return { statement: toYmd(statement), due: toYmd(due), estimated: false };
  }
  if (dueDay) {
    // month (y, m0) here indexes the due date; the statement is estimated back from it
    const due = toYmd(dayInMonth(y, m0, dueDay));
    return { statement: addDays(due, -ESTIMATED_GRACE_DAYS), due, estimated: true };
  }
  return null;
}

/** The most recently issued bill (statement on or before `on`) and the next one. */
export function billCycles(card: MyCard, on: Ymd): { current: BillCycle | null; next: BillCycle | null } {
  const d = parseYmd(on);
  const cycles: BillCycle[] = [];
  for (let k = -2; k <= 2; k++) {
    const c = cycleFor(card, d.getFullYear(), d.getMonth() + k);
    if (c) cycles.push(c);
  }
  const issued = cycles.filter((c) => c.statement <= on);
  const current = issued.at(-1) ?? null;
  const next = cycles.find((c) => c.statement > on) ?? null;
  return { current, next };
}

/** This membership year's fee date: the most recent one within `graceDays`, else the next one. */
export function feeInstance(card: MyCard, on: Ymd, graceDays = 30): Ymd | null {
  if (!card.feeDate) return null;
  const [mm, dd] = card.feeDate.split("-").map(Number);
  const y = parseYmd(on).getFullYear();
  const thisYear = toYmd(dayInMonth(y, mm - 1, dd));
  if (thisYear >= on) {
    const lastYear = toYmd(dayInMonth(y - 1, mm - 1, dd));
    return daysBetween(lastYear, on) <= graceDays ? lastYear : thisYear;
  }
  return daysBetween(thisYear, on) <= graceDays ? thisYear : toYmd(dayInMonth(y + 1, mm - 1, dd));
}

/**
 * Inclusive [start, end] of the spend-tracking period that contains `on`. `cardCycle` is the
 * catalogue card's cycle, used unless the user overrode it; statement cycles need a statement day.
 */
export function spendWindow(card: MyCard, on: Ymd, cardCycle: SpendPeriod = "calendar"): { start: Ymd; end: Ymd } {
  const d = parseYmd(on);
  if ((card.spendPeriod ?? cardCycle) === "statement" && card.statementDay) {
    const y = d.getFullYear(), m = d.getMonth();
    const thisStmt = toYmd(dayInMonth(y, m, card.statementDay));
    if (on <= thisStmt) {
      return { start: addDays(toYmd(dayInMonth(y, m - 1, card.statementDay)), 1), end: thisStmt };
    }
    return { start: addDays(thisStmt, 1), end: toYmd(dayInMonth(y, m + 1, card.statementDay)) };
  }
  return {
    start: toYmd(new Date(d.getFullYear(), d.getMonth(), 1)),
    end: toYmd(new Date(d.getFullYear(), d.getMonth() + 1, 0)),
  };
}

export function spentInWindow(card: MyCard, on: Ymd, cardCycle?: SpendPeriod): number {
  const { start, end } = spendWindow(card, on, cardCycle);
  return card.spends.filter((s) => s.date >= start && s.date <= end).reduce((a, s) => a + s.amount, 0);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const fmtDate = (s: Ymd, withYear = false): string => {
  const [y, m, d] = s.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ""}`;
};

export const relDays = (n: number): string =>
  n === 0 ? "today" : n === 1 ? "tomorrow" : n === -1 ? "yesterday" : n > 0 ? `in ${n} days` : `${-n} days ago`;
