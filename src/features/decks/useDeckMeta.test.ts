import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { DeckCard, DeckCategory, DeckTag, DeckVariant, GlobalTag } from "@/lib/ipc";

const deckCategoryList = vi.hoisted(() => vi.fn());
const deckCategoryCreate = vi.hoisted(() => vi.fn());
const deckCategoryRename = vi.hoisted(() => vi.fn());
const deckCategorySetActive = vi.hoisted(() => vi.fn());
const deckCategoryReorder = vi.hoisted(() => vi.fn());
const deckCategoryDelete = vi.hoisted(() => vi.fn());
const deckTagList = vi.hoisted(() => vi.fn());
const deckTagCreate = vi.hoisted(() => vi.fn());
const deckTagUpdate = vi.hoisted(() => vi.fn());
const deckTagDelete = vi.hoisted(() => vi.fn());
const deckTagRemoveFromDeck = vi.hoisted(() => vi.fn());
const deckTagAll = vi.hoisted(() => vi.fn());
const deckMoveCard = vi.hoisted(() => vi.fn());
/** The one read `autoCategorise` makes that is not a deck command: what these cards *do*. */
const oracleTagsForPrintings = vi.hoisted(() => vi.fn());
const deckDrivenCollection = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    deckCategoryList,
    deckCategoryCreate,
    deckCategoryRename,
    deckCategorySetActive,
    deckCategoryReorder,
    deckCategoryDelete,
    deckTagList,
    deckTagCreate,
    deckTagUpdate,
    deckTagDelete,
    deckTagRemoveFromDeck,
    deckTagAll,
    deckMoveCard,
    oracleTagsForPrintings,
    deckDrivenCollection,
  },
}));

import { DECK_DRIVEN_KEY } from "@/lib/useDeckDrivenCollection";
import { useDeckMeta } from "./useDeckMeta";

function category(over: Partial<DeckCategory> & { id: number; name: string }): DeckCategory {
  return {
    deckId: 4,
    kind: "main",
    // Before the spread, so a caller can ask for `auto` — the default is the schema's, and it
    // is what keeps a pile in these fixtures drawn when it holds nothing.
    origin: "user",
    isActive: true,
    sortOrder: 0,
    cardCount: 0,
    totalPrice: null,
    // Both lists, defaulting to the one-list count — the shape the backend can produce. Only
    // the delete confirmation reads it.
    cardCountAllVariants: over.cardCount ?? 0,
    ...over,
  };
}

/** The pile the v8 migration files every legacy main-deck row into, and the one thing
 *  `autoCategorise` is allowed to empty. */
const MAIN = category({ id: 1, name: "Main deck", cardCount: 4 });
/** A column the reader made. Auto-categorise must never touch this one. */
const REMOVAL = category({ id: 2, name: "Removal", sortOrder: 1 });
const MAYBE = category({ id: 3, name: "Maybeboard", kind: "maybe", isActive: false, sortOrder: 2 });

/** What this deck's live list is wearing — `deck_tag_list`'s row, which since schema v21 can
 *  only ever be a tag some card here has on. */
const CUT: DeckTag = { id: 8, name: "Cut candidate", color: "ember", cardCount: 1 };

/** The same tag as the app sees it, plus one nothing wears — `deck_tag_all`'s rows, and the only
 *  list that can answer the second. */
const EVERY_TAG: GlobalTag[] = [
  { id: 8, name: "Cut candidate", color: "ember", cardCount: 6, deckCount: 3 },
  { id: 9, name: "Combo piece", color: "gold", cardCount: 0, deckCount: 0 },
];

/** A deck card in a named pile. Only the fields `autoCategorise` reads are interesting; the
 *  rest are filled so the fixture is a real {@link DeckCard} and not a cast. */
