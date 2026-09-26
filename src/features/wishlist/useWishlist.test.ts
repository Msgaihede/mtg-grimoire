import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { ShelfCount, WishlistFolder, WishlistQuery, WishRow } from "@/lib/ipc";

const wishlistList = vi.hoisted(() => vi.fn());
/** `useMarketplace()` reads this too. An unmocked command is a rejected query that silently
 *  resolves to the default, so it is answered explicitly — `WishlistPage.test.tsx`'s reason. */
const getMarketplace = vi.hoisted(() => vi.fn());
// The three reads the shelves are built from and counted by, and the fold write — every one a
// real `invoke`, so an unmocked member is a `TypeError` rather than a rejected query.
const wishlistFolderList = vi.hoisted(() => vi.fn());
const wishlistShelfCounts = vi.hoisted(() => vi.fn());
const shelfFolds = vi.hoisted(() => vi.fn());
const setShelfFolds = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    wishlistList,
    getMarketplace,
    wishlistFolderList,
    wishlistShelfCounts,
    shelfFolds,
    setShelfFolds,
  },
}));

import { activeFilterCount, useWishlist, type WishlistFilterState } from "./useWishlist";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

const lastQuery = () =>
  wishlistList.mock.calls[wishlistList.mock.calls.length - 1][0] as WishlistQuery;
const lastCount = () =>
  wishlistShelfCounts.mock.calls[wishlistShelfCounts.mock.calls.length - 1][0] as WishlistQuery;

/** `Ordered` holds `Backordered`; `Someday` is a sibling; the deck's managed folder is shut by
 *  default (spec §3.4) — the four shapes the shelf list has to order. */
const ORDERED: WishlistFolder = {
  id: 1,
  parentId: null,
  name: "Ordered",
  sortOrder: 0,
  managedDeckId: null,
};
const BACKORDERED: WishlistFolder = {
  id: 2,
  parentId: 1,
  name: "Backordered",
  sortOrder: 0,
  managedDeckId: null,
};
const SOMEDAY: WishlistFolder = {
  id: 3,
  parentId: null,
  name: "Someday",
  sortOrder: 1,
  managedDeckId: null,
};
const MANAGED: WishlistFolder = {
  id: 9,
  parentId: null,
  name: "Rhystic Testbed",
  sortOrder: 2,
  managedDeckId: 4,
};

beforeEach(() => {
  wishlistList.mockReset().mockResolvedValue({ items: [], total: 0 });
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  wishlistFolderList.mockReset().mockResolvedValue([ORDERED, BACKORDERED, SOMEDAY, MANAGED]);
  wishlistShelfCounts.mockReset().mockResolvedValue([]);
  shelfFolds.mockReset().mockResolvedValue({ collection: {}, wishlist: {} });
  setShelfFolds.mockReset().mockResolvedValue(undefined);
});

/**
 * `folderId` is navigation, not a filter — `useWishlist.ts`'s doc comments say why. This is the
 * test that holds the boundary: `WishlistFilterState` never grew a field for it, so this checks the
 * *hook's* `activeCount` rather than `activeFilterCount` itself.
 */
describe("folderId is not a filter", () => {
  it("does not count opening a folder", () => {
    const { result } = renderHook(() => useWishlist(), { wrapper });
    act(() => result.current.openFolder(3));
    expect(result.current.activeCount).toBe(0);
  });

  it("still counts only the real filters once a folder is open", () => {
    const { result } = renderHook(() => useWishlist(), { wrapper });
    act(() => result.current.setText("bolt"));
    act(() => result.current.openFolder(3));
    expect(result.current.activeCount).toBe(1);
  });

  /** `resetAll` is a list of `set*` calls over this hook's own state, and where the reader is
   *  standing is not one of them — nor is any fold, which lives behind `useShelfFolds`. */
  it("resetAll clears every filter and leaves folderId standing", () => {
    const { result } = renderHook(() => useWishlist(), { wrapper });
    act(() => {
      result.current.setText("bolt");
      result.current.toggleNeedsReview();
      result.current.toggleRarity("rare");
      result.current.openFolder(3);
    });
    expect(result.current.activeCount).toBe(3);

    act(() => result.current.resetAll());

    expect(result.current.activeCount).toBe(0);
    expect(result.current.text).toBe("");
    expect(result.current.needsReview).toBeUndefined();
    expect(result.current.rarities).toEqual([]);
    expect(result.current.folderId).toBe(3);
  });
});

