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
const deckCategoryClear = vi.hoisted(() => vi.fn());
const deckMoveCard = vi.hoisted(() => vi.fn());
const deckMissingToWishlist = vi.hoisted(() => vi.fn());
const deckSwapPrinting = vi.hoisted(() => vi.fn());
const deckCardSetTag = vi.hoisted(() => vi.fn());
const oracleTagsForPrintings = vi.hoisted(() => vi.fn());
const deckSetViewState = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    deckGet,
    deckAddCard,
    deckSetCardQuantity,
    deckCategoryClear,
    deckMoveCard,
    deckMissingToWishlist,
    deckSwapPrinting,
    deckCardSetTag,
    oracleTagsForPrintings,
    deckSetViewState,
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
  // until the reader turns it on, and turning it on *moves* the live list into theory, so the
  // deck they built becomes the plan rather than being duplicated into two lists that drift.
  coverKind: "card_art",
  folderId: null,
  notes: null,
  theoryEnabled: false,
  // How the editor was last read, written by `deckSetViewState` alone — `rememberView` below is
  // the only mutation here that touches them, and the only one that does not invalidate.
  lastVariant: "live",
  lastGroupBy: "category",
  lastSortBy: "alphabetical",
  // v13's, and off for the same reason `theoryEnabled` is: the plain curve until the reader
  // asks for the split. This hook never reads it — it is a `DeckPatch` field like any other and
  // rides through `update` untouched — so it is here to satisfy the row's shape, not to be
  // asserted on.
  separateXGroup: false,
  defaultCategoryId: 0,
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
  // All three are `user`: the two seeded zones are written that way, and "Main deck" is the
  // pile the v8 migration made, which holds real cards and is nobody's find-or-create.
  origin: "user",
  isActive: true,
  sortOrder: 0,
  cardCount: 4,
  totalPrice: 18,
  cardCountAllVariants: 4,
};
const SIDE: DeckCategory = {
  id: 2,
  deckId: 4,
  name: "Sideboard",
  kind: "side",
  origin: "user",
  isActive: true,
  sortOrder: 1,
  cardCount: 0,
  totalPrice: null,
  cardCountAllVariants: 0,
};
const MAYBE: DeckCategory = {
  id: 5,
  deckId: 4,
  name: "Maybeboard",
  kind: "maybe",
  origin: "user",
  isActive: false,
  sortOrder: 2,
  cardCount: 0,
  totalPrice: null,
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
  setName: "Limited Edition Alpha",
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
  unitPrice: 4.5,
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
  // The copies it removed — this command answers a number, not a row.
  deckCategoryClear.mockReset().mockResolvedValue(4);
  deckMoveCard.mockReset().mockResolvedValue(undefined);
  deckMissingToWishlist.mockReset().mockResolvedValue(2);
  deckSwapPrinting.mockReset().mockResolvedValue({ folded: false, quantity: 4 });
  deckCardSetTag.mockReset().mockResolvedValue(undefined);
  // A database that has never fetched the taxonomy — every card answers "no tags", which is
  // the state the app ships in and files every add by its type line. The tests that are about
  // the tags say so themselves.
  oracleTagsForPrintings.mockReset().mockResolvedValue([]);
  deckSetViewState.mockReset().mockResolvedValue(undefined);
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
    expect(deckGet).toHaveBeenCalledWith(4, "live", "tcgplayer");
    expect(result.current.cards).toEqual([BOLT]);
    // Every category, including the two holding nothing: the editor's columns are this list
    // rather than the piles that happen to be full.
    expect(result.current.categories).toEqual([MAIN, SIDE, MAYBE]);
    expect(result.current.tags).toEqual([]);
    expect(client.getQueryData(["decks", "detail", 4, "live", "tcgplayer"])).toEqual(DETAIL);
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
    expect(deckGet).toHaveBeenCalledWith(4, "theory", "tcgplayer");
    // Both answers are still there. Nothing was invalidated and nothing was re-read to get
    // here — a switch is a different question, not a stale answer to the same one.
    expect(client.getQueryData(["decks", "detail", 4, "live", "tcgplayer"])).toEqual(DETAIL);
    expect(client.getQueryData(["decks", "detail", 4, "theory", "tcgplayer"])).toEqual({
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
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p2", SIDE.id, MAIN.id, null, "theory");

    // The clear is variant-scoped like the rest, and that is the whole difference between it
    // and `deckCategoryDelete`, which takes both lists because the CASCADE does. Emptying the
    // deck while the reader is looking at the plan is the failure this pins.
    await result.current.clearCategory.mutateAsync(MAIN.id);
    expect(deckCategoryClear).toHaveBeenCalledWith(4, MAIN.id, "theory");
  });

  /**
   * **The clear is one command, never a `setQuantity(…, 0)` per row.**
   *
   * The rows are all in hand, so the loop would compile — and would be a transaction, an
   * allocator run and an invalidation per card. This asserts the shape rather than the count:
   * the stepper's command is not called at all.
   */
  it("empties a pile in one command rather than a stepper press per card", async () => {
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    const cleared = await result.current.clearCategory.mutateAsync(MAIN.id);

    expect(cleared).toBe(4);
    expect(deckCategoryClear).toHaveBeenCalledTimes(1);
    expect(deckSetCardQuantity).not.toHaveBeenCalled();
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
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p2", MAYBE.id, SIDE.id, null, "live");
  });

  /**
   * The add with no column to point at — the docked panel's button under `Auto`, the toolbar's
   * quick add, and the sidebar's Decks drop target, none of which has a category under the
   * cursor.
   *
   * It sends a **name** instead, which `deck_add_card` finds or creates, and the name is
   * `autoCategoryFor`'s. The rule is applied here, on the one definition, so a call site never
   * computes a pile name of its own.
   *
   * This is the **untagged** floor and the default this file mocks: a card the taxonomy has
   * nothing to say about — or an app whose taxonomy has never been downloaded — is filed by its
   * type line exactly as every add was before the tags existed. The read still happens, because
   * the only way to know there is nothing to say is to ask.
   */
  it("files an add that names no category by the card's type line", async () => {
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    await result.current.addCard.mutateAsync({
      cardId: "p2",
      typeLine: "Legendary Artifact",
      quantity: 1,
    });

    expect(oracleTagsForPrintings).toHaveBeenCalledWith(["p2"]);
    expect(deckAddCard).toHaveBeenCalledWith(4, "p2", null, "Artifact", "live", 1);
  });

  /**
   * **A decklist is written by function, so an add with no column asks what the card *does*.**
   *
   * Lightning Bolt's type line is `Instant`, and nobody has ever built a deck with a column
   * called Instant — they build one with Removal in it. The tags are the fact
   * (`oracle_tags_for_printings`, one printing id), `autoCategoryFor` is the conclusion, and the
   * name is what `deck_add_card` finds or creates. `Instant` here would mean the fetch is not
   * wired in at all, which is the regression this protects.
   *
   * **The decoy first entry is the second half of the test.** The command drops blank and
   * duplicate ids, so its answer can be shorter than the request and in no promised order —
   * `answers[0]` is a read that works until the day it silently files a card by another card's
   * tags. A positional read gets `Ramp` here.
   */
  it("files an add that names no category by what the card does", async () => {
    oracleTagsForPrintings.mockResolvedValue([
      { cardId: "elsewhere", slugs: ["ramp"] },
      { cardId: "p2", slugs: ["removal"] },
    ]);
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    await result.current.addCard.mutateAsync({ cardId: "p2", typeLine: "Instant", quantity: 1 });

    // One card, asked about by the printing id being added — not the whole deck, and not the
    // oracle id, which no drag payload carries.
    expect(oracleTagsForPrintings).toHaveBeenCalledWith(["p2"]);
    expect(deckAddCard).toHaveBeenCalledWith(4, "p2", null, "Removal", "live", 1);
  });

  /**
   * The same add against a card the taxonomy answers **empty** for — an untagged card, a
   * printing whose `oracle_id` is NULL, or an id `cards` does not have, all of which come back
   * `slugs: []` on purpose.
   *
   * The type line is the answer then, and that path is the floor rather than an error case: it
   * is what this app does before the tag dataset has ever downloaded, and if it never does.
   * Paired with the test above deliberately — one card id, one type line, two answers, and the
   * pile follows the tags.
   */
  it("falls back to the type line when the card has no tags", async () => {
    oracleTagsForPrintings.mockResolvedValue([{ cardId: "p2", slugs: [] }]);
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    await result.current.addCard.mutateAsync({ cardId: "p2", typeLine: "Instant", quantity: 1 });

    expect(deckAddCard).toHaveBeenCalledWith(4, "p2", null, "Instant", "live", 1);
  });

  /**
   * `refileCard` — the quick zones' `Auto` for a card the deck already holds, and the add rule
   * above read backwards.
   *
   * **The same three steps in the same order**, which is the point of it being here rather than a
   * second implementation somewhere: the card's tags, `autoCategoryFor`, then a command that
   * finds-or-creates the pile that names. It sends the **name arm** — `toCategoryId` null — so
   * the pile is resolved inside the move's own transaction and a pile the app invents comes out
   * `origin: 'auto'`.
   */
  it("re-files a deck card by what it does, through the move's name arm", async () => {
    oracleTagsForPrintings.mockResolvedValue([{ cardId: "p2", slugs: ["removal"] }]);
    deckMoveCard.mockResolvedValue(31);
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    const answer = await result.current.refileCard.mutateAsync({
      cardId: "p2",
      from: MAIN.id,
      typeLine: "Instant",
      categoryName: MAIN.name,
    });

    expect(oracleTagsForPrintings).toHaveBeenCalledWith(["p2"]);
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p2", MAIN.id, null, "Removal", "live");
    // The id the command answered with, which is what the caret is handed — the caller has no
    // other way to learn what was found or made.
    expect(answer).toEqual({ moved: true, category: "Removal", categoryId: 31 });
  });

  /**
   * **A card already in the pile the rule names writes nothing and reaches IPC not at all.**
   *
   * The comparison is against the row's own `categoryName`, which the caller is holding, so
   * "press it again" costs one tag read and no round trip. `moved: false` is an answer rather
   * than a failure and `categoryId` is `null`, because there is nowhere to send the caret.
   */
  it("says a card is already filed rather than moving it to where it is", async () => {
    oracleTagsForPrintings.mockResolvedValue([{ cardId: "p2", slugs: ["removal"] }]);
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    const answer = await result.current.refileCard.mutateAsync({
      cardId: "p2",
      from: MAIN.id,
      typeLine: "Instant",
      categoryName: "Removal",
    });

    expect(answer).toEqual({ moved: false, category: "Removal", categoryId: null });
    expect(deckMoveCard).not.toHaveBeenCalled();
  });

  /**
   * A card the rule cannot place goes to **`Uncategorized`, a pile like any other** (changed
   * 2026-08-16). It used to be left where it was, on the argument that moving a card out of a
   * pile somebody chose into the bin is a downgrade dressed as tidying — which is still what
   * `useDeckMeta.autoCategorise` does, and still right *there*, because that press is over every
   * loose card in the deck at once. Here the reader picked up one card and pointed at `Auto`.
   *
   * It travels through the same **name arm** as any other answer, so the pile is found or made
   * by `category_for_name` and arrives `origin: 'auto'` — which is what lets it leave the desk
   * again with its last card.
   */
  it("files a card the rule cannot place under Uncategorized", async () => {
    oracleTagsForPrintings.mockResolvedValue([{ cardId: "p2", slugs: [] }]);
    deckMoveCard.mockResolvedValue(77);
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    const answer = await result.current.refileCard.mutateAsync({
      cardId: "p2",
      from: MAIN.id,
      typeLine: null,
      categoryName: MAIN.name,
    });

    expect(answer).toEqual({ moved: true, category: "Uncategorized", categoryId: 77 });
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p2", MAIN.id, null, "Uncategorized", "live");
  });

  /** And a card **already** in that pile is the one press that still writes nothing — the only
   *  no-op left, now that being unplaceable is a destination rather than a refusal. */
  it("says a card already in Uncategorized is already filed", async () => {
    oracleTagsForPrintings.mockResolvedValue([{ cardId: "p2", slugs: [] }]);
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    const answer = await result.current.refileCard.mutateAsync({
      cardId: "p2",
      from: MAIN.id,
      typeLine: null,
      categoryName: "Uncategorized",
    });

    expect(answer).toEqual({ moved: false, category: "Uncategorized", categoryId: null });
    expect(deckMoveCard).not.toHaveBeenCalled();
  });

  /** A refused tag read never fails a re-file, exactly as it never fails an add: `oracleTagsFor`
   *  catches and answers `[]`, so the card files by its type line instead. */
  it("re-files by type line when the tag read is refused", async () => {
    oracleTagsForPrintings.mockRejectedValue("the database is busy");
    deckMoveCard.mockResolvedValue(12);
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    const answer = await result.current.refileCard.mutateAsync({
      cardId: "p2",
      from: MAIN.id,
      typeLine: "Artifact",
      categoryName: MAIN.name,
    });

    expect(answer.moved).toBe(true);
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p2", MAIN.id, null, "Artifact", "live");
  });

  /**
   * **Land is pinned by the type line before a single tag is consulted**, and this is the add
   * path proving it end to end rather than `autoCategoryFor` proving it alone.
   *
   * 52% of lands carry a functional tag — Prismatic Vista is tagged `tutor` because it searches,
   * Savai Triome `card-advantage` because it cycles — so a rule that read the tags first would
   * scatter a deck's mana base across a dozen columns, with fetchlands under a Tutor heading. A
   * mana base is the one pile every decklist draws whole.
   */
  it("files a land as a land whatever its tags say", async () => {
    oracleTagsForPrintings.mockResolvedValue([{ cardId: "p2", slugs: ["tutor"] }]);
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    await result.current.addCard.mutateAsync({ cardId: "p2", typeLine: "Land", quantity: 1 });

    expect(deckAddCard).toHaveBeenCalledWith(4, "p2", null, "Land", "live", 1);
  });

  /**
   * **A tag read that fails must not fail the add.** The card still lands — in its type-line
   * pile, which is where every card landed before the taxonomy existed.
   *
   * Losing the taxonomy for one add costs the reader a worse pile, which they can drag; a
   * refused add costs them a card they have to notice is missing. The catch in `oracleTagsFor`
   * is the whole of this, and it is exactly the kind of thing a later reader tidies into a
   * rethrow — so this test is what says no.
   */
  it("still adds the card when the tag read is refused", async () => {
    oracleTagsForPrintings.mockRejectedValue(new Error("database is locked"));
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    const change = await result.current.addCard.mutateAsync({
      cardId: "p2",
      typeLine: "Instant",
      quantity: 1,
    });

    expect(deckAddCard).toHaveBeenCalledWith(4, "p2", null, "Instant", "live", 1);
    expect(change).toEqual({ id: 9, quantity: 4, removed: false });
  });

  /**
   * A type line the rule has no bucket word for, and one that is missing outright — an orphan
   * whose printing has left `cards`, or a layout this app has no column for (a Dungeon, a Plane).
   *
   * Both answer `Uncategorized`, which is `autoCategoryFor`'s own answer and needs no second
   * fallback here — with no tags to go on either, which is this file's default. The pile is a
   * real category the reader can rename, reorder or switch off; what it may never be is `""`,
   * which the backend's find-or-create would accept as a heading nobody can see.
   */
  it("files a card it cannot place under Uncategorized", async () => {
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    await result.current.addCard.mutateAsync({ cardId: "p2", typeLine: null, quantity: 1 });
    expect(deckAddCard).toHaveBeenLastCalledWith(4, "p2", null, "Uncategorized", "live", 1);

    await result.current.addCard.mutateAsync({ cardId: "p2", typeLine: "Dungeon", quantity: 1 });
    expect(deckAddCard).toHaveBeenLastCalledWith(4, "p2", null, "Uncategorized", "live", 1);
  });

  /**
   * **Absent** is not `null`, and this is the difference: a caller that passes no type line at
   * all has said nothing about the card, where one passing `null` has said the app cannot
   * describe it. The first gets `DEFAULT_CATEGORY_NAME`, the second `Uncategorized`.
   *
   * No surface in the app takes this arm today — every add either points at a column or carries a
   * type line — so it is a fence, and the test is what says the fence is where it was left.
   *
   * **And it asks the taxonomy nothing.** A caller that said nothing about the card is not asking
   * to have it filed, so there is no rule to run and no fact to fetch: the default pile is the
   * answer without a round trip.
   */
  it("files an add that says nothing at all under the default pile", async () => {
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    await result.current.addCard.mutateAsync({ cardId: "p2", quantity: 1 });

    expect(deckAddCard).toHaveBeenCalledWith(4, "p2", null, "Main deck", "live", 1);
    expect(oracleTagsForPrintings).not.toHaveBeenCalled();
  });

  /**
   * An explicit category wins outright, and no name is sent beside it — the drag path, and the
   * panel's under a pick. A type line handed in with an id is simply not read.
   *
   * **And nothing is asked about the card at all.** Pointing at a column *is* naming a category,
   * so no rule runs — and a drop that paid a tag read on the way to a pile the reader had already
   * chosen would be a round trip bought for nothing, on the one interaction in this app where a
   * gesture is being answered in place.
   */
  it("ignores a type line when a category was named, and asks nothing about the card", async () => {
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    await result.current.addCard.mutateAsync({
      cardId: "p2",
      categoryId: SIDE.id,
      typeLine: "Artifact",
      quantity: 1,
    });

    expect(deckAddCard).toHaveBeenCalledWith(4, "p2", SIDE.id, null, "live", 1);
    expect(oracleTagsForPrintings).not.toHaveBeenCalled();
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
    expect(client.getQueryData(["decks", "detail", 4, "live", "tcgplayer"])).toEqual(DETAIL);

    answer({ folded: true, quantity: 7 });

    expect(await swap).toEqual({ folded: true, quantity: 7 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });
  });

  /**
   * How the reader is *looking* at the deck, stored — and the one write here that
   * **deliberately does not invalidate**.
   *
   * The editor is already showing what was pressed: this write only makes the choice survive
   * the deck being closed, so there is nothing to re-read. Invalidating would refetch the deck
   * row and hand the editor back the three fields it restores from a beat after the press —
   * which is how a second press made inside that beat gets undone by the first one's echo. It
   * is also what keeps the round trip from looping at all.
   */
  it("remembers how the deck is being read without re-reading the deck", async () => {
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await result.current.rememberView.mutateAsync({ variant: "theory" });

    expect(deckSetViewState).toHaveBeenCalledWith(4, { variant: "theory" });
    expect(invalidate).not.toHaveBeenCalled();
    // And nothing was re-read, which is the consequence the reader would actually feel: one
    // `deck_get`, from opening the deck.
    expect(deckGet).toHaveBeenCalledTimes(1);
  });

  /** One field at a time, because that is what the editor sends — the control that moved, and
   *  `DeckViewState`'s absent-means-leave-it rule for the two that did not. */
  it("sends only the field that moved", async () => {
    const { result } = renderHook(() => useDeck(4), { wrapper });
    await waitFor(() => expect(result.current.deck).toEqual(DECK));

    await result.current.rememberView.mutateAsync({ groupBy: "manaValue" });
    expect(deckSetViewState).toHaveBeenLastCalledWith(4, { groupBy: "manaValue" });

    await result.current.rememberView.mutateAsync({ sortBy: "price" });
    expect(deckSetViewState).toHaveBeenLastCalledWith(4, { sortBy: "price" });
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