function card(over: Partial<DeckCard> & { cardId: string }): DeckCard {
  return {
    promoTypes: null,
    id: 1,
    categoryId: MAIN.id,
    categoryName: MAIN.name,
    categoryKind: "main",
    categoryActive: true,
    variant: "live",
    finish: null,
    tagId: null,
    tagName: null,
    tagColor: null,
    quantity: 1,
    name: "A card",
    setCode: "lea",
    setName: "Limited Edition Alpha",
    collectorNumber: "1",
    lang: "en",
    needsReview: null,
    oracleId: "o1",
    manaCost: null,
    cmc: null,
    typeLine: null,
    oracleText: null,
    colors: null,
    colorIdentity: null,
    legalities: null,
    power: null,
    toughness: null,
    layout: null,
    rarity: null,
    faces: null,
    gameChanger: null,
    finishes: null,
    everUncommon: false,
    unitPrice: null,
    ownedQuantity: 0,
    ...over,
  };
}

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  deckCategoryList.mockReset().mockResolvedValue([MAIN, REMOVAL, MAYBE]);
  deckCategoryCreate.mockReset().mockResolvedValue(category({ id: 40, name: "Creature" }));
  deckCategoryRename.mockReset().mockResolvedValue(MAIN);
  deckCategorySetActive.mockReset().mockResolvedValue({ ...MAYBE, isActive: true });
  deckCategoryReorder.mockReset().mockResolvedValue([REMOVAL, MAIN, MAYBE]);
  deckCategoryDelete.mockReset().mockResolvedValue(undefined);
  deckTagList.mockReset().mockResolvedValue([CUT]);
  deckTagCreate.mockReset().mockResolvedValue(CUT);
  deckTagUpdate.mockReset().mockResolvedValue(CUT);
  deckTagDelete.mockReset().mockResolvedValue(undefined);
  deckTagRemoveFromDeck.mockReset().mockResolvedValue(1);
  deckTagAll.mockReset().mockResolvedValue(EVERY_TAG);
  deckMoveCard.mockReset().mockResolvedValue(undefined);
  // The shape of a database that has never ingested the taxonomy, which is the app's supported
  // floor: every card answers no slugs and the type line decides. A test about tags says so.
  oracleTagsForPrintings.mockReset().mockResolvedValue([]);
  // The hand-kept collection, which is the app's default. The derived tests seed
  // `DECK_DRIVEN_KEY` instead — `staleTime: Infinity` means the seed is never re-asked.
  deckDrivenCollection.mockReset().mockResolvedValue(false);
});

/**
 * One fresh answer on each root a deck write can make wrong — `useDeck.test.ts`'s helper, and
 * its reasoning: `src/lib/query.ts` sets `staleTime: 30_000`, so a cached answer is *fresh* and
 * mounting the page it belongs to refetches nothing. `isInvalidated` is the whole of what the
 * Collection page has to go on.
 */
const OWNED_CACHES: readonly (readonly string[])[] = [
  ["collection", "list", "{}"],
  ["cards", "search", "{}"],
  ["decks", "list"],
  ["wishlist", "list", "{}"],
];

function seedOwned(c: QueryClient): void {
  for (const key of OWNED_CACHES) c.setQueryData(key, { items: [], total: 0 });
}

const staleRoots = (c: QueryClient): string[] =>
  OWNED_CACHES.filter((key) => c.getQueryState(key)?.isInvalidated === true)
    .map((key) => key[0])
    .sort();

/**
 * A category switch is a collection write while the collection is derived, and it is the write
 * in this file that has the reach.
 *
 * `setCategoryActive` and `deleteCategory` reallocate inside their own transaction — the switch
 * is what decides whether a pile's cards are claimed at all — and in the derived mode a claim is
 * not an attribution of an owned copy, it *is* the owned copy. Switching a pile off empties
 * every one of its rows out of the collection page without a single card being touched.
 */
