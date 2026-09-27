// Pure reminder logic, shared by the app (in-app list + notifications) and the service worker
// (periodic background sync). Keep it free of DOM and React imports.
import type { MyCard, Settings, Ymd } from "../types";
import { billCycles, daysBetween, feeInstance, fmtDate, relDays } from "./dates";

/** How long after the fee date to keep nagging if it hasn't been checked off. */
export const FEE_GRACE_DAYS = 30;

export interface Reminder {
  /** stable per event and stage, used to avoid repeating a notification */
  key: string;
  kind: "bill" | "fee";
  severity: "soon" | "overdue";
  cardId: string;
  cardName: string;
  /** statement date (bill) or fee date (fee): the check-off key */
  instance: Ymd;
  date: Ymd;
  days: number;
  title: string;
  body: string;
}

export function remindersFor(cards: MyCard[], settings: Settings, on: Ymd): Reminder[] {
  const out: Reminder[] = [];
  for (const card of cards) {
    const { current } = billCycles(card, on);
    if (current && !card.bills[current.statement]) {
      const days = daysBetween(on, current.due);
      if (days <= settings.billReminderDays) {
        const overdue = days < 0;
        out.push({
          key: `bill:${card.id}:${current.statement}:${overdue ? "overdue" : "soon"}`,
          kind: "bill",
          severity: overdue ? "overdue" : "soon",
          cardId: card.id,
          cardName: card.nickname,
          instance: current.statement,
          date: current.due,
          days,
          title: overdue ? `${card.nickname} bill is overdue` : `${card.nickname} bill due ${relDays(days)}`,
          body: `Due ${fmtDate(current.due)}${current.estimated ? " (estimated)" : ""}. Tick it off once paid.`,
        });
      }
    }
    const fee = feeInstance(card, on, FEE_GRACE_DAYS);
    if (fee && !card.fees[fee]) {
      const days = daysBetween(on, fee);
      if (days <= settings.feeReminderDays && days >= -FEE_GRACE_DAYS) {
        const billed = days <= 0;
        out.push({
          key: `fee:${card.id}:${fee}:${billed ? "billed" : "soon"}`,
          kind: "fee",
          severity: billed ? "overdue" : "soon",
          cardId: card.id,
          cardName: card.nickname,
          instance: fee,
          date: fee,
          days,
          title: billed ? `${card.nickname} annual fee is due` : `${card.nickname} annual fee ${relDays(days)}`,
          body: billed
            ? `Billed around ${fmtDate(fee)}. Call the bank or use its app to request a waiver.`
            : `Expected ${fmtDate(fee)}. Get ready to request a waiver.`,
        });
      }
    }
  }
  return out.sort((a, b) => a.days - b.days);
}

/**
 * Reminders not yet notified, and the updated notified-set (entries older than 90 days pruned).
 * Each reminder notifies once per stage: e.g. once when a bill becomes due soon, once if overdue.
 */
export function unnotified(reminders: Reminder[], notified: Record<string, string>, now = new Date()) {
  const cutoff = now.getTime() - 90 * 86_400_000;
  const next: Record<string, string> = {};
  for (const [k, at] of Object.entries(notified)) if (Date.parse(at) > cutoff) next[k] = at;
  const fresh = reminders.filter((r) => !next[r.key]);
  for (const r of fresh) next[r.key] = now.toISOString();
  return { fresh, notified: next };
}

export const REMINDER_SYNC_TAG = "pocketaces-reminders";
