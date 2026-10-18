// Sample wallet the tour shows when you hold no cards yet, so its Wallet steps have tiles, reminders and spend
// bars to point at. Built relative to `on`: one bill due in a few days, one fee coming up, spend part way to a
// min spend and a cap. Never saved or synced (see DemoStore in store.tsx).
import type { CatalogCard, MyCard, UserState, Ymd } from "../types";
import { emptyState } from "../types";
import { addDays, parseYmd, spendWindow } from "./dates";
import { shortName, trackingDefaults } from "./catalog";

const day = (s: Ymd) => parseYmd(s).getDate();
const mmdd = (s: Ymd) => s.slice(5);

function sample(id: string, nickname: string, card: CatalogCard | undefined, p: Partial<MyCard>, on: Ymd,
  spends: [daysAgo: number, amount: number, note: string][]): MyCard {
  const c: MyCard = {
    id, catalogId: card?.id, nickname: card ? shortName(card) : nickname, spends: [], bills: {}, fees: {}, addedAt: "",
    ...(card ? trackingDefaults(card) : {}), ...p,
  };
  // keep every entry inside the current spend window, so the bar shows all of it
  const { start } = spendWindow(c, on, card?.spendCycle);
  c.spends = spends.map(([ago, amount, note], n) => {
    const date = addDays(on, -ago);
    return { id: `${id}-s${n}`, date: date < start ? start : date, amount, note };
  });
  return c;
}

export function demoState(cards: CatalogCard[], on: Ymd): UserState {
  const miles = cards.find((c) => c.id === "citi-rewards") ?? cards.find((c) => c.kind === "miles" && !c.expiry?.never);
  const cash = cards.find((c) => c.id === "ocbc-365") ?? cards.find((c) => c.kind === "cashback");

  const dueA = addDays(on, 3), stmtA = addDays(dueA, -20);
  const a = sample("demo-miles", "Miles card", miles, {
    statementDay: day(stmtA), dueDay: day(dueA),
    feeDate: mmdd(addDays(on, 150)),
    pointsExpiry: addDays(on, 75),
  }, on, [[0, 410, "Flights"], [2, 86, "Dinner"], [5, 120.5, "Online shopping"]]);
  a.maxSpend ??= 1000;

  const stmtB = addDays(on, -10), dueB = addDays(on, 12);
  const b = sample("demo-cashback", "Cashback card", cash, {
    statementDay: day(stmtB), dueDay: day(dueB),
    feeDate: mmdd(addDays(on, 5)),
    bills: { [stmtB]: { paidAt: `${on}T09:00:00` } },
  }, on, [[1, 230, "Groceries"], [3, 64.8, "Petrol"], [6, 155, "Dining"]]);
  b.minSpend ??= 800;

  return { ...emptyState(), myCards: [a, b] };
}