describe("useDeckMeta while the collection is deck driven", () => {
  it("marks the whole of what the reader owns stale when a category is switched off", async () => {
    client.setQueryData(DECK_DRIVEN_KEY, true);
    seedOwned(client);
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });
    await waitFor(() => expect(result.current.categories).toHaveLength(3));
    expect(staleRoots(client)).toEqual([]);

    await result.current.setCategoryActive.mutateAsync({ id: 3, isActive: false });

    await waitFor(() =>
      expect(staleRoots(client)).toEqual(["cards", "collection", "decks", "wishlist"]),
    );
  });

  /** Additively: `["decks"]` is the floor in both modes, because the switch moves
   *  `deck_allocations` whether or not the collection is derived from it. */
  it("marks only the decks stale while the collection is hand kept", async () => {
    seedOwned(client);
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });
    await waitFor(() => expect(result.current.categories).toHaveLength(3));

    await result.current.setCategoryActive.mutateAsync({ id: 3, isActive: false });

    await waitFor(() => expect(staleRoots(client)).toEqual(["decks"]));
  });
});

describe("useDeckMeta", () => {
  /** The Decks view mounts with no deck open, and the only surface that wants any of this is a
   *  panel inside an editor — including the app-wide tag list, which has no deck in its command
   *  but no reader either until a tag dialog is up. */
  it("asks for nothing until a deck is open", () => {
    renderHook(() => useDeckMeta(null), { wrapper });

    expect(deckCategoryList).not.toHaveBeenCalled();
    expect(deckTagList).not.toHaveBeenCalled();
    expect(deckTagAll).not.toHaveBeenCalled();
  });

  it("reads the piles, what this list wears, and every tag there is", async () => {
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });

    await waitFor(() => expect(result.current.categories).toEqual([MAIN, REMOVAL, MAYBE]));
    expect(deckCategoryList).toHaveBeenCalledWith(4, "live", "tcgplayer");
    expect(result.current.tags).toEqual([CUT]);
    expect(deckTagList).toHaveBeenCalledWith(4, "live");
    // App-wide, and it takes no deck at all: one tag list belongs to the app, so the second
    // row here is a label no card anywhere is wearing — which `deckTagList` can never answer.
    await waitFor(() => expect(result.current.allTags).toEqual(EVERY_TAG));
    expect(deckTagAll).toHaveBeenCalledWith();
  });

  /**
   * **The two destructive tag writes are different commands**, and the split is the point of
   * the app-wide list: one takes the label off this deck's list on screen, the other takes the
   * label out of the app. Conflating them would mean a reader tidying one deck stripping a
   * label off every other deck wearing it.
   *
   * `removeTagFromDeck` carries the hook's own variant, because the row it is pressed on was
   * drawn from that list.
   */
  it("sends the deck it is standing in with every tag write, and scopes the remove by variant", async () => {
    const { result } = renderHook(() => useDeckMeta(4, "theory"), { wrapper });
    await waitFor(() => expect(result.current.tags).toEqual([CUT]));

    result.current.updateTag.mutate({ id: 8, name: "Cut", color: "#0e68ab" });
    await waitFor(() => expect(deckTagUpdate).toHaveBeenCalledWith(4, 8, "Cut", "#0e68ab"));

    result.current.removeTagFromDeck.mutate(8);
    await waitFor(() => expect(deckTagRemoveFromDeck).toHaveBeenCalledWith(4, 8, "theory"));

    result.current.deleteTag.mutate(8);
    await waitFor(() => expect(deckTagDelete).toHaveBeenCalledWith(4, 8));
  });

  /**
   * **The variant scopes the counts and nothing else**, and it is in the key so the two
   * answers are cached side by side rather than one replacing the other.
   *
   * Which categories a deck has, what they are called and what order they are in are facts
   * about the *deck*; only `cardCount` and `totalPrice` are about one of its two lists. So a
   * Live/Theory switch changes the numbers in the headings, never the headings.
   */
  it("caches each variant's counts under its own key", async () => {
    const theory = [{ ...MAIN, cardCount: 1 }, REMOVAL, MAYBE];
    deckCategoryList.mockImplementation((_id: number, variant: string) =>
      Promise.resolve(variant === "theory" ? theory : [MAIN, REMOVAL, MAYBE]),
    );
    const { result, rerender } = renderHook(
      ({ variant }: { variant: DeckVariant }) => useDeckMeta(4, variant),
      { wrapper, initialProps: { variant: "live" as DeckVariant } },
    );
    await waitFor(() => expect(result.current.categories).toEqual([MAIN, REMOVAL, MAYBE]));

    rerender({ variant: "theory" });

    await waitFor(() => expect(result.current.categories).toEqual(theory));
    expect(deckCategoryList).toHaveBeenCalledWith(4, "theory", "tcgplayer");
    // Both answers are still there: flipping back is a cache hit, not a re-read.
    expect(client.getQueryData(["decks", "categories", 4, "live", "tcgplayer"])).toEqual([
      MAIN,
      REMOVAL,
      MAYBE,
    ]);
    expect(client.getQueryData(["decks", "categories", 4, "theory", "tcgplayer"])).toEqual(theory);
  });

  it("sends every category write to the command that owns it", async () => {
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });
    await waitFor(() => expect(result.current.categories).toHaveLength(3));

    await result.current.createCategory.mutateAsync("Creature");
    expect(deckCategoryCreate).toHaveBeenCalledWith(4, "Creature");

    // `id`, not `deckId`: a category names its own deck, so the three writes about **one**
    // category do not repeat it.
    await result.current.renameCategory.mutateAsync({ id: 1, name: "Spells" });
    expect(deckCategoryRename).toHaveBeenCalledWith(1, "Spells");

    await result.current.setCategoryActive.mutateAsync({ id: 3, isActive: true });
    expect(deckCategorySetActive).toHaveBeenCalledWith(3, true);

    // Every id, in the new order — `sort_order` is written from position, so this is the order
    // rather than a move.
    await result.current.reorderCategories.mutateAsync([2, 1, 3]);
    expect(deckCategoryReorder).toHaveBeenCalledWith(4, [2, 1, 3]);

    await result.current.deleteCategory.mutateAsync({ id: 2, moveToCategoryId: 1 });
    expect(deckCategoryDelete).toHaveBeenCalledWith(2, 1);

    // `null` is not "no argument": it is the destructive half of the same command, where the
    // cards go with the category by cascade.
    await result.current.deleteCategory.mutateAsync({ id: 2, moveToCategoryId: null });
    expect(deckCategoryDelete).toHaveBeenCalledWith(2, null);
  });

  it("sends every tag write to the command that owns it", async () => {
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });
    await waitFor(() => expect(result.current.tags).toEqual([CUT]));

    await result.current.createTag.mutateAsync({ name: "Cut candidate", color: "ember" });
    expect(deckTagCreate).toHaveBeenCalledWith(4, "Cut candidate", "ember");

    // One command for the rename and the recolour, and both are required: there is no patch
    // shape, so a caller changing one sends the other back unchanged.
    await result.current.updateTag.mutateAsync({ id: 8, name: "Cut", color: "moss" });
    expect(deckTagUpdate).toHaveBeenCalledWith(4, 8, "Cut", "moss");

    await result.current.deleteTag.mutateAsync(8);
    expect(deckTagDelete).toHaveBeenCalledWith(4, 8);

    // The other destructive one, and the distinction the app-wide list needed: it takes the
    // label off this deck's list and leaves the tag standing.
    await result.current.removeTagFromDeck.mutateAsync(8);
    expect(deckTagRemoveFromDeck).toHaveBeenCalledWith(4, 8, "live");
  });

  /**
   * The whole `["decks"]` root from every write, on success **and** on error, on the definition
   * rather than on a call site.
   *
   * Two of these reallocate — the switch decides whether a card is claimed at all, so flipping
   * it moves `ownedQuantity` in this deck and in every other one — and the rest rewrite a list
   * the editor's columns are drawn from. And a refusal is a busy database or a category another
   * surface deleted, which must not leave a panel drawing a column that is gone.
   */
  it("refreshes every deck query after a write, and after a refused one", async () => {
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });
    await waitFor(() => expect(result.current.categories).toHaveLength(3));
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await result.current.setCategoryActive.mutateAsync({ id: 3, isActive: true });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] });

    invalidate.mockClear();
    deckCategoryRename.mockRejectedValue("That category is not there any more.");
    await expect(result.current.renameCategory.mutateAsync({ id: 9, name: "x" })).rejects.toBe(
      "That category is not there any more.",
    );
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["decks"] }));
  });
});

