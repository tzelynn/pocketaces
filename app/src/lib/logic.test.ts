import { describe, expect, it } from "vitest";
import type { Bonus, CatalogCard, MyCard, Rule } from "../types";
import { DEFAULT_SETTINGS } from "../types";
import { billCycles, daysBetween, feeInstance, spendWindow, spentInWindow } from "./dates";
import { remindersFor, unnotified } from "./reminders";
import {
  activeBonuses, bonusHeadline, bonusValue, effectivePct, fmtConversion, fmtExpiry, hasMonthlyLimits, headlineRule, rateRules, spendCap,
  trackingDefaults,
} from "./catalog";
import { buildIcs } from "./ics";
import { normalise } from "./storage";

const card = (p: Partial<MyCard> = {}): MyCard => ({
  id: "c1", nickname: "Test", spends: [], bills: {}, fees: {}, addedAt: "", ...p,
});

const rule = (p: Partial<Rule> = {}): Rule => ({
  id: "r", label: "r", rate: 1, unit: "percent", tier: "bonus", allSpend: false, desc: null, minSpend: null,
  minSpendPeriod: null, maxSpend: null, maxSpendPeriod: null, cap: null, modes: [], conditions: [], includes: [],
  tags: [], limit: null, ...p,
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
  it("follows the catalogue card's cycle unless overridden", () => {
    const c = card({ spends, statementDay: 25 });
    expect(spendWindow(c, "2026-09-27", "statement")).toEqual({ start: "2026-09-26", end: "2026-10-25" });
    expect(spentInWindow(c, "2026-09-27", "statement")).toBe(70);
    expect(spendWindow({ ...c, spendPeriod: "calendar" }, "2026-09-27", "statement"))
      .toEqual({ start: "2026-09-01", end: "2026-09-30" });
  });
  it("counts per calendar month when a statement cycle has no statement day", () => {
    expect(spendWindow(card(), "2026-09-27", "statement")).toEqual({ start: "2026-09-01", end: "2026-09-30" });
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
      rule({ id: "dining", rate: 6, minSpend: 800, tags: ["dining"] }),
      rule({ id: "online", rate: 10, minSpend: 800, cap: { amount: 60, unit: "SGD_cashback", period: "statement_month" } }),
      rule({ id: "base", rate: 0.3, tier: "base" }),
    ],
  } as unknown as CatalogCard;

  it("headlines the best rule for a category", () => {
    expect(headlineRule(cc, null)?.id).toBe("online");
    expect(headlineRule(cc, "dining")?.id).toBe("dining");
  });

  it("doesn't headline or rank by a rate limited to named merchants", () => {
    const one = {
      rules: [
        rule({ id: "merchants", rate: 20, tags: ["dining"], limit: { kind: "merchants", text: "at McDonald's and Grab" } }),
        rule({ id: "groceries", rate: 8, tags: ["groceries"] }),
        rule({ id: "base", rate: 3.33, tier: "base" }),
      ],
    } as unknown as CatalogCard;
    expect(headlineRule(one, null)?.id).toBe("groceries");
    // only a limited rate covers dining: the card earns its base rate on dining in general
    expect(headlineRule(one, "dining")?.id).toBe("base");
    // still listed, best first
    expect(rateRules(one, null).map((r) => r.id)).toEqual(["merchants", "groceries", "base"]);
  });

  it("lists every rule above 1% / 1 mpd as its own row", () => {
    expect(rateRules(cc, null).map((r) => r.id)).toEqual(["online", "dining"]);
    expect(rateRules(cc, "dining").map((r) => r.id)).toEqual(["dining"]);
    const flat = { rules: [rule({ id: "b", rate: 1.5 }), rule({ id: "base", rate: 1.5, tier: "base" })] } as unknown as CatalogCard;
    expect(rateRules(flat, null).map((r) => r.id)).toEqual(["b"]);
    const low = { rules: [rule({ id: "base", rate: 0.4, unit: "mpd", tier: "base" })] } as unknown as CatalogCard;
    expect(rateRules(low, null).map((r) => r.id)).toEqual(["base"]);
    const pts = {
      rules: [rule({ id: "x", rate: 10, unit: "points_per_dollar" }), rule({ id: "base", rate: 2, unit: "points_per_dollar", tier: "base" })],
    } as unknown as CatalogCard;
    expect(rateRules(pts, null).map((r) => r.id)).toEqual(["x"]);
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
    expect(s.myCards[0]).toMatchObject({ spends: [], bills: {}, fees: {} });
    expect(s.settings.centsPerMile).toBe(1.5);
    expect(() => normalise({ hello: 1 })).toThrow();
  });
});

