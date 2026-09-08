/**
 * The cross-reference — the whole reason a Grimoire reader opens somebody else's binder in the
 * app rather than in a browser.
 *
 * Two reads over the reader's own lists, folded into two maps and never materialised as rows.
 * Both are paged, and the paging is what these tests are mostly about: a sweep that believed the
 * first page would answer *you own 0* for every card past row 500, which is a wrong figure
 * rather than a missing one and reads exactly like a correct answer.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const collectionList = vi.hoisted(() => vi.fn());
const wishlistList = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { collectionList, wishlistList },
}));

import type { CollectionRow, WishRow } from "@/lib/ipc";
import type { ShareCard } from "@/lib/shareSnapshot";
import { crossReference, INDEX_PAGE, useOwnedIndex, wishGrainKey } from "./useOwnedIndex";

const owned = (cardId: string, quantity: number): CollectionRow =>
  ({ cardId, quantity }) as unknown as CollectionRow;

const wished = (cardId: string | null, name: string, quantity: number): WishRow =>
  ({ cardId, name, quantity }) as unknown as WishRow;

const shared = (id: string, n: string): ShareCard => ({
  id,
  n,
  s: "tsp",
  cn: "157",
  f: "nonfoil",
  q: 1,
  fo: null,
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** One page and then nothing — the shape both commands answer for a short list. */
const onePage = <T,>(items: T[]) => ({ items, total: items.length });

beforeEach(() => {
  vi.clearAllMocks();
  collectionList.mockResolvedValue(onePage([]));
  wishlistList.mockResolvedValue(onePage([]));
});

describe("the reader's own copies, indexed", () => {
  it("counts every copy of one printing, however many rows it is spread over", async () => {
    // Two rows of one printing — a foil and a nonfoil, or two conditions — which is the ordinary
    // shape of `collection_entries` and the reason this is a sum rather than a lookup.
    collectionList.mockResolvedValue(onePage([owned("bolt", 2), owned("bolt", 1), owned("sol", 4)]));
    const { result } = renderHook(() => useOwnedIndex(true), { wrapper });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(crossReference(shared("bolt", "Lightning Bolt"), result.current.index).own).toBe(3);
    expect(crossReference(shared("sol", "Sol Ring"), result.current.index).own).toBe(4);
    expect(crossReference(shared("tundra", "Tundra"), result.current.index).own).toBe(0);
  });

  /**
   * A wish carrying no printing is *any* printing of that card, so it has to reach every row of
   * the binder that names it — and a wishlist is mostly these. Keyed on the lowercased name,
   * which is what makes a share's `Lightning Bolt` meet a wish typed as `lightning bolt`.
   */
  it("counts a printing-less wish against every printing of that card", async () => {
    wishlistList.mockResolvedValue(
      onePage([wished(null, "lightning bolt", 3), wished("sol-2", "Sol Ring", 1)]),
    );
    const { result } = renderHook(() => useOwnedIndex(true), { wrapper });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(crossReference(shared("bolt-a", "Lightning Bolt"), result.current.index).want).toBe(3);
    expect(crossReference(shared("bolt-b", "Lightning Bolt"), result.current.index).want).toBe(3);
    // The pinned wish reaches its own printing and no other.
    expect(crossReference(shared("sol-2", "Sol Ring"), result.current.index).want).toBe(1);
    expect(crossReference(shared("sol-9", "Sol Ring"), result.current.index).want).toBe(0);
  });

  /** Both reads page, and the stop is a short page rather than the total a write can move. */
  it("sweeps past the first page of each list", async () => {
    const page = Array.from({ length: INDEX_PAGE }, (_, i) => owned(`c${i}`, 1));
    collectionList
      .mockResolvedValueOnce({ items: page, total: INDEX_PAGE + 1 })
      .mockResolvedValueOnce(onePage([owned("last", 7)]));
    const { result } = renderHook(() => useOwnedIndex(true), { wrapper });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(collectionList).toHaveBeenCalledTimes(2);
    expect(collectionList.mock.calls[1][0]).toMatchObject({ limit: INDEX_PAGE, offset: INDEX_PAGE });
    expect(crossReference(shared("last", "Black Lotus"), result.current.index).own).toBe(7);
  });

  /** Nothing is read until a snapshot is on screen: the sweep is the reader's whole collection. */
  it("reads nothing at all until it is asked to", async () => {
    const { result } = renderHook(() => useOwnedIndex(false), { wrapper });

    await waitFor(() => expect(result.current.ready).toBe(false));
    expect(collectionList).not.toHaveBeenCalled();
    expect(wishlistList).not.toHaveBeenCalled();
    // And a card asked about before the sweep answers zero rather than throwing, so the wall can
    // draw itself while the figures are still arriving.
    expect(crossReference(shared("bolt", "Lightning Bolt"), result.current.index)).toEqual({
      own: 0,
      want: 0,
    });
  });

  /**
   * The index has to keep its identity across renders that changed nothing.
   *
   * `SharedPage`'s `shown` filters and sorts the whole binder and lists `index` in its deps, so a
   * fresh object literal per render makes that memo miss every time — the one thing it exists to
   * stop, at the one size this feature is written for. Identity is the only observable: a
   * `toEqual` here would pass over a new object with the same contents, which *is* the defect.
   */
  it("keeps one identity for the index across renders that changed nothing", async () => {
    collectionList.mockResolvedValue(onePage([owned("bolt", 2)]));
    const { result, rerender } = renderHook(() => useOwnedIndex(true), { wrapper });

    await waitFor(() => expect(result.current.ready).toBe(true));
    const settled = result.current.index;
    rerender();
    expect(result.current.index).toBe(settled);

    // And before the sweep lands, which is the longer half of the window: `EMPTY_INDEX` is a
    // module constant precisely so the loading state is one identity too.
    const pending = renderHook(() => useOwnedIndex(false), { wrapper });
    const empty = pending.result.current.index;
    pending.rerender();
    expect(pending.result.current.index).toBe(empty);
  });

  /**
   * A refused read is not an empty collection, and the difference is a figure the reader would
   * otherwise act on: *you own 0* beside a card they own four of is what sends somebody to a
   * trade with the wrong list.
   */
  it("says the figures are unavailable rather than reporting zeroes", async () => {
    collectionList.mockRejectedValue("the database is locked");
    const { result } = renderHook(() => useOwnedIndex(true), { wrapper });

    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.ready).toBe(false);
  });
});