/**
 * "File cards by what they do" — the one rule in `autoCategory.ts`, pressed once.
 *
 * The rule itself is tested where it lives; what these pin is the **orchestration**, which is
 * where this feature can destroy a reader's work: which piles it is allowed to empty, which
 * cards it leaves alone, that the fact the rule reads is fetched **once** for the whole press,
 * and that a press which cannot read that fact moves nothing at all.
 */
describe("useDeckMeta.autoCategorise", () => {
  const CREATURE = card({ cardId: "p1", name: "Grizzly Bears", typeLine: "Creature — Bear" });
  const LAND = card({ cardId: "p2", name: "Forest", typeLine: "Basic Land — Forest" });
  /** An Instant by type and Removal by function — the card the whole change is about. */
  const SWORDS = card({ cardId: "p5", name: "Swords to Plowshares", typeLine: "Instant" });

  /**
   * What a card **does** beats what it **is**, and a card nobody has tagged still lands
   * somewhere.
   *
   * Both halves in one test on purpose: they are the two arms of a single rule, and the second
   * is what makes the first safe to ship before the taxonomy has ever been downloaded. The
   * answer names only `p5`, so `p1` is filed by its type line — which is also the shape of an
   * answer shorter than the request, the reason nothing here reads it by position.
   */
  it("files a card by what it does, and a card with no tags by its type line", async () => {
    oracleTagsForPrintings.mockResolvedValue([{ cardId: "p5", slugs: ["removal"] }]);
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });
    await waitFor(() => expect(result.current.categories).toHaveLength(3));

    const moved = await result.current.autoCategorise.mutateAsync([SWORDS, CREATURE]);

    expect(moved).toBe(2);
    expect(oracleTagsForPrintings).toHaveBeenCalledWith(["p5", "p1"]);
    // The deck already has a Removal column, so the tagged card joins it rather than making a
    // second one; the untagged one gets the type pile it has always got.
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p5", MAIN.id, REMOVAL.id, null, "live", null);
    expect(deckCategoryCreate).toHaveBeenCalledWith(4, "Creature");
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p1", MAIN.id, 40, null, "live", null);
  });

  /**
   * **Land is pinned by type, before a tag is consulted.** Half of Scryfall's lands carry a
   * functional tag — Prismatic Vista searches, so it is tagged `tutor` — and a mana base
   * scattered across a dozen columns is the one pile every decklist draws whole.
   */
  it("files a land as Land whatever its tags say", async () => {
    oracleTagsForPrintings.mockResolvedValue([{ cardId: "p6", slugs: ["tutor"] }]);
    deckCategoryCreate.mockResolvedValue(category({ id: 43, name: "Land" }));
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });
    await waitFor(() => expect(result.current.categories).toHaveLength(3));

    const moved = await result.current.autoCategorise.mutateAsync([
      card({ cardId: "p6", name: "Prismatic Vista", typeLine: "Land" }),
    ]);

    expect(moved).toBe(1);
    expect(deckCategoryCreate).toHaveBeenCalledWith(4, "Land");
    expect(deckCategoryCreate).not.toHaveBeenCalledWith(4, "Tutor");
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p6", MAIN.id, 43, null, "live", null);
  });

  /**
   * **One tag read for the press, whatever the deck's size.** One read per card would be a
   * hundred `invoke`s behind a single button, and the command batches 500 ids to a statement
   * precisely so that nobody has to.
   */
  it("asks what a whole deck does once, not once a card", async () => {
    const deck = Array.from({ length: 100 }, (_, i) =>
      card({ cardId: `c${i}`, typeLine: "Creature — Bear" }),
    );
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });
    await waitFor(() => expect(result.current.categories).toHaveLength(3));

    const moved = await result.current.autoCategorise.mutateAsync(deck);

    expect(moved).toBe(100);
    expect(oracleTagsForPrintings).toHaveBeenCalledTimes(1);
    expect(oracleTagsForPrintings.mock.calls[0][0]).toHaveLength(100);
    // And one pile made for the hundred of them, not one each.
    expect(deckCategoryCreate).toHaveBeenCalledTimes(1);
  });

  /**
   * **The answers are matched back by `cardId`, never by position**, and this is the deck shape
   * that proves it: one printing sitting in two loose piles asks about one id and files two
   * rows. A reader who imported a list and then dragged a copy into the maybe-pile-that-was has
   * exactly this deck.
   */
  it("files both rows when one printing sits in two loose piles", async () => {
    const LOOSE = category({ id: 9, name: "Uncategorized", sortOrder: 3 });
    const RAMP = category({ id: 10, name: "Ramp", sortOrder: 4 });
    deckCategoryList.mockResolvedValue([MAIN, LOOSE, RAMP]);
    oracleTagsForPrintings.mockResolvedValue([{ cardId: "p7", slugs: ["ramp"] }]);
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });
    await waitFor(() => expect(result.current.categories).toHaveLength(3));

    const moved = await result.current.autoCategorise.mutateAsync([
      card({ cardId: "p7", name: "Sol Ring", typeLine: "Artifact" }),
      card({
        id: 2,
        cardId: "p7",
        name: "Sol Ring",
        typeLine: "Artifact",
        categoryId: LOOSE.id,
        categoryName: LOOSE.name,
      }),
    ]);

    expect(moved).toBe(2);
    // Asked once, about one id — the second row costs no read and is filed by the same slugs.
    expect(oracleTagsForPrintings).toHaveBeenCalledWith(["p7"]);
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p7", MAIN.id, RAMP.id, null, "live", null);
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p7", LOOSE.id, RAMP.id, null, "live", null);
  });

  /**
   * **A refused tag read refuses the press.** The alternative — file the whole deck by type
   * line instead — is not the cautious answer it looks like: it is a different filing of every
   * pile at once, under a button that promised to file by function, and the way back is one
   * card at a time. An *empty* answer is a different fact and does fall through to the type
   * line; that is the arm two tests above.
   *
   * The sentence keeps the backend's own words after its own, because "nothing moved" and "the
   * database is busy" are both news and only one of them is guessable.
   */
  it("refuses the whole press when the tag read is refused, and moves nothing", async () => {
    oracleTagsForPrintings.mockRejectedValue("The database is busy.");
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });
    await waitFor(() => expect(result.current.categories).toHaveLength(3));

    await expect(
      result.current.autoCategorise.mutateAsync([SWORDS, CREATURE, LAND]),
    ).rejects.toThrow(/^Nothing was filed\..*The database is busy\.$/);

    expect(deckMoveCard).not.toHaveBeenCalled();
    expect(deckCategoryCreate).not.toHaveBeenCalled();
  });

  /** With nothing tagged — the default here, and the shape of a database that has never
   *  ingested the taxonomy — the type line is the whole of the answer, exactly as it was
   *  before the tags existed. */
  it("files the loose pile into type piles, creating the ones the deck has not got", async () => {
    deckCategoryCreate
      .mockResolvedValueOnce(category({ id: 40, name: "Creature" }))
      .mockResolvedValueOnce(category({ id: 41, name: "Land" }));
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });
    await waitFor(() => expect(result.current.categories).toHaveLength(3));

    const moved = await result.current.autoCategorise.mutateAsync([CREATURE, LAND]);

    expect(moved).toBe(2);
    expect(deckCategoryCreate).toHaveBeenCalledWith(4, "Creature");
    expect(deckCategoryCreate).toHaveBeenCalledWith(4, "Land");
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p1", MAIN.id, 40, null, "live", null);
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p2", MAIN.id, 41, null, "live", null);
  });

  /** A pile the deck already has is used, not made again — `deck_category_create` refuses a
   *  duplicate name, so a press that created blindly would be refused rather than tidy. */
  it("reuses a pile the deck already has by that name", async () => {
    deckCategoryList.mockResolvedValue([MAIN, category({ id: 7, name: "Creature" })]);
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });
    await waitFor(() => expect(result.current.categories).toHaveLength(2));

    await result.current.autoCategorise.mutateAsync([CREATURE]);

    expect(deckCategoryCreate).not.toHaveBeenCalled();
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p1", MAIN.id, 7, null, "live", null);
  });

  /**
   * **A column the reader made is theirs.** This is the difference between the feature and the
   * version that sounds the same: re-filing every `main` card would silently undo a hand-built
   * "Removal" column the first time it is pressed.
   */
  it("leaves a card in a pile the reader named alone", async () => {
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });
    await waitFor(() => expect(result.current.categories).toHaveLength(3));

    const moved = await result.current.autoCategorise.mutateAsync([
      card({
        cardId: "p3",
        typeLine: "Instant",
        categoryId: REMOVAL.id,
        categoryName: REMOVAL.name,
      }),
    ]);

    expect(moved).toBe(0);
    expect(deckMoveCard).not.toHaveBeenCalled();
  });

  /**
   * **A zone is not a pile, and the tags made that worth its own test.**
   *
   * Only `main` rows are candidates, which is why a commander has always been safe here — but a
   * commander is a Legendary Creature and Legendary Creatures are tagged like every other card,
   * so under the functional rule the card this deck is *named after* is exactly the sort of row
   * a loosened filter would move into "Ramp". Two fences hold it (the kind, and the pile's name
   * not being a loose one) and this pins the outcome rather than which of them did the work.
   */
  it("never moves a card out of the command zone", async () => {
    oracleTagsForPrintings.mockResolvedValue([{ cardId: "p8", slugs: ["ramp", "card-advantage"] }]);
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });
    await waitFor(() => expect(result.current.categories).toHaveLength(3));

    const moved = await result.current.autoCategorise.mutateAsync([
      card({
        cardId: "p8",
        name: "Kenrith, the Returned King",
        typeLine: "Legendary Creature — Human Noble",
        categoryId: 20,
        categoryName: "Commander",
        categoryKind: "commander",
      }),
    ]);

    expect(moved).toBe(0);
    expect(deckMoveCard).not.toHaveBeenCalled();
    expect(deckCategoryCreate).not.toHaveBeenCalled();
  });

  /**
   * A switched-off pile counts toward nothing, so moving a card out of one into an active type
   * pile would make it count toward size, copies and legality again — a rules change nobody
   * pressed, under a button labelled "tidy".
   */
  it("leaves a switched-off pile alone even when it is a loose one", async () => {
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });
    await waitFor(() => expect(result.current.categories).toHaveLength(3));

    const moved = await result.current.autoCategorise.mutateAsync([
      card({ ...CREATURE, categoryActive: false }),
    ]);

    expect(moved).toBe(0);
    expect(deckMoveCard).not.toHaveBeenCalled();
  });

  /**
   * **The mirror image of the guard above, and the one reachable by accident.**
   *
   * A reader may own a category called "Creature" and have switched it off. Filing a card there
   * would take it *out* of the deck — no size, no copy limit, no legality check, no claim —
   * with nothing on screen saying so. Nor may the pile be created over: the name is taken, so
   * `deck_category_create` would refuse it and the whole press would fail.
   *
   * So the card stays where it is, and switching the pile back on and pressing again files it.
   */
  it("will not file a card into a pile the reader switched off, or create over its name", async () => {
    deckCategoryList.mockResolvedValue([
      MAIN,
      category({ id: 7, name: "Creature", isActive: false }),
    ]);
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });
    await waitFor(() => expect(result.current.categories).toHaveLength(2));

    const moved = await result.current.autoCategorise.mutateAsync([CREATURE]);

    expect(moved).toBe(0);
    expect(deckMoveCard).not.toHaveBeenCalled();
    // And it did not try to make a second "Creature" either — the name is taken by the pile
    // that is switched off, so a create would be refused and take the whole press with it.
    expect(deckCategoryCreate).not.toHaveBeenCalled();
  });

  /** The same deck once the pile is switched back on: the card files, into the pile that was
   *  already there rather than into a new one. */
  it("files into that pile once it is switched back on", async () => {
    deckCategoryList.mockResolvedValue([MAIN, category({ id: 7, name: "Creature" })]);
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });
    await waitFor(() => expect(result.current.categories).toHaveLength(2));

    const moved = await result.current.autoCategorise.mutateAsync([CREATURE]);

    expect(moved).toBe(1);
    expect(deckCategoryCreate).not.toHaveBeenCalled();
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p1", MAIN.id, 7, null, "live", null);
  });

  /** `autoCategoryFor` answers "Uncategorized" for an orphan or a layout it has no word for.
   *  Moving those from one loose pile into another is churn dressed as work. */
  it("leaves a card the rule cannot place where it is", async () => {
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });
    await waitFor(() => expect(result.current.categories).toHaveLength(3));

    const moved = await result.current.autoCategorise.mutateAsync([
      card({ cardId: "p4", typeLine: null }),
    ]);

    expect(moved).toBe(0);
    expect(deckMoveCard).not.toHaveBeenCalled();
  });

  /**
   * **Idempotent by construction**, which is what makes a non-atomic multi-write press safe to
   * repeat after one fails half way: a card that landed in "Creature" is no longer in a loose
   * pile, so the second pass does not see it at all.
   */
  it("moves nothing on a second press", async () => {
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });
    await waitFor(() => expect(result.current.categories).toHaveLength(3));

    const moved = await result.current.autoCategorise.mutateAsync([
      card({ ...CREATURE, categoryId: 40, categoryName: "Creature" }),
    ]);

    expect(moved).toBe(0);
    expect(deckMoveCard).not.toHaveBeenCalled();
  });

  /** The other list's rows are not this press's business — the mutation is scoped to the
   *  variant the hook was opened on, so a caller handing it both lists moves only one. */
  it("ignores rows from the other variant", async () => {
    const { result } = renderHook(() => useDeckMeta(4, "live"), { wrapper });
    await waitFor(() => expect(result.current.categories).toHaveLength(3));

    const moved = await result.current.autoCategorise.mutateAsync([
      card({ ...CREATURE, variant: "theory" }),
    ]);

    expect(moved).toBe(0);
    expect(deckMoveCard).not.toHaveBeenCalled();
  });

  /**
   * It reads the deck's **current** categories rather than this hook's cached list.
   *
   * A panel one write stale would otherwise try to create a category that already exists and be
   * refused by name — turning a tidy into an error for a reason the reader cannot see.
   */
  it("reads the categories fresh before deciding what to create", async () => {
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });
    await waitFor(() => expect(result.current.categories).toHaveLength(3));
    // Another surface made the pile since this panel last read.
    deckCategoryList.mockResolvedValue([MAIN, category({ id: 7, name: "Creature" })]);

    await result.current.autoCategorise.mutateAsync([CREATURE]);

    expect(deckCategoryCreate).not.toHaveBeenCalled();
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p1", MAIN.id, 7, null, "live", null);
  });
});
