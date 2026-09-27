import { describe, expect, it } from "vitest";
import type { CatalogCard, MyCard, Rule } from "../types";
import { DEFAULT_SETTINGS } from "../types";
import { billCycles, daysBetween, feeInstance, spendWindow, spentInWindow } from "./dates";
import { remindersFor, unnotified } from "./reminders";
import { effectivePct, headlineRule, spendCap, trackingDefaults } from "./catalog";
import { buildIcs } from "./ics";
import { normalise } from "./storage";

const card = (p: Partial<MyCard> = {}): MyCard => ({
  id: "c1", nickname: "Test", spendPeriod: "calendar", spends: [], bills: {}, fees: {}, addedAt: "", ...p,
});

const rule = (p: Partial<Rule> = {}): Rule => ({
  id: "r", label: "r", rate: 1, unit: "percent", tier: "bonus", allSpend: false, desc: null, minSpend: null,
  minSpendPeriod: null, maxSpend: null, maxSpendPeriod: null, cap: null, modes: [], conditions: [], ...p,
});

describe("bill cycles", () => {
  it("puts the due date in the next month when due day ≤ statement day", () => {
    const c = card({ statementDay: 25, dueDay: 15 });
    expect(billCycles(c, "2026-11-10").current).toEqual({ statement: "2026-10-25", due: "2026-11-15", estimated: false });
    expect(billCycles(c, "2026-10-25").current?.statement).toBe("2026-10-25");
    expect(billCycles(c, "2026-10-24").current?.statement).toBe("2026-09-25");
    expect(billCycles(c, "2026-10-24").next?.statement).toBe("2026-10-25");
  });

  it("keeps the due date in the same month when due day > statement day", () => {
    expect(billCycles(card({ statementDay: 3, dueDay: 28 }), "2026-10-05").current?.due).toBe("2026-10-28");
  });

  it("clamps day 31 to short months", () => {
    const c = card({ statementDay: 31, dueDay: 20 });
    expect(billCycles(c, "2026-03-01").current).toMatchObject({ statement: "2026-02-28", due: "2026-03-20" });
  });

  it("estimates the statement from the due day alone", () => {
    const { current } = billCycles(card({ dueDay: 15 }), "2026-10-01");
    expect(current).toEqual({ statement: "2026-09-24", due: "2026-10-15", estimated: true });
  });

  it("has no cycle without dates", () => {
    expect(billCycles(card(), "2026-10-01")).toEqual({ current: null, next: null });
  });
});

describe("annual fee instance", () => {
  const c = card({ feeDate: "10-05" });
  it("is the upcoming date when the last one is long past", () => {
    expect(feeInstance(c, "2026-09-27")).toBe("2026-10-05");
  });
  it("stays on a recently passed date so it can still be checked off", () => {
    expect(feeInstance(c, "2026-10-20")).toBe("2026-10-05");
    expect(feeInstance(c, "2026-11-20")).toBe("2027-10-05");
  });
  it("handles a fee date just before new year", () => {
    expect(feeInstance(card({ feeDate: "12-20" }), "2027-01-05")).toBe("2026-12-20");
  });
});

describe("spend window", () => {
  const spends = [
    { id: "a", date: "2026-09-25", amount: 100 },
    { id: "b", date: "2026-09-26", amount: 50 },
    { id: "c", date: "2026-10-02", amount: 20 },
  ];
  it("uses the calendar month by default", () => {
    expect(spendWindow(card(), "2026-09-27")).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(spentInWindow(card({ spends }), "2026-09-27")).toBe(150);
  });
  it("follows the statement cycle when asked", () => {
    const c = card({ spends, spendPeriod: "statement", statementDay: 25 });
    expect(spendWindow(c, "2026-09-25")).toEqual({ start: "2026-08-26", end: "2026-09-25" });
    expect(spendWindow(c, "2026-09-27")).toEqual({ start: "2026-09-26", end: "2026-10-25" });
    expect(spentInWindow(c, "2026-09-27")).toBe(70);
  });
});

