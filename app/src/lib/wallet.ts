import { useCallback, useMemo } from "react";
import type { CatalogCard, MyCard, UserState } from "../types";
import { trackingDefaults } from "./catalog";
import { useUser } from "./store";

export const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Shorten "DBS Altitude Visa Signature Card" style names for tiles and notifications. */
export const shortName = (card: CatalogCard) =>
  card.name.replace(/\s+(credit|charge|debit)?\s*card$/i, "").replace(/^American Express/, "Amex");

export function newMyCard(card?: CatalogCard, nickname?: string): MyCard {
  return {
    id: uid(),
    catalogId: card?.id,
    nickname: nickname ?? (card ? shortName(card) : "My card"),
    spends: [],
    bills: {},
    fees: {},
    addedAt: new Date().toISOString(),
    ...(card ? trackingDefaults(card) : {}),
  };
}

export const patchCard = (s: UserState, id: string, fn: (c: MyCard) => MyCard): UserState => ({
  ...s,
  myCards: s.myCards.map((c) => (c.id === id ? fn(c) : c)),
});

export function useWalletActions() {
  const { state, update } = useUser();
  const owned = useMemo(() => new Set(state.myCards.map((c) => c.catalogId).filter(Boolean) as string[]), [state.myCards]);

  const add = useCallback((card?: CatalogCard, nickname?: string) => {
    const mc = newMyCard(card, nickname);
    update((s) => ({ ...s, myCards: [...s.myCards, mc] }));
    return mc;
  }, [update]);

  /** Remove by catalogue id (from the Cards page star). */
  const remove = useCallback((catalogId: string) => {
    const hasHistory = state.myCards.some((c) => c.catalogId === catalogId &&
      (c.spends.length || Object.keys(c.bills).length || Object.keys(c.fees).length || c.dueDay || c.feeDate));
    if (hasHistory && !confirm("Remove this card from your wallet? Its bill dates and spend log will be deleted.")) return;
    update((s) => ({ ...s, myCards: s.myCards.filter((c) => c.catalogId !== catalogId) }));
  }, [state.myCards, update]);

  return { owned, add, remove };
}