describe("the shelves it asks for", () => {
  /** A read before the folder list is a read for Not sorted alone, then a second one for the
   *  wall — a flash of the wrong page and a round trip thrown away. */
  it("waits for the folder list, so the first read already names every shelf", async () => {
    let answer!: (folders: WishlistFolder[]) => void;
    wishlistFolderList.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    renderHook(() => useWishlist(), { wrapper });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(wishlistList).not.toHaveBeenCalled();
    expect(wishlistShelfCounts).not.toHaveBeenCalled();

    answer([ORDERED, BACKORDERED, SOMEDAY, MANAGED]);
    await waitFor(() => expect(wishlistList).toHaveBeenCalledTimes(1));
    expect(lastQuery().shelves).toEqual([0, 1, 2, 3]);
  });

  /** Not sorted first, the reader's folders depth first, and the deck's list — shut by default —
   *  not at all. And none of the two fields the drill-down used to send. */
  it("sends the open shelves in tree order at the root, and never a folderId or a flatten flag", async () => {
    renderHook(() => useWishlist(), { wrapper });
    await waitFor(() => expect(wishlistList).toHaveBeenCalled());

    expect(lastQuery().shelves).toEqual([0, 1, 2, 3]);
    expect(lastQuery()).not.toHaveProperty("folderId");
    expect(lastQuery()).not.toHaveProperty("flatten");
  });

  /** Spec §4.2: the counts cover every shelf at and below the level, shut ones too — that is what
   *  lets the header count a collapsed folder's wishes and a heading place its slots unfetched. */
  it("counts every shelf at and below the level, the shut ones included, over the same scope", async () => {
    renderHook(() => useWishlist(), { wrapper });
    await waitFor(() => expect(wishlistShelfCounts).toHaveBeenCalled());

    expect(lastCount().shelves).toEqual([0, 1, 2, 3, 9]);
    expect(lastCount().marketplace).toBe("tcgplayer");
  });

  it("asks for the opened folder's own shelf first, then the folders under it", async () => {
    const { result } = renderHook(() => useWishlist(), { wrapper });
    await waitFor(() => expect(wishlistList).toHaveBeenCalled());

    act(() => result.current.openFolder(1));

    // Asked at once; drawn once the level has answered (see "walking to a level").
    expect(result.current.requestedFolderId).toBe(1);
    await waitFor(() => expect(lastQuery().shelves).toEqual([1, 2]));
    await waitFor(() => expect(result.current.folderId).toBe(1));

    act(() => result.current.openFolder(null));
    await waitFor(() => expect(lastQuery().shelves).toEqual([0, 1, 2, 3]));
  });

  /** Review Focus 3: a shut parent takes its whole subtree off the read — and nothing off the
   *  count, which is what the header and the shut heading's figures are drawn from. */
  it("drops a shut folder's whole subtree from the read, and still counts it", async () => {
    shelfFolds.mockResolvedValue({ collection: {}, wishlist: { "1": true } });
    renderHook(() => useWishlist(), { wrapper });

    await waitFor(() => expect(lastQuery().shelves).toEqual([0, 3]));
    expect(lastCount().shelves).toEqual([0, 1, 2, 3, 9]);
  });

  /** Review Focus 4 at the wire: while the box has text, collapse is suspended — the managed
   *  folder included — and emptying the box puts every stored fold back without a write. */
  it("suspends collapse while the box has text, and puts it back when the box empties", async () => {
    shelfFolds.mockResolvedValue({ collection: {}, wishlist: { "1": true } });
    const { result } = renderHook(() => useWishlist(), { wrapper });
    await waitFor(() => expect(lastQuery().shelves).toEqual([0, 3]));

    act(() => result.current.setText("remora"));
    await waitFor(() => expect(lastQuery().shelves).toEqual([0, 1, 2, 3, 9]));
    expect(result.current.filtering).toBe(true);

    act(() => result.current.setText(""));
    await waitFor(() => expect(lastQuery().shelves).toEqual([0, 3]));
    expect(result.current.filtering).toBe(false);
    expect(setShelfFolds).not.toHaveBeenCalled();
  });

  it("is filtering for a chip as well as for text", async () => {
    const { result } = renderHook(() => useWishlist(), { wrapper });
    act(() => result.current.toggleRarity("rare"));
    await waitFor(() => expect(result.current.filtering).toBe(true));
  });
});

