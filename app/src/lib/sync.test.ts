import { describe, expect, it } from "vitest";
import { emptyState, type MyCard, type UserState } from "../types";
import { deriveKeys, newDataKey, openState, rewrapDataKey, sealState, unwrapDataKey } from "./crypto";
import { equal, merge3 } from "./merge";
import { toShared, withDevice } from "./sync";

// fast KDF for tests; the app uses KDF_ITERATIONS
const keys = (user: string, pw: string) => deriveKeys(user, pw, 1000);

const card = (id: string, p: Partial<MyCard> = {}): MyCard => ({
  id, nickname: id, spends: [], bills: {}, fees: {}, addedAt: "2026-01-01", ...p,
});
const st = (p: Partial<UserState> = {}): UserState => ({ ...emptyState(), ...p });

describe("encryption", () => {
  it("derives the same auth key every time, and different ones per user and password", async () => {
    const a = await keys("alice", "correct horse battery");
    expect((await keys("alice", "correct horse battery")).auth).toBe(a.auth);
    expect((await keys("bob", "correct horse battery")).auth).not.toBe(a.auth);
    expect((await keys("alice", "correct horse battery!")).auth).not.toBe(a.auth);
    expect(a.auth).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("round-trips the state through the wrapped data key", async () => {
    const { kek } = await keys("alice", "correct horse battery");
    const { key, wrapped } = await newDataKey(kek, "alice");
    const state = st({ myCards: [card("c1", { spends: [{ id: "s1", date: "2026-09-01", amount: 12.5 }] })], notes: { x: "hi ✓" } });
    const blob = await sealState(key, "alice", 3, state);
    expect(blob.ct).not.toContain("hi");

    // another device: same password → same kek → same data key
    const other = await unwrapDataKey((await keys("alice", "correct horse battery")).kek, "alice", wrapped);
    expect(await openState(other, "alice", 3, blob)).toEqual(state);
  });

  it("rejects a wrong password, another user's blob and a relabelled version", async () => {
    const { kek } = await keys("alice", "correct horse battery");
    const { key, wrapped } = await newDataKey(kek, "alice");
    await expect(unwrapDataKey((await keys("alice", "wrong password!!")).kek, "alice", wrapped)).rejects.toThrow();
    const blob = await sealState(key, "alice", 3, st());
    await expect(openState(key, "alice", 4, blob)).rejects.toThrow();
    await expect(openState(key, "bob", 3, blob)).rejects.toThrow();
  });

  it("keeps the data key across a password change", async () => {
    const old = await keys("alice", "correct horse battery");
    const { key, wrapped } = await newDataKey(old.kek, "alice");
    const blob = await sealState(key, "alice", 1, st({ notes: { a: "b" } }));
    const fresh = await keys("alice", "a brand new password");
    const rewrapped = await rewrapDataKey(old.kek, fresh.kek, "alice", wrapped);
    const again = await unwrapDataKey(fresh.kek, "alice", rewrapped);
    expect(await openState(again, "alice", 1, blob)).toEqual(st({ notes: { a: "b" } }));
    await expect(unwrapDataKey(old.kek, "alice", rewrapped)).rejects.toThrow();
  });
});

describe("merge", () => {
  const base = st({ myCards: [card("a"), card("b")], notes: { n1: "one" } });

  it("keeps edits to different cards, spends, bills and notes from both devices", () => {
    const local = st({
      myCards: [card("a", { spends: [{ id: "s1", date: "2026-09-02", amount: 10 }] }), card("b")],
      notes: { n1: "one", n2: "local" },
    });
    const remote = st({
      myCards: [card("a", { spends: [{ id: "s2", date: "2026-09-03", amount: 20 }] }), card("b", { bills: { "2026-09-10": { paidAt: "x" } } }), card("c")],
      notes: { n1: "one", n3: "remote" },
    });
    const m = merge3(base, local, remote);
    expect(m.myCards.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(m.myCards[0].spends.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(m.myCards[1].bills).toEqual({ "2026-09-10": { paidAt: "x" } });
    expect(m.notes).toEqual({ n1: "one", n2: "local", n3: "remote" });
  });

  it("applies deletions from either side", () => {
    const local = st({ myCards: [card("a")], notes: {} });
    const remote = st({ myCards: [card("a"), card("b"), card("c")], notes: { n1: "one" } });
    const m = merge3(base, local, remote);
    expect(m.myCards.map((c) => c.id)).toEqual(["a", "c"]);
    expect(m.notes).toEqual({});
  });

  it("prefers this device when both changed the same field", () => {
    const local = st({ ...base, settings: { ...base.settings, centsPerMile: 2 } });
    const remote = st({ ...base, settings: { ...base.settings, centsPerMile: 1.8, billReminderDays: 3 } });
    expect(merge3(base, local, remote).settings).toMatchObject({ centsPerMile: 2, billReminderDays: 3 });
  });

  it("merges a new device's cards into the account on first sign-in", () => {
    const local = st({ myCards: [card("phone")] });
    const remote = st({ myCards: [card("laptop")], settings: { ...emptyState().settings, centsPerMile: 2 } });
    const m = merge3(emptyState(), local, remote);
    expect(m.myCards.map((c) => c.id)).toEqual(["laptop", "phone"]);
    expect(m.settings.centsPerMile).toBe(2); // this device only had the defaults
  });

  it("treats missing and undefined fields as equal", () => {
    expect(equal({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(equal([1, { x: 2 }], [1, { x: 2 }])).toBe(true);
    expect(equal({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe("per-device settings", () => {
  it("leaves notifications out of the synced copy and keeps this device's choice", () => {
    const on = st({ settings: { ...emptyState().settings, notifications: true, centsPerMile: 2 } });
    const off = st({ settings: { ...emptyState().settings, notifications: false, centsPerMile: 2 } });
    expect(equal(toShared(on), toShared(off))).toBe(true); // no push just for a notifications toggle
    expect(withDevice(toShared(off), on).settings).toMatchObject({ notifications: true, centsPerMile: 2 });
  });
});
