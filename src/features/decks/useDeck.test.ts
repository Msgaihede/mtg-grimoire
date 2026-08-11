import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { DeckCard, DeckDetail, DeckRow, SwapResult } from "@/lib/ipc";

const deckGet = vi.hoisted(() => vi.fn());
const deckAddCard = vi.hoisted(() => vi.fn());
const deckSetCardQuantity = vi.hoisted(() => vi.fn());
const deckMoveCard = vi.hoisted(() => vi.fn());
const deckMissingToWishlist = vi.hoisted(() => vi.fn());
const deckSwapPrinting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    deckGet,
    deckAddCard,
    deckSetCardQuantity,
    deckMoveCard,
    deckMissingToWishlist,
    deckSwapPrinting,
  },
}));

import { useDeck, useSwapFromPane } from "./useDeck";

const DECK: DeckRow = {
  id: 4,
  name: "Burn",
  formatKey: "modern",
  formatName: "Modern",
  description: null,
  coverCardId: null,
  coverArtist: null,
  isBuilt: false,
  archived: false,
  cardCount: 4,
  updatedAt: 1_800_000_000,
};

const BOLT: DeckCard = {
  id: 9,
  cardId: "p1",
  zone: "main",
  quantity: 4,
  name: "Lightning Bolt",
  setCode: "lea",
  collectorNumber: "161",
  lang: "en",
  needsReview: null,
  oracleId: "o1",
  manaCost: "{R}",
  cmc: 1,
  typeLine: "Instant",
  oracleText: "Lightning Bolt deals 3 damage to any target.",
  colors: "R",
  colorIdentity: "R",
  legalities: '{"modern":"legal"}',
  power: null,
  toughness: null,
  layout: "normal",
  rarity: "common",
  faces: null,
  gameChanger: false,
  finishes: null,
  everUncommon: false,
  unitPriceUsd: 4.5,
  ownedQuantity: 2,
};

const DETAIL: DeckDetail = { deck: DECK, cards: [BOLT] };

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  deckGet.mockReset().mockResolvedValue(DETAIL);
  deckAddCard.mockReset().mockResolvedValue({ id: 9, quantity: 4, removed: false });
  deckSetCardQuantity.mockReset().mockResolvedValue({ id: 9, quantity: 3, removed: false });
  deckMoveCard.mockReset().mockResolvedValue(undefined);
  deckMissingToWishlist.mockReset().mockResolvedValue(2);
  deckSwapPrinting.mockReset().mockResolvedValue({ folded: false, quantity: 4 });
});