it("daysBetween ignores DST and time of day", () => {
  expect(daysBetween("2026-03-01", "2026-04-01")).toBe(31);
});

describe("sign-up bonuses", () => {
  const bonus = (p: Partial<Bonus> = {}): Bonus => ({
    by: "singsaver", title: null, desc: "", options: ["Gift"], value: null, worth: null, miles: null, minSpend: null,
    withinDays: null, newToBank: null, stackable: null, terms: null, validTo: null, url: null, ...p,
  });

  it("values the best gift: cash, stated worth or miles at the user's rate", () => {
    expect(bonusValue(bonus({ value: 400, worth: 660 }), 1.5)).toBe(660);
    expect(bonusValue(bonus({ miles: 45000 }), 1.5)).toBe(675);
    expect(bonusValue(bonus(), 1.5)).toBeNull();
  });

  it("headlines the best gift and counts the rest", () => {
    const cash = bonusHeadline(bonus({ value: 400, options: ["S$400 Cash via PayNow", "Luggage", "Watch"] }), 1.5);
    expect(cash).toEqual({ big: "S$400", sub: "cash · or 2 other gifts", text: false });
    const gift = bonusHeadline(bonus({ worth: 1150, options: ["Samsonite Luggage (worth S$1,150)"] }), 1.5);
    expect(gift.big).toBe("S$1,150");
    expect(gift.sub).toBe("gift: Samsonite Luggage");
    expect(bonusHeadline(bonus({ miles: 45000, options: ["Up to 45,000 KrisFlyer Miles"] }), 1.5))
      .toEqual({ big: "45k miles", sub: "up to ≈ S$675", text: false });
    expect(bonusHeadline(bonus({ options: ["Up to 40,000 points"] }), 1.5)).toMatchObject({ big: "Up to 40,000 points", text: true });
  });

  it("drops expired offers and ranks the rest by value", () => {
    const c = { bonuses: [bonus({ value: 50 }), bonus({ value: 999, validTo: "2026-01-31" }), bonus({ value: 200, validTo: "2026-02-01" })] } as CatalogCard;
    expect(activeBonuses(c, "2026-02-01", 1.5).map((b) => b.value)).toEqual([200, 50]);
    c.bonuses.push(bonus({ value: 500, title: "SingSaver Flash Deal" }));
    expect(activeBonuses(c, "2026-02-01", 1.5).map((b) => b.value)).toEqual([200, 50, 500]);
  });
});

describe("points expiry and conversion", () => {
  it("formats validity", () => {
    expect(fmtExpiry(null)).toBeNull();
    expect(fmtExpiry({ never: true, months: null, monthsMax: null })).toBe("No expiry");
    expect(fmtExpiry({ never: false, months: 36, monthsMax: null })).toBe("3 yrs");
    expect(fmtExpiry({ never: false, months: 37, monthsMax: null })).toBe("37 mo");
    expect(fmtExpiry({ never: false, months: 12, monthsMax: 15 })).toBe("12–15 mo");
    expect(fmtExpiry({ never: false, months: null, monthsMax: 60 })).toBe("Up to 5 yrs");
  });

  it("formats the transfer fee and block", () => {
    expect(fmtConversion({ partner: "KrisFlyer", points: 25000, miles: 10000, fee: 27.25 }))
      .toEqual({ fee: "S$27.25", block: "25,000 pts → 10,000 KrisFlyer miles" });
    expect(fmtConversion({ partner: "KrisFlyer", points: 1, miles: 1, fee: 0 })).toEqual({ fee: "Free", block: null });
  });

  it("knows when the spend month matters", () => {
    const monthly = { rules: [rule({ minSpend: 800, minSpendPeriod: "calendar_month" })] } as unknown as CatalogCard;
    const none = { rules: [rule()] } as unknown as CatalogCard;
    expect(hasMonthlyLimits(monthly)).toBe(true);
    expect(hasMonthlyLimits(none)).toBe(false);
  });
});