/**
 * **Walking to a level the cache does not hold** (live pass §14). Both reads keep the previous
 * key's answer as a placeholder, so drawn as it arrived the wall was the new level's shelves over the
 * old level's rows and figures for 36–106 ms, then the level's own wishes popped in. The rule — the
 * collection's too — is that the page keeps drawing the level being left **whole** until the new
 * level's list and counts have both answered, then switches in one render.
 */
describe("walking to a level", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }
  const LOOSE = { id: 11, folderId: null, name: "Lightning Bolt" } as WishRow;
  const IN_ORDERED = { id: 12, folderId: 1, name: "Rhystic Study" } as WishRow;
  const ROOT_COUNTS: ShelfCount[] = [
    { folderId: 0, tiles: 1, copies: 1, value: 2, unpriced: 0, peek: [] },
  ];
  const ORDERED_COUNTS: ShelfCount[] = [
    { folderId: 1, tiles: 1, copies: 1, value: 30, unpriced: 0, peek: [] },
  ];
  /** Ordered's level asks for `[1, 2]`; the root's starts with Not sorted's `0`. */
  const atOrdered = (q: WishlistQuery) => q.shelves?.[0] === ORDERED.id;

  it("draws the level being left, whole, until the new level's list and counts have both answered", async () => {
    const list = deferred<{ items: WishRow[]; total: number }>();
    const counted = deferred<ShelfCount[]>();
    wishlistList.mockImplementation(async (q: WishlistQuery) =>
      atOrdered(q) ? list.promise : { items: [LOOSE], total: 1 },
    );
    wishlistShelfCounts.mockImplementation(async (q: WishlistQuery) =>
      atOrdered(q) ? counted.promise : ROOT_COUNTS,
    );
    const { result } = renderHook(() => useWishlist(), { wrapper });
    await waitFor(() => expect(result.current.rows).toEqual([LOOSE]));
    const rootIdentity = result.current.queryKeyString;

    act(() => result.current.openFolder(ORDERED.id));

    // Asked at once — the reads go out for Ordered — and drawn not at all yet.
    expect(result.current.requestedFolderId).toBe(ORDERED.id);
    await waitFor(() => expect(lastQuery().shelves).toEqual([1, 2]));
    const drawsTheRoot = () => {
      expect(result.current.levelHeld).toBe(true);
      expect(result.current.folderId).toBeNull();
      expect(result.current.shelves.map((s) => s.id)).toContain(0);
      expect(result.current.rows).toEqual([LOOSE]);
      expect(result.current.counts).toEqual(ROOT_COUNTS);
      expect(result.current.queryKeyString).toBe(rootIdentity);
    };
    drawsTheRoot();

    // The counts land first: still the root, figures and wall — never Ordered's figures over the
    // root's wall.
    await act(async () => counted.resolve(ORDERED_COUNTS));
    drawsTheRoot();

    // Then the list: the whole page switches, in one render.
    await act(async () => list.resolve({ items: [IN_ORDERED], total: 1 }));
    await waitFor(() => expect(result.current.folderId).toBe(ORDERED.id));
    expect(result.current.levelHeld).toBe(false);
    expect(result.current.rows).toEqual([IN_ORDERED]);
    expect(result.current.counts).toEqual(ORDERED_COUNTS);
    expect(result.current.shelves.map((s) => s.id)).not.toContain(0);
    expect(result.current.queryKeyString).not.toBe(rootIdentity);
  });

  /**
   * **The held frame is drawn whole from the frame** (review Minors 2 and 3). A filter typed or a
   * shelf folded while the level being left is still drawn is a question about the *next* wall: the
   * held one keeps the filtering and the folds its rows were fetched under (a shut `Someday` stays
   * shut, where the current filter would suspend collapse and the current fold would open it), its
   * scroll identity (so the keystroke does not jump the held wall to the top), and its sweep scope —
   * an Export or an Optimise pressed during the hold covers the wall on screen, not the level still
   * arriving.
   */
  it("draws the held level from its own frame — filtering, folds, scroll identity and sweep scope", async () => {
    shelfFolds.mockResolvedValue({ collection: {}, wishlist: { [String(SOMEDAY.id)]: true } });
    const list = deferred<{ items: WishRow[]; total: number }>();
    wishlistList.mockImplementation(async (q: WishlistQuery) =>
      atOrdered(q) ? list.promise : { items: [LOOSE], total: 1 },
    );
    wishlistShelfCounts.mockImplementation(async (q: WishlistQuery) =>
      atOrdered(q) ? ORDERED_COUNTS : ROOT_COUNTS,
    );
    const { result } = renderHook(() => useWishlist(), { wrapper });
    await waitFor(() => expect(result.current.rows).toEqual([LOOSE]));
    const rootIdentity = result.current.queryKeyString;
    const rootFilters = result.current.filters;
    const someday = () => result.current.shelves.find((s) => s.id === SOMEDAY.id);
    expect(someday()?.collapsed).toBe(true);

    act(() => result.current.openFolder(ORDERED.id));
    await waitFor(() => expect(lastQuery().shelves).toEqual([1, 2]));
    // During the hold: Someday's fold put back to its default (open), and a chip pressed.
    act(() => result.current.setFold(SOMEDAY.id, null));
    act(() => result.current.toggleRarity("rare"));
    await waitFor(() => expect(lastQuery().rarities).toEqual(["rare"]));

    expect(result.current.levelHeld).toBe(true);
    expect(result.current.folderId).toBeNull();
    expect(result.current.filtering).toBe(false);
    expect(result.current.folds).toEqual({ [String(SOMEDAY.id)]: true });
    expect(someday()?.collapsed).toBe(true);
    expect(result.current.queryKeyString).toBe(rootIdentity);
    expect(result.current.filters).toEqual(rootFilters);
    expect(result.current.filters.rarities).toBeUndefined();

    // And once the level answers, all of it is the level asked for, under the filter now on.
    await act(async () => list.resolve({ items: [IN_ORDERED], total: 1 }));
    await waitFor(() => expect(result.current.levelHeld).toBe(false));
    expect(result.current.filtering).toBe(true);
    expect(result.current.filters.rarities).toEqual(["rare"]);
    expect(result.current.queryKeyString).not.toBe(rootIdentity);
  });

  /** The half the live pass measured as right, kept: a level already in the cache answers in the
   *  render that asks for it, so there is nothing to hold. */
  it("switches to a level the cache holds in the render that asks for it", async () => {
    wishlistList.mockImplementation(async (q: WishlistQuery) =>
      atOrdered(q) ? { items: [IN_ORDERED], total: 1 } : { items: [LOOSE], total: 1 },
    );
    wishlistShelfCounts.mockImplementation(async (q: WishlistQuery) =>
      atOrdered(q) ? ORDERED_COUNTS : ROOT_COUNTS,
    );
    const { result } = renderHook(() => useWishlist(), { wrapper });
    await waitFor(() => expect(result.current.rows).toEqual([LOOSE]));
    act(() => result.current.openFolder(ORDERED.id));
    await waitFor(() => expect(result.current.rows).toEqual([IN_ORDERED]));

    act(() => result.current.openFolder(null));

    expect(result.current.levelHeld).toBe(false);
    expect(result.current.folderId).toBeNull();
    expect(result.current.rows).toEqual([LOOSE]);
    expect(result.current.counts).toEqual(ROOT_COUNTS);
  });

  /** A refused level is switched to, so its failure is said where the reader asked to go — held,
   *  the old level would stand for ever over an error nobody could place. */
  it("switches to a level whose read was refused rather than holding the old one", async () => {
    wishlistList.mockImplementation(async (q: WishlistQuery) => {
      if (atOrdered(q)) throw new Error("refused");
      return { items: [LOOSE], total: 1 };
    });
    const { result } = renderHook(() => useWishlist(), { wrapper });
    await waitFor(() => expect(result.current.rows).toEqual([LOOSE]));

    act(() => result.current.openFolder(ORDERED.id));

    await waitFor(() => expect(result.current.query.isError).toBe(true));
    await waitFor(() => expect(result.current.folderId).toBe(ORDERED.id));
    expect(result.current.levelHeld).toBe(false);
    expect(result.current.rows).toEqual([]);
  });
});