/**
 * The third map — the one that answers *will another add fold, or make a second line*.
 *
 * ⚠️ **`wanted` cannot answer it and neither can `wantedByName`.** `wishlist_add` folds on four
 * terms (oracle id, printing, preferred finish, folder), and the two maps above deliberately sum
 * across every folder and every finish because the question a tile asks is *do I want this card*.
 * A surface that promised "adding raises what you already want" off `wanted` would be wrong in
 * both directions, and this is the map that lets it be right.
 */
describe("the wishlist at its own grain", () => {
  const line = (
    over: Partial<Pick<WishRow, "cardId" | "preferredFinish" | "folderId" | "quantity" | "name">>,
  ): WishRow =>
    ({
      cardId: "bolt",
      name: "Lightning Bolt",
      preferredFinish: null,
      folderId: null,
      quantity: 1,
      ...over,
    }) as unknown as WishRow;

  it("keeps two folders and two finishes of one printing apart", async () => {
    wishlistList.mockResolvedValue(
      onePage([
        line({ quantity: 2 }),
        // The same printing, filed in a folder — a different row, and a card-level count that
        // said "7 wanted" would be right about the card and wrong about every one of the folds.
        line({ folderId: 7, quantity: 1 }),
        // The same printing again, in a finish. A wish for the foil is not filled by the
        // nonfoil, so this is a third row.
        line({ preferredFinish: "foil", quantity: 4 }),
      ]),
    );
    const { result } = renderHook(() => useOwnedIndex(true), { wrapper });

    await waitFor(() => expect(result.current.ready).toBe(true));
    const { wanted, wishes } = result.current.index;

    // The card-level map still sums the lot, which is what a tile draws.
    expect(wanted.get("bolt")).toBe(7);
    // …and the grain map keeps the three rows apart, each at its own quantity.
    expect(wishes.get(wishGrainKey("bolt", null, null))).toBe(2);
    expect(wishes.get(wishGrainKey("bolt", null, 7))).toBe(1);
    expect(wishes.get(wishGrainKey("bolt", "foil", null))).toBe(4);
    // A grain nothing is filed at answers nothing rather than zero, which is what lets a caller
    // treat *absent* and *none* as one thing.
    expect(wishes.get(wishGrainKey("bolt", "etched", null))).toBeUndefined();
  });

  /**
   * **A printing-less wish is in `wantedByName` and in nothing else**, and that is the third
   * divergence rather than an omission: its grain's `card_id` term is `''`, so no pinned wish —
   * which is the only kind this app's want list writes — can ever fold onto it.
   */
  it("leaves an any-printing wish out of the grain map entirely", async () => {
    wishlistList.mockResolvedValue(onePage([line({ cardId: null, quantity: 3 })]));
    const { result } = renderHook(() => useOwnedIndex(true), { wrapper });

    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.index.wantedByName.get("lightning bolt")).toBe(3);
    expect(result.current.index.wishes.size).toBe(0);
  });
});
