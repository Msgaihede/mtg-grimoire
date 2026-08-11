import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { DeckCard, DeckCategory, DeckTag, DeckVariant } from "@/lib/ipc";

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
const deckTagSuggestions = vi.hoisted(() => vi.fn());
const deckMoveCard = vi.hoisted(() => vi.fn());
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
    deckTagSuggestions,
    deckMoveCard,
  },
}));

import { useDeckMeta } from "./useDeckMeta";

function category(over: Partial<DeckCategory> & { id: number; name: string }): DeckCategory {
  return {
    deckId: 4,
    kind: "main",
    isActive: true,
    sortOrder: 0,
    cardCount: 0,
    totalPriceUsd: null,
    ...over,
  };
}

/** The pile the v8 migration files every legacy main-deck row into, and the one thing
 *  `autoCategorise` is allowed to empty. */
const MAIN = category({ id: 1, name: "Main deck", cardCount: 4 });
/** A column the reader made. Auto-categorise must never touch this one. */
const REMOVAL = category({ id: 2, name: "Removal", sortOrder: 1 });
const MAYBE = category({ id: 3, name: "Maybeboard", kind: "maybe", isActive: false, sortOrder: 2 });

const CUT: DeckTag = { id: 8, deckId: 4, name: "Cut candidate", color: "ember", cardCount: 1 };

/** A deck card in a named pile. Only the fields `autoCategorise` reads are interesting; the
 *  rest are filled so the fixture is a real {@link DeckCard} and not a cast. */
function card(over: Partial<DeckCard> & { cardId: string }): DeckCard {
  return {
    id: 1,
    categoryId: MAIN.id,
    categoryName: MAIN.name,
    categoryKind: "main",
    categoryActive: true,
    variant: "live",
    tagId: null,
    tagName: null,
    tagColor: null,
    quantity: 1,
    name: "A card",
    setCode: "lea",
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
    unitPriceUsd: null,
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
  deckTagSuggestions.mockReset().mockResolvedValue([{ name: "Cut candidate", color: "ember" }]);
  deckMoveCard.mockReset().mockResolvedValue(undefined);
});

describe("useDeckMeta", () => {
  /** The Decks view mounts with no deck open, and the only surface that wants any of this is a
   *  panel inside an editor — including the palette, which has no deck in its command but no
   *  reader either until a tag dialog is up. */
  it("asks for nothing until a deck is open", () => {
    renderHook(() => useDeckMeta(null), { wrapper });

    expect(deckCategoryList).not.toHaveBeenCalled();
    expect(deckTagList).not.toHaveBeenCalled();
    expect(deckTagSuggestions).not.toHaveBeenCalled();
  });

  it("reads the piles, the labels and the app-wide palette", async () => {
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });

    await waitFor(() => expect(result.current.categories).toEqual([MAIN, REMOVAL, MAYBE]));
    expect(deckCategoryList).toHaveBeenCalledWith(4, "live");
    expect(result.current.tags).toEqual([CUT]);
    expect(deckTagList).toHaveBeenCalledWith(4, "live");
    // Global: the palette a "New tag" dialog completes from is a property of the app's whole
    // history, not of the one deck the dialog happens to be open on.
    await waitFor(() =>
      expect(result.current.suggestions).toEqual([{ name: "Cut candidate", color: "ember" }]),
    );
    expect(deckTagSuggestions).toHaveBeenCalledWith();
  });

  /**
   * **The variant scopes the counts and nothing else**, and it is in the key so the two
   * answers are cached side by side rather than one replacing the other.
   *
   * Which categories a deck has, what they are called and what order they are in are facts
   * about the *deck*; only `cardCount` and `totalPriceUsd` are about one of its two lists. So a
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
    expect(deckCategoryList).toHaveBeenCalledWith(4, "theory");
    // Both answers are still there: flipping back is a cache hit, not a re-read.
    expect(client.getQueryData(["decks", "categories", 4, "live"])).toEqual([MAIN, REMOVAL, MAYBE]);
    expect(client.getQueryData(["decks", "categories", 4, "theory"])).toEqual(theory);
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
    expect(deckTagUpdate).toHaveBeenCalledWith(8, "Cut", "moss");

    await result.current.deleteTag.mutateAsync(8);
    expect(deckTagDelete).toHaveBeenCalledWith(8);
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
 * "Auto-categorise from card types" — the one rule in `autoCategory.ts`, pressed once.
 *
 * The rule itself is tested where it lives; what these pin is the **orchestration**, which is
 * where this feature can destroy a reader's work: which piles it is allowed to empty, which
 * cards it leaves alone, and that pressing it twice does not move anything twice.
 */
describe("useDeckMeta.autoCategorise", () => {
  const CREATURE = card({ cardId: "p1", name: "Grizzly Bears", typeLine: "Creature — Bear" });
  const LAND = card({ cardId: "p2", name: "Forest", typeLine: "Basic Land — Forest" });

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
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p1", MAIN.id, 40, "live");
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p2", MAIN.id, 41, "live");
  });

  /** A pile the deck already has is used, not made again — `deck_category_create` refuses a
   *  duplicate name, so a press that created blindly would be refused rather than tidy. */
  it("reuses a pile the deck already has by that name", async () => {
    deckCategoryList.mockResolvedValue([MAIN, category({ id: 7, name: "Creature" })]);
    const { result } = renderHook(() => useDeckMeta(4), { wrapper });
    await waitFor(() => expect(result.current.categories).toHaveLength(2));

    await result.current.autoCategorise.mutateAsync([CREATURE]);

    expect(deckCategoryCreate).not.toHaveBeenCalled();
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p1", MAIN.id, 7, "live");
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
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p1", MAIN.id, 7, "live");
  });

  /** `autoCategoryFor` answers "Uncategorised" for an orphan or a layout it has no word for.
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
    expect(deckMoveCard).toHaveBeenCalledWith(4, "p1", MAIN.id, 7, "live");
  });
});