/**
 * `queryKeyString` is the scroll reset's whole mechanism, so it is the list's *identity* — the
 * level, the filters, the sort — and deliberately not the shelves it fetched: folding a shelf
 * changes what is asked for without making it a different list, and a wall that jumped to the top
 * on every chevron press would be a wall nobody could fold anything in.
 */
describe("listKey", () => {
  it("keys the list's identity on the level, so two folders never share a scroll position", async () => {
    const { result } = renderHook(() => useWishlist(), { wrapper });
    const root = result.current.queryKeyString;

    act(() => result.current.openFolder(3));
    const three = result.current.queryKeyString;
    expect(three).not.toBe(root);

    act(() => result.current.openFolder(5));
    expect(result.current.queryKeyString).not.toBe(three);

    act(() => result.current.openFolder(null));
    expect(result.current.queryKeyString).toBe(root);
  });

  it("keeps the list's identity when a shelf folds", async () => {
    const { result } = renderHook(() => useWishlist(), { wrapper });
    await waitFor(() => expect(lastQuery().shelves).toEqual([0, 1, 2, 3]));
    const before = result.current.queryKeyString;

    act(() => result.current.setFold(1, true));

    await waitFor(() => expect(lastQuery().shelves).toEqual([0, 3]));
    expect(result.current.queryKeyString).toBe(before);
    expect(setShelfFolds).toHaveBeenCalledWith("wishlist", { "1": true });
  });
});