describe("reminders", () => {
  const s = DEFAULT_SETTINGS;
  it("warns a week before an unpaid bill and clears once ticked", () => {
    const c = card({ statementDay: 25, dueDay: 15 });
    expect(remindersFor([c], s, "2026-11-07")).toHaveLength(0);
    const [r] = remindersFor([c], s, "2026-11-08");
    expect(r).toMatchObject({ kind: "bill", severity: "soon", days: 7, instance: "2026-10-25" });
    expect(remindersFor([{ ...c, bills: { "2026-10-25": { paidAt: "x" } } }], s, "2026-11-08")).toHaveLength(0);
    expect(remindersFor([c], s, "2026-11-16")[0]).toMatchObject({ severity: "overdue", days: -1 });
  });

  it("resets for the next statement", () => {
    const c = card({ statementDay: 25, dueDay: 15, bills: { "2026-10-25": { paidAt: "x" } } });
    expect(remindersFor([c], s, "2026-12-10")[0].instance).toBe("2026-11-25");
  });

  it("flags the annual fee from a week before until checked off", () => {
    const c = card({ feeDate: "10-05" });
    expect(remindersFor([c], s, "2026-09-27")).toHaveLength(0);
    expect(remindersFor([c], s, "2026-09-28")[0]).toMatchObject({ kind: "fee", severity: "soon" });
    expect(remindersFor([c], s, "2026-10-10")[0]).toMatchObject({ severity: "overdue" });
    expect(remindersFor([{ ...c, fees: { "2026-10-05": { status: "waived", at: "x" } } }], s, "2026-10-10")).toHaveLength(0);
  });

  it("notifies each stage once", () => {
    const rs = remindersFor([card({ statementDay: 25, dueDay: 15 })], s, "2026-11-10");
    const first = unnotified(rs, {});
    expect(first.fresh).toHaveLength(1);
    expect(unnotified(rs, first.notified).fresh).toHaveLength(0);
  });
});

describe("catalogue maths", () => {
  it("converts reward caps to spend caps", () => {
    expect(spendCap(rule({ rate: 8, cap: { amount: 60, unit: "SGD_cashback", period: "statement_month" } }))).toBe(750);
    expect(spendCap(rule({ rate: 4, unit: "mpd", cap: { amount: 4000, unit: "miles", period: "calendar_month" } }))).toBe(1000);
    expect(spendCap(rule({ maxSpend: 500, cap: { amount: 1000, unit: "SGD_spend", period: "calendar_month" } }))).toBe(500);
    expect(spendCap(rule())).toBe(Infinity);
  });

  it("values miles, not points", () => {
    expect(effectivePct(rule({ rate: 4, unit: "mpd" }), 1.5)).toBe(6);
    expect(effectivePct(rule({ rate: 10, unit: "points_per_dollar" }), 1.5)).toBeNull();
  });

  const cc = {
    rules: [
      rule({ id: "dining", rate: 6, minSpend: 800 }),
      rule({ id: "online", rate: 10, minSpend: 800, cap: { amount: 60, unit: "SGD_cashback", period: "statement_month" } }),
      rule({ id: "base", rate: 0.3, tier: "base" }),
    ],
    coverage: { dining: { level: "full", rules: ["dining"] } },
  } as unknown as CatalogCard;

  it("headlines the best rule for a category", () => {
    expect(headlineRule(cc, null)?.id).toBe("online");
    expect(headlineRule(cc, "dining")?.id).toBe("dining");
  });

  it("prefills wallet targets", () => {
    expect(trackingDefaults(cc)).toEqual({ minSpend: 800, maxSpend: 600 });
  });
});

describe("calendar export", () => {
  it("writes monthly due and yearly fee events with alarms", () => {
    const ics = buildIcs([card({ nickname: "Card, One", dueDay: 31, feeDate: "10-05" })], DEFAULT_SETTINGS);
    expect(ics).toContain("RRULE:FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1");
    expect(ics).toContain("RRULE:FREQ=YEARLY");
    expect(ics).toContain("SUMMARY:Card\\, One: bill due");
    expect(ics).toContain("TRIGGER:-PT159H");
    expect(ics.split("\r\n").every((l) => l.length <= 75)).toBe(true);
  });
});

describe("backup parsing", () => {
  it("fills missing fields and rejects junk", () => {
    const s = normalise({ myCards: [{ id: "x", nickname: "X" }] });
    expect(s.myCards[0]).toMatchObject({ spends: [], bills: {}, fees: {}, spendPeriod: "calendar" });
    expect(s.settings.centsPerMile).toBe(1.5);
    expect(() => normalise({ hello: 1 })).toThrow();
  });
});

it("daysBetween ignores DST and time of day", () => {
  expect(daysBetween("2026-03-01", "2026-04-01")).toBe(31);
});
