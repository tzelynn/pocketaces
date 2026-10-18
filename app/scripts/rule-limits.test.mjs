import { describe, expect, it } from "vitest";
import { limitedTime, narrowScope, sentences } from "./rule-limits.mjs";

const rule = (rate, description, p = {}) => ({ rate, unit: "percent", tier: "bonus", label: "x", eligibility: { description, ...p } });

describe("rule text: limited time", () => {
  it("reads an end date off the sentence quoting the rate", () => {
    expect(limitedTime(rule(3.25, "Up to | 3.25% FX spend on select countries (valid until 28 Feb 2025). Base rate 1.6%.")))
      .toMatchObject({ until: "2025-02-28", after: null });
    expect(limitedTime({ ...rule(6, "Up to | Now till 30 June 2025, earn 15 OCBC$ (6 miles) per S$1 spent at Watsons."), unit: "mpd" }))
      .toMatchObject({ until: "2025-06-30" });
  });

  it("keeps the rate that applies once an intro period ends", () => {
    const t = limitedTime(rule(8, "Get up to 8% cashback on dining with S$1,000/month spend for the first 2 calendar quarters. Thereafter, earn 5% cashback with S$600/month spend."));
    expect(t).toMatchObject({ until: null, after: 5 });
  });

  it("ignores promotions about some other rate", () => {
    // the ongoing 1.5% rule, not the new-member 3%
    expect(limitedTime(rule(1.5, "For new Card Members, enjoy 3% Cashback on all eligible purchases, up to S$5,000 spend in the first 6 months. Earn 1.5% Cashback on all subsequent eligible purchases."))).toBeNull();
    expect(limitedTime({ ...rule(1.6, "valid until 28 Feb 2025"), tier: "base" })).toBeNull();
  });

  it("trusts a curated end date", () => {
    expect(limitedTime({ ...rule(3, null), valid_to: "2026-12-31" })).toMatchObject({ until: "2026-12-31" });
  });
});

describe("rule text: narrow scope", () => {
  it("flags rates at named merchants", () => {
    const one = narrowScope(rule(20, "Up to | Up to 20% cashback on daily spend at McDonald’s, Grab, SimplyGo (bus/train rides) and Shopee; up to 18% cashback on all grocery spend."));
    expect(one).toMatchObject({ kind: "merchants" });
    expect(one.text).toMatch(/McDonald/);
    expect(narrowScope(rule(7, "Up to | On Agoda bookings"))?.kind).toBe("merchants");
    expect(narrowScope(rule(10, "Up to 36x yuu Points (up to 10 mpd) when you spend min. S$800 and at 4 Participating Merchants per calendar month"))?.kind).toBe("merchants");
    expect(narrowScope(rule(6, "", { include_merchants: ["Watsons"] }))?.kind).toBe("merchants");
  });

  it("flags rates in select countries", () => {
    expect(narrowScope(rule(3, "Earn 3 miles per S$1 spend on regional spend in Indonesia, Malaysia, Thailand, Vietnam."))?.kind).toBe("countries");
  });

  it("leaves spend categories, caps and unlock conditions alone", () => {
    expect(narrowScope(rule(6, "Up to | On Shopping and Transport spend. Capped at S$50 per calendar month."))).toBeNull();
    expect(narrowScope(rule(10, "Get up to 10% cashback with minimum monthly spend of S$800, capped at S$25."))).toBeNull();
    expect(narrowScope(rule(3, "Everyday spend categories: dining, food delivery, online shopping, with at least S$800 annual spend on Singapore Airlines, Scoot, and/or KrisShop."))).toBeNull();
    expect(narrowScope(rule(3, "Earn up to 5 miles per S$1 on overseas spend on shopping and dining, and up to 3 miles on all other overseas spend, including online (based on UNI$12.5 per S$5)."))).toBeNull();
    expect(narrowScope({ ...rule(1.6, "at McDonald's"), tier: "base" })).toBeNull();
  });

  it("splits sentences without breaking on abbreviations", () => {
    expect(sentences("With min. S$800 spend. Capped at S$25  Additional 2% at X")).toEqual(["With min. S$800 spend.", "Capped at S$25", "Additional 2% at X"]);
  });
});

describe("rule text: narrow scope beside caps", () => {
  it("doesn't let a cap sentence veto a merchant list", () => {
    expect(narrowScope(rule(10, "Up to | On McDonald's, Starbucks, Netflix, Spotify etc.  Capped at S$15 per month"))?.kind).toBe("merchants");
    expect(narrowScope(rule(12, "12% cashback on your Singtel/GOMO spend, capped at S$30 per statement month."))?.kind).toBe("merchants");
    expect(narrowScope(rule(5, "Capped at S$50 each statement month."))).toBeNull();
  });
});