// `activeFilterCount` still takes neither `folderId` nor `flatten` — they are navigation rather
// than filters, which is the point above and is what survived the row growing. This is the one
// direct check on the exported function, since nothing else in the tree calls it.
const NONE = {
  text: "",
  format: "",
  colors: [],
  sets: [],
  manaValues: [],
  manaX: false,
  rarities: [],
  types: [],
  needsReview: undefined,
} satisfies WishlistFilterState;

describe("activeFilterCount", () => {
  it("is zero when nothing is filtered", () => {
    expect(activeFilterCount(NONE)).toBe(0);
  });

  /** Kinds, not values — the badge tells the reader how much is about to change, and "two
   *  rarities" is one thing that is on. */
  it("counts each kind of filter once", () => {
    expect(activeFilterCount({ ...NONE, text: "bolt" })).toBe(1);
    expect(activeFilterCount({ ...NONE, format: "modern" })).toBe(1);
    expect(activeFilterCount({ ...NONE, colors: ["R", "U"] })).toBe(1);
    expect(activeFilterCount({ ...NONE, sets: ["lea"] })).toBe(1);
    expect(activeFilterCount({ ...NONE, rarities: ["rare", "mythic"] })).toBe(1);
    // `false` — "everything the sync did not touch" — is a filter too. Compared against
    // `undefined`, never tested for truthiness.
    expect(activeFilterCount({ ...NONE, needsReview: false })).toBe(1);
  });

  /** Whitespace is not a search. */
  it("ignores a blank search box", () => {
    expect(activeFilterCount({ ...NONE, text: "   " })).toBe(0);
  });

  /** X is the last chip of the mana-value group and is OR'd with the numerals, so it is that same
   *  kind — but an X-only filter still has to be seen, or Reset all would hide over a list that
   *  is filtered. */
  it("counts the X chip with the mana values it sits among", () => {
    expect(activeFilterCount({ ...NONE, manaX: true })).toBe(1);
    expect(activeFilterCount({ ...NONE, manaValues: [1], manaX: true })).toBe(1);
  });

  /** Eight — three until the three card views started drawing one `FilterBar`, eight until
   *  `fulfilled` went with the rest of this list's comparisons against the collection, seven
   *  after it, and eight again since the type chips. Reset all has to reach every one of them,
   *  so the count has to see every one of them.
   *
   *  **`colorsStrict` is deliberately not a ninth**, here or in `activeFilterCount` itself: it
   *  modifies the colour filter rather than being one, so a badge that moved when it was pressed
   *  would be counting a narrowing that had not happened. */
  it("sees all eight kinds the wishlist offers", () => {
    expect(
      activeFilterCount({
        text: "bolt",
        format: "modern",
        colors: ["R"],
        sets: ["lea"],
        manaValues: [1],
        manaX: true,
        rarities: ["rare"],
        types: ["Creature"],
        needsReview: true,
      }),
    ).toBe(8);
  });
});