describe("useDeck", () => {
  /** The gallery is the Decks view's other half and mounts this hook with nothing open. A
   *  query that fired anyway would ask the backend for deck `null` on every gallery render. */
  it("asks for nothing until a deck is open", () => {
    renderHook(() => useDeck(null), { wrapper });

    expect(deckGet).not.toHaveBeenCalled();
  });

  /** One command, one query: the editor, the curve and the legality panel all read this,
   *  because three queries over one deck are three answers that can disagree. */
  it("reads one deck under the decks root", async () => {
    const { result } = renderHook(() => useDeck(4), { wrapper });

    await waitFor(() => expect(result.current.deck).toEqual(DECK));
    expect(deckGet).toHaveBeenCalledWith(4);
    expect(result.current.cards).toEqual([BOLT]);
    expect(client.getQueryData(["decks", "detail", 4])).toEqual(DETAIL);
  });

  /** A deck the gallery has not refreshed since another view deleted it. `null` is the
   *  answer, not an error — and it is `deck: null` rather than a hook that throws. */
  it("answers with nothing for a deck that is gone", async () => {
    deckGet.mockResolvedValue(null);
    const { result } = renderHook(() => useDeck(4), { wrapper });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.deck).toBeNull();
    expect(result.current.cards).toEqual([]);
  });

  /**
   * The stepper's write is `deck_set_card_quantity` and never `deck_add_card`.
   *
   * `add_card` looks the printing up in `cards` first (it has to — the row it inserts
   * denormalizes the set, number, language and name), so it **refuses an orphaned row**: the
   * one deck card whose printing has left the database is the one a stepper must still be
   * able to step. `set_card_quantity` addresses the slot that is already there and asks
   * `cards` nothing. Two names, and only one of them is the stepper's.
   */
  it("steps a quantity through set_card_quantity, never through add", async () => {
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    await result.current.setQuantity.mutateAsync({ cardId: "p1", zone: "main", quantity: 3 });

    expect(deckSetCardQuantity).toHaveBeenCalledWith(4, "p1", "main", 3);
    expect(deckAddCard).not.toHaveBeenCalled();
  });

  /** Zero is a removal here, unlike the collection's: a zone slot at zero holds no
   *  condition, no purchase price and no acquisition story, just a withdrawn intention. */
  it("empties a slot through the same write, and reads back that the row is gone", async () => {
    deckSetCardQuantity.mockResolvedValue({ id: 9, quantity: 0, removed: true });
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    const change = await result.current.setQuantity.mutateAsync({
      cardId: "p1",
      zone: "main",
      quantity: 0,
    });

    expect(deckSetCardQuantity).toHaveBeenCalledWith(4, "p1", "main", 0);
    expect(change.removed).toBe(true);
  });

  it("adds and moves cards through the deck the hook was opened on", async () => {
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    await result.current.addCard.mutateAsync({ cardId: "p2", zone: "maybe", quantity: 1 });
    expect(deckAddCard).toHaveBeenCalledWith(4, "p2", "maybe", 1);

    await result.current.moveCard.mutateAsync({ cardId: "p2", from: "maybe", to: "side" });
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p2", "maybe", "side");
  });

  /**
   * The pane's "Use this printing", addressed like every other zone write — by deck, card and
   * zone — and the only one that names two cards: the printing being left and the one being
   * taken up.
   *
   * **No optimistic patch, deliberately**, where the stepper beside it has one: what the row
   * ends up holding is the *server's* arithmetic. A swap onto a printing the zone already has
   * folds two rows into one, so a guess would have to delete a line and grow another — and a
   * guess that got it wrong would be a deck list that lost a card until the read landed. The
   * fold is only knowable after the write, and the answer carries it.
   */
  it("swaps a printing and reads back what the server folded", async () => {
    let answer: (result: SwapResult) => void = () => {};
    deckSwapPrinting.mockReturnValue(
      new Promise<SwapResult>((resolve) => {
        answer = resolve;
      }),
    );
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const swap = result.current.swapPrinting.mutateAsync({
      fromCardId: "p1",
      toCardId: "p2",
      zone: "main",
    });

    await waitFor(() => expect(deckSwapPrinting).toHaveBeenCalledWith(4, "p1", "p2", "main"));
    // Mid-flight, and the deck on screen is still the deck that was read: no guess was
    // written. This is what "no optimism" costs and buys — a beat of the old printing rather
    // than a line that disappears and comes back.
    expect(client.getQueryData(["decks", "detail", 4])).toEqual(DETAIL);

    answer({ folded: true, quantity: 7 });

    expect(await swap).toEqual({ folded: true, quantity: 7 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });
  });

  /**
   * Every zone write reallocates (`allocate_deck` runs inside the same transaction), so
   * every `ownedQuantity` in this deck may have moved and the gallery's `cardCount` with it
   * — the `["decks"]` root, not this one detail.
   *
   * The **wishlist** is not touched, and that is the decision rather than an omission: a
   * zone write moves `deck_allocations` and nothing else, and a wish's `ownedQuantity` is
   * summed from `collection_entries`. Only the one command that actually writes wishes takes
   * `["wishlist"]` with it.
   */
  it("refreshes every deck query after a zone write, and the wishlist only when it wrote one", async () => {
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await result.current.setQuantity.mutateAsync({ cardId: "p1", zone: "main", quantity: 3 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["wishlist"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["cards", "search"] });

    invalidate.mockClear();
    const wishes = await result.current.missingToWishlist.mutateAsync();

    expect(deckMissingToWishlist).toHaveBeenCalledWith(4);
    expect(wishes).toBe(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["wishlist"] });
    // And the deck too: the push reallocates before it counts, so what the deck is short of
    // is exactly what may have changed.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });
    // And the search wall. `missing_to_wishlist` writes **any-printing** wishes — `add_wish`
    // with an `oracleId` and no `cardId` — and `CardSummary.wishlisted` is an `EXISTS` that
    // matches an unpinned wish on `c.oracle_id`. One press therefore flips the heart on every
    // printing of every card the deck was short of, and a search behind this is visibly wrong
    // rather than stale in a field nothing draws.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cards", "search"] });
  });
});

