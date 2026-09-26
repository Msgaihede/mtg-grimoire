import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { DeckTokenRow } from "@/lib/ipc";

const deckTokens = vi.hoisted(() => vi.fn());
const deckTokenSetQuantity = vi.hoisted(() => vi.fn());
const deckTokenSwap = vi.hoisted(() => vi.fn());
const deckTokenAddPrinting = vi.hoisted(() => vi.fn());
const deckTokenState = vi.hoisted(() => vi.fn());
const deckTokenReset = vi.hoisted(() => vi.fn());
const getMarketplace = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    deckTokens,
    deckTokenSetQuantity,
    deckTokenSwap,
    deckTokenAddPrinting,
    deckTokenState,
    deckTokenReset,
    getMarketplace,
  },
}));

import { entryRef } from "./deckTokens";
import { useDeckTokens } from "./useDeckTokens";

/** One entry as Rust answers it — the implicit Treasure unless a case says otherwise. */
const row = (over: Partial<DeckTokenRow> = {}): DeckTokenRow => ({
  oracleId: "o-treasure",
  name: "Treasure",
  typeLine: "Token Artifact — Treasure",
  layout: "token",
  power: null,
  toughness: null,
  colors: "",
  oracleText: "{T}, Sacrifice this token: Add one mana of any color.",
  defaultCardId: "c-default",
  sources: [{ cardId: "d-1", name: "Smothering Tithe" }],
  derived: true,
  state: "auto",
  cardId: "c-default",
  finish: "nonfoil",
  quantity: 1,
  implicit: true,
  setCode: "tafr",
  collectorNumber: "15",
  setName: null,
  rarity: null,
  finishes: '["nonfoil","foil"]',
  unitPrice: null,
  ...over,
});

let client: QueryClient;

function mount(deckId: number | null = 7, variant: "live" | "theory" = "live") {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return renderHook(() => useDeckTokens(deckId, variant), { wrapper });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const fn of [
    deckTokens,
    deckTokenSetQuantity,
    deckTokenSwap,
    deckTokenAddPrinting,
    deckTokenState,
    deckTokenReset,
    getMarketplace,
  ]) {
    fn.mockReset();
  }
  getMarketplace.mockResolvedValue("tcgplayer");
  deckTokens.mockResolvedValue([row()]);
  for (const write of [
    deckTokenSetQuantity,
    deckTokenSwap,
    deckTokenAddPrinting,
    deckTokenState,
    deckTokenReset,
  ]) {
    write.mockResolvedValue(undefined);
  }
});

describe("useDeckTokens", () => {
  /**
   * **An implicit entry travels as `null`**, and a stored one as its grain — the whole of what
   * turns a tile's press into rule 2. Sending the implicit entry's own `cardId` would ask Rust to
   * change an entry that is not stored; sending `null` for a stored one would materialise a
   * second entry beside it.
   */
  it("names an implicit entry as null and a stored one by its printing and finish", async () => {
    deckTokens.mockResolvedValue([
      row(),
      row({
        oracleId: "o-wurm",
        name: "Wurm",
        cardId: "c-wurm",
        finish: "foil",
        implicit: false,
      }),
    ]);
    const { result } = mount(7, "theory");
    await waitFor(() => expect(result.current.tokens).toHaveLength(2));
    const [treasure, wurm] = result.current.tokens;

    act(() => result.current.setQuantity(entryRef(treasure), 3));
    await waitFor(() =>
      expect(deckTokenSetQuantity).toHaveBeenLastCalledWith(7, "theory", "o-treasure", null, 3),
    );
    act(() => result.current.setQuantity(entryRef(wurm), 0));
    await waitFor(() =>
      expect(deckTokenSetQuantity).toHaveBeenLastCalledWith(
        7,
        "theory",
        "o-wurm",
        { cardId: "c-wurm", finish: "foil" },
        0,
      ),
    );

    act(() => result.current.swap(entryRef(treasure), { cardId: "c-b", finish: "foil" }));
    await waitFor(() =>
      expect(deckTokenSwap).toHaveBeenLastCalledWith(7, "theory", "o-treasure", null, {
        cardId: "c-b",
        finish: "foil",
      }),
    );

    act(() => result.current.addPrinting("c-b", "etched"));
    await waitFor(() =>
      expect(deckTokenAddPrinting).toHaveBeenLastCalledWith(7, "theory", "c-b", "etched"),
    );

    act(() => result.current.reset("o-wurm"));
    await waitFor(() => expect(deckTokenReset).toHaveBeenLastCalledWith(7, "theory", "o-wurm"));
  });

  /**
   * **A dismissal names no list**, because the state is the token's in both; and a restore picks
   * `auto` or `manual` by whether the deck still derives the token — `hidden` costs a `manual`
   * token its manual-ness, and restoring one nothing derives to `auto` would take it off the wall
   * a second time.
   */
  it("dismisses without a list and restores by derivation", async () => {
    deckTokens.mockResolvedValue([
      row({ state: "hidden" }),
      row({ oracleId: "o-emblem", name: "Emblem", layout: "emblem", derived: false, sources: [] }),
    ]);
    const { result } = mount();
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    act(() => result.current.dismiss("o-emblem"));
    await waitFor(() => expect(deckTokenState).toHaveBeenLastCalledWith(7, "o-emblem", "hidden"));
    act(() => result.current.restore("o-treasure"));
    await waitFor(() => expect(deckTokenState).toHaveBeenLastCalledWith(7, "o-treasure", "auto"));
    act(() => result.current.restore("o-emblem"));
    await waitFor(() =>
      expect(deckTokenState).toHaveBeenLastCalledWith(7, "o-emblem", "manual"),
    );
  });

  /**
   * **A token write refreshes the deck's undo state**, so the Undo button reads *"Undo —
   * Treasure 1 → 3"* the moment the step exists. Since v52 every token write files a history row
   * and an undo step, and the undo query lives at `["decks", "undo", deckId, redoId]` — a key a
   * `["decks", "tokens", deckId]` invalidation, which is what these writes fired until then,
   * never reached. The root is what every other deck write fires.
   */
  it("invalidates the deck root, the undo state and the history included", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.tokens).toHaveLength(1));
    const spy = vi.spyOn(client, "invalidateQueries");

    act(() => result.current.setQuantity(entryRef(result.current.tokens[0]), 3));
    await waitFor(() => expect(spy).toHaveBeenCalled());

    const keys = spy.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(["decks"]);
    // A token write touches no card, so the managed wishlist Rust rewrites after a card write
    // has nothing to answer for.
    expect(keys).not.toContainEqual(["wishlist"]);
  });

  /** The setters are stable while nothing they read changes — the editor hands `setQuantity` to
   *  all four views inside a `useMemo`, and a fresh one per render re-renders the whole pile. */
  it("keeps setQuantity stable across renders", async () => {
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.tokens).toHaveLength(1));
    const first = result.current.setQuantity;
    rerender();
    expect(result.current.setQuantity).toBe(first);
  });
});
