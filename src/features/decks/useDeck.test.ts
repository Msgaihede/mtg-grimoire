import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type {
  DeckCard,
  DeckCategory,
  DeckDetail,
  DeckRow,
  DeckVariant,
  SwapResult,
} from "@/lib/ipc";

const deckGet = vi.hoisted(() => vi.fn());
const deckAddCard = vi.hoisted(() => vi.fn());
const deckSetCardQuantity = vi.hoisted(() => vi.fn());
const deckMoveCard = vi.hoisted(() => vi.fn());
const deckMissingToWishlist = vi.hoisted(() => vi.fn());
const deckSwapPrinting = vi.hoisted(() => vi.fn());
const deckCardSetTag = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    deckGet,
    deckAddCard,
    deckSetCardQuantity,
    deckMoveCard,
    deckMissingToWishlist,
    deckSwapPrinting,
    deckCardSetTag,
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
  // The four v8 deck columns. `theoryEnabled: false` is the ordinary deck — the switch is off
  // until the reader turns it on, and turning it on seeds the theory list from live so that an
  // empty second list is never a state anyone has to interpret.
  coverKind: "card_art",
  folderId: null,
  notes: null,
  theoryEnabled: false,
};

/**
 * The deck's categories, as `deck_get` answers them: **every** one, in `sortOrder`, whether or
 * not it holds a card — the editor's columns are this list rather than the piles that happen to
 * be full.
 *
 * Two of the categories a deck is born with (`schema::PREDEFINED_CATEGORIES`) plus the pile the
 * v8 migration files every legacy main-deck row into. The Maybeboard is the one of the four
 * seeded switched off, and that flag is the whole of "counts toward nothing" — nothing in the
 * app reads its *kind* for that question, which is why a test that wants a pile counted in
 * nothing can equally switch off a `main` one.
 */
const MAIN: DeckCategory = {
  id: 1,
  deckId: 4,
  name: "Main deck",
  kind: "main",
  isActive: true,
  sortOrder: 0,
  cardCount: 4,
  totalPriceUsd: 18,
  totalPriceEur: 14,
  cardCountAllVariants: 4,
};
const SIDE: DeckCategory = {
  id: 2,
  deckId: 4,
  name: "Sideboard",
  kind: "side",
  isActive: true,
  sortOrder: 1,
  cardCount: 0,
  totalPriceUsd: null,
  totalPriceEur: null,
  cardCountAllVariants: 0,
};
const MAYBE: DeckCategory = {
  id: 5,
  deckId: 4,
  name: "Maybeboard",
  kind: "maybe",
  isActive: false,
  sortOrder: 2,
  cardCount: 0,
  totalPriceUsd: null,
  totalPriceEur: null,
  cardCountAllVariants: 0,
};

const BOLT: DeckCard = {
  id: 9,
  cardId: "p1",
  // The category is denormalized onto the row so a card can be drawn without a second lookup;
  // it is taken from {@link MAIN} here so the fixture cannot say two things about one pile.
  categoryId: MAIN.id,
  categoryName: MAIN.name,
  categoryKind: MAIN.kind,
  categoryActive: MAIN.isActive,
  variant: "live",
  tagId: null,
  tagName: null,
  tagColor: null,
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
  unitPriceEur: 3.5,
  ownedQuantity: 2,
};