/**
 * The swap pressed from the card pane, which is the only place it is pressed from.
 *
 * The pane is a **sibling** of the deck editor under `App`, so this mounts a second observer
 * on the same mutation definition — and that is the whole reason the definition carries an
 * `onError` the other five writes do not need. See `useDeck`'s `swapPrinting`.
 */
describe("useSwapFromPane", () => {
  /** No context is a card opened from anywhere but a deck row: nothing to ask for, and — like
   *  the gallery mounting `useDeck(null)` — nothing asked. */
  it("asks for nothing when the card was not opened from a deck", () => {
    const { result } = renderHook(() => useSwapFromPane(null), { wrapper });

    expect(deckGet).not.toHaveBeenCalled();
    expect(result.current.swap.isIdle).toBe(true);
    // And nothing to report about a deck nobody asked for: `deckGone` is about a read that
    // answered *nothing*, not about a read that never happened.
    expect(result.current.deckGone).toBe(false);
  });

  /** The context's deck, all the way to the command — `decks.id` is an INTEGER key and the
   *  mirror takes a number. */
  it("swaps the context's deck row for the printing that was pressed", async () => {
    const { result } = renderHook(
      () => useSwapFromPane({ deckId: 4, zone: "side", cardId: "p1" }),
      { wrapper },
    );

    const answer = await result.current.swap.mutateAsync({
      fromCardId: "p1",
      toCardId: "p2",
      zone: "side",
    });

    expect(deckSwapPrinting).toHaveBeenCalledWith(4, "p1", "p2", "side");
    expect(answer).toEqual({ folded: false, quantity: 4 });
  });

  /**
   * **The refused swap re-reads the deck**, and this is the mechanism the editor behind the
   * pane depends on.
   *
   * TanStack shares a query's *cache* between observers and shares a mutation's **state** with
   * nobody: the editor's `useDeck(4).swapPrinting` and this one are two `useMutation` calls, so
   * the editor's copy stays idle however this one ends. Its refused-write family — six writes,
   * one effect, one re-read — therefore cannot see this failure, and a deck deleted under the
   * reader would leave the zone columns painting a deck that is gone while the pane says why.
   * The invalidation is that family's rule, moved onto the definition every observer shares.
   */
  it("re-reads the deck when a swap is refused, whichever observer pressed it", async () => {
    deckSwapPrinting.mockRejectedValue("That deck is not there any more.");
    const { result } = renderHook(
      () => useSwapFromPane({ deckId: 4, zone: "main", cardId: "p1" }),
      {
        wrapper,
      },
    );
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await expect(
      result.current.swap.mutateAsync({ fromCardId: "p1", toCardId: "p2", zone: "main" }),
    ).rejects.toBe("That deck is not there any more.");

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] }));
  });

  /**
   * The read the pane takes this hook for: a deck that has been deleted answers nothing, and
   * the pane needs to know *before* the press — otherwise its only way of finding out is to
   * make a write the deck can only refuse.
   *
   * Loading is deliberately not gone: a pane that flashed "no offers" for one frame on the way
   * up would be telling the reader something untrue about their deck.
   */
  it("reports a deck the read cannot find, and calls nothing gone while it is loading", async () => {
    deckGet.mockResolvedValue(null);
    const { result } = renderHook(
      () => useSwapFromPane({ deckId: 4, zone: "main", cardId: "p1" }),
      {
        wrapper,
      },
    );

    expect(result.current.deckGone).toBe(false);

    await waitFor(() => expect(result.current.deckGone).toBe(true));
  });
});
