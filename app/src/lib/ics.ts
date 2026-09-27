// Calendar export: recurring events with alarms. This is the reminder route that works everywhere
// (notably iOS, where web apps can't notify in the background without a push server).
import type { MyCard, Settings, Ymd } from "../types";
import { billCycles, feeInstance, today } from "./dates";
import { FEE_GRACE_DAYS } from "./reminders";

const esc = (s: string) => s.replace(/[\\;,]/g, (m) => "\\" + m).replace(/\n/g, "\\n");
const ymd = (s: Ymd) => s.replaceAll("-", "");
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

/** RFC 5545 lines must be folded at 75 octets. */
const fold = (line: string) => {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = " " + rest.slice(74);
  }
  out.push(rest);
  return out.join("\r\n");
};

function event(uid: string, start: Ymd, rrule: string, summary: string, desc: string, alarmDays: number[]) {
  return [
    "BEGIN:VEVENT",
    `UID:${uid}@pocket-aces`,
    `DTSTAMP:${stamp()}`,
    `DTSTART;VALUE=DATE:${ymd(start)}`,
    `RRULE:${rrule}`,
    `SUMMARY:${esc(summary)}`,
    `DESCRIPTION:${esc(desc)}`,
    "TRANSP:TRANSPARENT",
    ...alarmDays.flatMap((d) => [
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${esc(summary)}`,
      // all-day events start at midnight; nudge the alarm to 9am
      `TRIGGER:${d === 0 ? "PT9H" : `-PT${d * 24 - 9}H`}`,
      "END:VALARM",
    ]),
    "END:VEVENT",
  ];
}

export function buildIcs(cards: MyCard[], settings: Settings): string {
  const on = today();
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//pocket aces//EN", "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:pocket aces"];
  for (const c of cards) {
    const { current, next } = billCycles(c, on);
    // start from the nearest upcoming due date (the current bill's, unless it has passed)
    const cycle = current && current.due >= on ? current : next;
    if (c.dueDay && cycle) {
      // days past 28 clamp to the month's last day: the latest of 28..dueDay that exists
      const byDay = c.dueDay > 28
        ? `BYMONTHDAY=${Array.from({ length: c.dueDay - 27 }, (_, i) => 28 + i).join(",")};BYSETPOS=-1`
        : `BYMONTHDAY=${c.dueDay}`;
      lines.push(...event(`due-${c.id}`, cycle.due, `FREQ=MONTHLY;${byDay}`,
        `${c.nickname}: bill due`, "Skip this if you've already paid (ticked off in pocket aces).",
        [settings.billReminderDays, 0]));
    }
    const fee = feeInstance(c, on, FEE_GRACE_DAYS);
    if (fee) {
      lines.push(...event(`fee-${c.id}`, fee, "FREQ=YEARLY", `${c.nickname}: annual fee`,
        "The annual fee is billed around now. Request a waiver from the bank.", [settings.feeReminderDays, 0]));
    }
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