const DETAIL: DeckDetail = { deck: DECK, cards: [BOLT], categories: [MAIN, SIDE, MAYBE], tags: [] };

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
  deckCardSetTag.mockReset().mockResolvedValue(undefined);
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
    // `live` is the **default argument**, not a constant: a caller with no Live/Theory control
    // gets the deck as it stands. The variant scopes the **cards** — the categories and tags
    // come back either way.
    expect(deckGet).toHaveBeenCalledWith(4, "live");
    expect(result.current.cards).toEqual([BOLT]);
    // Every category, including the two holding nothing: the editor's columns are this list
    // rather than the piles that happen to be full.
    expect(result.current.categories).toEqual([MAIN, SIDE, MAYBE]);
    expect(result.current.tags).toEqual([]);
    expect(client.getQueryData(["decks", "detail", 4, "live"])).toEqual(DETAIL);
  });

  /**
   * **Switching variant is a query-key change, not a refetch.**
   *
   * The two lists are two cached answers rather than one that is thrown away every time the
   * reader flips the switch: flipping back is a cache hit, and each list keeps its own
   * freshness. It is also what makes the optimistic patch below address the right list by
   * construction — the cache it writes into holds one variant's cards and no other.
   */
  it("caches each variant's cards under its own key", async () => {
    const PLAN: DeckCard = { ...BOLT, id: 11, variant: "theory", quantity: 2 };
    deckGet.mockImplementation((_id: number, variant: string) =>
      Promise.resolve(variant === "theory" ? { ...DETAIL, cards: [PLAN] } : DETAIL),
    );
    const { result, rerender } = renderHook(
      ({ variant }: { variant: DeckVariant }) => useDeck(4, variant),
      { wrapper, initialProps: { variant: "live" as DeckVariant } },
    );
    await waitFor(() => expect(result.current.cards).toEqual([BOLT]));

    rerender({ variant: "theory" });

    await waitFor(() => expect(result.current.cards).toEqual([PLAN]));
    expect(deckGet).toHaveBeenCalledWith(4, "theory");
    // Both answers are still there. Nothing was invalidated and nothing was re-read to get
    // here — a switch is a different question, not a stale answer to the same one.
    expect(client.getQueryData(["decks", "detail", 4, "live"])).toEqual(DETAIL);
    expect(client.getQueryData(["decks", "detail", 4, "theory"])).toEqual({
      ...DETAIL,
      cards: [PLAN],
    });
  });

  /**
   * Every write goes to the list the hook was opened on — the fourth part of
   * `DECK_CARD_GRAIN`, and the difference between editing the plan and editing the deck.
   *
   * The same printing in the same category is **two rows**, one per variant, so a write that
   * sent the wrong word would edit a real deck while the reader was looking at a plan.
   */
  it("writes to the variant it was opened on", async () => {
    const { result } = renderHook(() => useDeck(4, "theory"), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    await result.current.setQuantity.mutateAsync({
      cardId: "p1",
      categoryId: MAIN.id,
      quantity: 3,
    });
    expect(deckSetCardQuantity).toHaveBeenCalledWith(4, "p1", MAIN.id, "theory", 3);

    await result.current.addCard.mutateAsync({ cardId: "p2", categoryId: SIDE.id, quantity: 1 });
    expect(deckAddCard).toHaveBeenCalledWith(4, "p2", SIDE.id, null, "theory", 1);

    await result.current.moveCard.mutateAsync({ cardId: "p2", from: SIDE.id, to: MAIN.id });
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p2", SIDE.id, MAIN.id, "theory");
  });

  /** A deck the gallery has not refreshed since another view deleted it. `null` is the
   *  answer, not an error — and it is `deck: null` rather than a hook that throws. */
  it("answers with nothing for a deck that is gone", async () => {
    deckGet.mockResolvedValue(null);
    const { result } = renderHook(() => useDeck(4), { wrapper });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.deck).toBeNull();
    expect(result.current.cards).toEqual([]);
    expect(result.current.categories).toEqual([]);
    expect(result.current.tags).toEqual([]);
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

    await result.current.setQuantity.mutateAsync({
      cardId: "p1",
      categoryId: MAIN.id,
      quantity: 3,
    });

    expect(deckSetCardQuantity).toHaveBeenCalledWith(4, "p1", MAIN.id, "live", 3);
    expect(deckAddCard).not.toHaveBeenCalled();
  });

  /** Zero is a removal here, unlike the collection's: a category slot at zero holds no
   *  condition, no purchase price and no acquisition story, just a withdrawn intention. */
  it("empties a slot through the same write, and reads back that the row is gone", async () => {
    deckSetCardQuantity.mockResolvedValue({ id: 9, quantity: 0, removed: true });
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    const change = await result.current.setQuantity.mutateAsync({
      cardId: "p1",
      categoryId: MAIN.id,
      quantity: 0,
    });

    expect(deckSetCardQuantity).toHaveBeenCalledWith(4, "p1", MAIN.id, "live", 0);
    expect(change.removed).toBe(true);
  });

  it("adds and moves cards through the deck the hook was opened on", async () => {
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    await result.current.addCard.mutateAsync({
      cardId: "p2",
      categoryId: MAYBE.id,
      quantity: 1,
    });
    expect(deckAddCard).toHaveBeenCalledWith(4, "p2", MAYBE.id, null, "live", 1);

    await result.current.moveCard.mutateAsync({ cardId: "p2", from: MAYBE.id, to: SIDE.id });
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p2", MAYBE.id, SIDE.id, "live");
  });

  /**
   * The add with no column to point at — the docked panel's button under `Auto`, the toolbar's
   * quick add, and the sidebar's Decks drop target, none of which has a category under the
   * cursor.
   *
   * It sends a **name** instead, which `deck_add_card` finds or creates, and the name is
   * `autoCategoryFor`'s: the card's type line and nothing else. The rule is applied here, on the
   * one definition, and the *fact* it reads travels from the call site — which is what keeps
   * `autoCategoryFor` a single rule in TypeScript without any add paying a round trip to
   * discover what it is adding.
   */
  it("files an add that names no category by the card's type line", async () => {
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    await result.current.addCard.mutateAsync({
      cardId: "p2",
      typeLine: "Legendary Artifact",
      quantity: 1,
    });

    expect(deckAddCard).toHaveBeenCalledWith(4, "p2", null, "Artifact", "live", 1);
  });

  /**
   * A type line the rule has no bucket word for, and one that is missing outright — an orphan
   * whose printing has left `cards`, or a layout this app has no column for (a Dungeon, a Plane).
   *
   * Both answer `Uncategorised`, which is `autoCategoryFor`'s own answer and needs no second
   * fallback here. The pile is a real category the reader can rename, reorder or switch off; what
   * it may never be is `""`, which the backend's find-or-create would accept as a heading nobody
   * can see.
   */
  it("files a card it cannot place under Uncategorised", async () => {
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    await result.current.addCard.mutateAsync({ cardId: "p2", typeLine: null, quantity: 1 });
    expect(deckAddCard).toHaveBeenLastCalledWith(4, "p2", null, "Uncategorised", "live", 1);

    await result.current.addCard.mutateAsync({ cardId: "p2", typeLine: "Dungeon", quantity: 1 });
    expect(deckAddCard).toHaveBeenLastCalledWith(4, "p2", null, "Uncategorised", "live", 1);
  });

  /**
   * **Absent** is not `null`, and this is the difference: a caller that passes no type line at
   * all has said nothing about the card, where one passing `null` has said the app cannot
   * describe it. The first gets `DEFAULT_CATEGORY_NAME`, the second `Uncategorised`.
   *
   * No surface in the app takes this arm today — every add either points at a column or carries a
   * type line — so it is a fence, and the test is what says the fence is where it was left.
   */
  it("files an add that says nothing at all under the default pile", async () => {
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    await result.current.addCard.mutateAsync({ cardId: "p2", quantity: 1 });

    expect(deckAddCard).toHaveBeenCalledWith(4, "p2", null, "Main deck", "live", 1);
  });

  /** An explicit category wins outright, and no name is sent beside it — the drag path, and the
   *  panel's under a pick. A type line handed in with an id is simply not read. */
  it("ignores a type line when a category was named", async () => {
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    await result.current.addCard.mutateAsync({
      cardId: "p2",
      categoryId: SIDE.id,
      typeLine: "Artifact",
      quantity: 1,
    });

    expect(deckAddCard).toHaveBeenCalledWith(4, "p2", SIDE.id, null, "live", 1);
  });

  /**
   * The pane's "Use this printing", addressed like every other card write — by deck, card and
   * category — and the only one that names two cards: the printing being left and the one being
   * taken up.
   *
   * **No optimistic patch, deliberately**, where the stepper beside it has one: what the row
   * ends up holding is the *server's* arithmetic. A swap onto a printing the category already
   * has folds two rows into one, so a guess would have to delete a line and grow another — and a
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
      categoryId: MAIN.id,
    });

    await waitFor(() =>
      expect(deckSwapPrinting).toHaveBeenCalledWith(4, "p1", "p2", MAIN.id, "live"),
    );
    // Mid-flight, and the deck on screen is still the deck that was read: no guess was
    // written. This is what "no optimism" costs and buys — a beat of the old printing rather
    // than a line that disappears and comes back.
    expect(client.getQueryData(["decks", "detail", 4, "live"])).toEqual(DETAIL);

    answer({ folded: true, quantity: 7 });

    expect(await swap).toEqual({ folded: true, quantity: 7 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });
  });

  /**
   * Every card write reallocates (`allocate_deck` runs inside the same transaction), so
   * every `ownedQuantity` in this deck may have moved and the gallery's `cardCount` with it
   * — the `["decks"]` root, not this one detail.
   *
   * The **wishlist** is not touched, and that is the decision rather than an omission: a
   * card write moves `deck_allocations` and nothing else, and a wish's `ownedQuantity` is
   * summed from `collection_entries`. Only the one command that actually writes wishes takes
   * `["wishlist"]` with it.
   */
  it("refreshes every deck query after a card write, and the wishlist only when it wrote one", async () => {
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await result.current.setQuantity.mutateAsync({
      cardId: "p1",
      categoryId: MAIN.id,
      quantity: 3,
    });
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

  /**
   * The one tag a deck card carries — a **card** write, addressed by the same slot as the
   * stepper and the move, which is why it lives here rather than beside the tag CRUD in
   * `useDeckMeta`. The label is per-deck data; a card *wearing* one is a fact about a row.
   *
   * `null` is not a second command: untagging is a write to a nullable column.
   */
  it("tags and untags a card through the slot the row lives in", async () => {
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await result.current.setTag.mutateAsync({ cardId: "p1", categoryId: MAIN.id, tagId: 8 });
    expect(deckCardSetTag).toHaveBeenCalledWith(4, "p1", MAIN.id, "live", 8);

    await result.current.setTag.mutateAsync({ cardId: "p1", categoryId: MAIN.id, tagId: null });
    expect(deckCardSetTag).toHaveBeenCalledWith(4, "p1", MAIN.id, "live", null);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });
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

  /** The context's deck, all the way to the command — `decks.id` and `deck_categories.id` are
   *  both INTEGER keys and the mirror takes numbers. */
  it("swaps the context's deck row for the printing that was pressed", async () => {
    const { result } = renderHook(
      () =>
        useSwapFromPane({
          deckId: 4,
          categoryId: SIDE.id,
          categoryName: SIDE.name,
          cardId: "p1",
          // The list the pane was opened from. `live` here, so these keep addressing the list they
          // always did; the theory case is `CardDetailPane.test.tsx`'s, where the pane writes it.
          variant: "live",
        }),
      { wrapper },
    );

    const answer = await result.current.swap.mutateAsync({
      fromCardId: "p1",
      toCardId: "p2",
      categoryId: SIDE.id,
    });

    expect(deckSwapPrinting).toHaveBeenCalledWith(4, "p1", "p2", SIDE.id, "live");
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
   * reader would leave the category columns painting a deck that is gone while the pane says
   * why. The invalidation is that family's rule, moved onto the definition every observer
   * shares.
   */
  it("re-reads the deck when a swap is refused, whichever observer pressed it", async () => {
    deckSwapPrinting.mockRejectedValue("That deck is not there any more.");
    const { result } = renderHook(
      () =>
        useSwapFromPane({
          deckId: 4,
          categoryId: MAIN.id,
          categoryName: MAIN.name,
          cardId: "p1",
          // The list the pane was opened from. `live` here, so these keep addressing the list they
          // always did; the theory case is `CardDetailPane.test.tsx`'s, where the pane writes it.
          variant: "live",
        }),
      {
        wrapper,
      },
    );
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await expect(
      result.current.swap.mutateAsync({ fromCardId: "p1", toCardId: "p2", categoryId: MAIN.id }),
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
      () =>
        useSwapFromPane({
          deckId: 4,
          categoryId: MAIN.id,
          categoryName: MAIN.name,
          cardId: "p1",
          // The list the pane was opened from. `live` here, so these keep addressing the list they
          // always did; the theory case is `CardDetailPane.test.tsx`'s, where the pane writes it.
          variant: "live",
        }),
      {
        wrapper,
      },
    );

    expect(result.current.deckGone).toBe(false);

    await waitFor(() => expect(result.current.deckGone).toBe(true));
  });
});
