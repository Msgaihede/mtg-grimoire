import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const collectionClear = vi.hoisted(() => vi.fn());
const wishlistClear = vi.hoisted(() => vi.fn());
const decksClear = vi.hoisted(() => vi.fn());
const cacheClear = vi.hoisted(() => vi.fn());
const combosClear = vi.hoisted(() => vi.fn());
const combosRefresh = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { collectionClear, wishlistClear, decksClear, cacheClear, combosClear, combosRefresh },
}));

import { useDangerZone, useLocalCache } from "./useDataReset";
import { useNotifications } from "@/lib/notifications";

/** The toast the last press raised — the inbox's newest notice. */
const newest = () => useNotifications.getState().notices[0];

/** What a settled combo table answers back. Only the two figures the sentence reads matter. */
const COMBOS = {
  combos: 105_478,
  cards: 7_310,
  stamp: "2026-08-27T03:12:44Z",
  fetchedAt: 1_756_000_000,
  checkedAt: 1_756_000_000,
  stale: false,
};

/**
 * A promise held open, so a test can stand between the two halves of one press.
 *
 * The combo clear is `combosClear` and then `combosRefresh` inside a single `mutationFn`, and
 * every interesting claim about it is about the gap: that the second call has not happened yet,
 * and that `pending` is still true while it has not answered. Neither is observable against a
 * mock that resolves immediately.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let client: QueryClient;
let invalidate: MockInstance<QueryClient["invalidateQueries"]>;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

/** The roots one press marked stale, flattened to their heads for a readable assertion. */
const invalidatedRoots = () =>
  invalidate.mock.calls.map(([filters]) => (filters?.queryKey as string[])[0]);

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  invalidate = vi.spyOn(client, "invalidateQueries").mockReturnValue(Promise.resolve());
  collectionClear.mockReset().mockResolvedValue({ entries: 12 });
  wishlistClear.mockReset().mockResolvedValue(4);
  decksClear.mockReset().mockResolvedValue({ decks: 2, folders: 1 });
  cacheClear.mockReset().mockResolvedValue({ files: 20, bytes: 4_000, rows: 20, failed: 0 });
  combosClear.mockReset().mockResolvedValue({ ...COMBOS, combos: 0, cards: 0, stale: true });
  combosRefresh.mockReset().mockResolvedValue(COMBOS);
});

describe("useDangerZone", () => {
  /**
   * The five roots, and four of them are joins rather than the table that was emptied. This is
   * the assertion that would have caught the obvious version of this hook — the one that
   * invalidates `["collection"]` and leaves every search row still claiming an `ownedQuantity`.
   *
   * **`["wishlist"]` is the one that went missing once** (issue #1179): a wish reports the copies
   * the collection holds of it (`ownedExact`, `ownedOther`, `ownedPlaces`), so a wipe moves a
   * figure on every row of that page, and this is what goes red if the root is dropped again.
   */
  it("marks every root a cleared collection can have made wrong", async () => {
    const { result } = renderHook(() => useDangerZone(), { wrapper });

    act(() => result.current.collection.run());

    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(invalidatedRoots().sort()).toEqual(["card", "cards", "collection", "decks", "wishlist"]);
  });

  /**
   * **Three roots, and the second is what schema v25 added.** Every deck's group is a
   * `collection_folders` row, so a wipe takes the whole set of them and files the copies they
   * were holding into `Recently removed` — the collection's folder tree, its summary and its
   * list are all changed by that press. **The third is the managed wishlists'** (issue #1179):
   * deleting a deck drops the wishlist folders it managed, with their wishes, and a Wishlist that
   * kept drawing them would refuse every write to them. The **card** roots are still an absence
   * worth pinning: a copy that changes folder is a copy the reader still owns,
   * `CardSummary.ownedQuantity` is a sum over quantities, and no quantity moved — so the search
   * wall cannot read differently afterwards.
   */
  it("marks the decks, the collection and the wishlist when the decks are cleared", async () => {
    const { result } = renderHook(() => useDangerZone(), { wrapper });

    act(() => result.current.decks.run());

    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(invalidatedRoots().sort()).toEqual(["collection", "decks", "wishlist"]);
  });

  /** A toast, since the confirmation that asked has closed: the outcome sentence in the toast's
   *  own voice (no full stop), and one sentence means no body. */
  it("reports what the clear did as a toast", async () => {
    const { result } = renderHook(() => useDangerZone(), { wrapper });

    act(() => result.current.wishlist.run());

    await waitFor(() =>
      expect(newest()).toMatchObject({ tone: "success", title: "Cleared 4 wishlist entries" }),
    );
    expect(newest()?.body).toBeUndefined();
  });

  it("says a clear that found nothing as news rather than a success", async () => {
    collectionClear.mockResolvedValueOnce({ entries: 0 });
    const { result } = renderHook(() => useDangerZone(), { wrapper });

    act(() => result.current.collection.run());

    await waitFor(() =>
      expect(newest()).toMatchObject({ tone: "info", title: "The collection was already empty" }),
    );
  });

  /**
   * Two presses, two notices, in the order they settled — a refusal does not swallow the success
   * before it, and the inbox keeps both. There is no shared line for one to overwrite any more.
   */
  it("toasts a refused clear after an earlier one's success, keeping both", async () => {
    const { result } = renderHook(() => useDangerZone(), { wrapper });

    act(() => result.current.wishlist.run());
    await waitFor(() => expect(newest()?.tone).toBe("success"));

    decksClear.mockRejectedValueOnce("The card database is busy.");
    act(() => result.current.decks.run());

    await waitFor(() =>
      expect(newest()).toMatchObject({
        tone: "error",
        title: "Couldn't clear the decks",
        body: "The card database is busy.",
      }),
    );
    expect(useNotifications.getState().notices.map((n) => n.title)).toEqual([
      "Couldn't clear the decks",
      "Cleared 4 wishlist entries",
    ]);
  });

  it("says nothing at all until something has been pressed", () => {
    renderHook(() => useDangerZone(), { wrapper });

    expect(useNotifications.getState().notices).toHaveLength(0);
  });
});

describe("useLocalCache", () => {
  /**
   * **Nothing goes stale, and that is the point.** Card art is served over `mtgimg://` outside
   * the query cache entirely, so a sweep that invalidated anything would be refetching rows to
   * describe bytes no row describes.
   */
  it("marks no query stale", async () => {
    const { result } = renderHook(() => useLocalCache(), { wrapper });

    act(() => result.current.clear.run());

    await waitFor(() => expect(newest()).toBeDefined());
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("says what it freed", async () => {
    const { result } = renderHook(() => useLocalCache(), { wrapper });

    act(() => result.current.clear.run());

    await waitFor(() =>
      expect(newest()).toMatchObject({ tone: "success", title: "Freed 4 KB across 20 files" }),
    );
  });

  /** Two sentences, and the toast splits them: what happened is the title, what did not the body. */
  it("puts the files it could not delete under the receipt, as a warning", async () => {
    cacheClear.mockResolvedValueOnce({ files: 20, bytes: 4_000, rows: 20, failed: 2 });
    const { result } = renderHook(() => useLocalCache(), { wrapper });

    act(() => result.current.clear.run());

    await waitFor(() =>
      expect(newest()).toMatchObject({
        tone: "warning",
        title: "Freed 4 KB across 20 files",
        body: "2 files were in use and couldn't be deleted.",
      }),
    );
  });

  it("shows the mid-sync refusal as the backend words it", async () => {
    cacheClear.mockRejectedValueOnce(
      "a card update is running — clear the cache once it has finished",
    );
    const { result } = renderHook(() => useLocalCache(), { wrapper });

    act(() => result.current.clear.run());

    await waitFor(() =>
      expect(newest()).toMatchObject({
        tone: "error",
        title: "Couldn't clear the cache",
        body: "a card update is running — clear the cache once it has finished",
      }),
    );
  });

  /**
   * **The order is the behaviour, not an implementation detail.** `combos_clear` downloads
   * nothing, so a press that fetched first and deleted afterwards would end with an empty table —
   * the exact state the reader pressed this to leave. Asserting only that both were called passes
   * against that defect, so the clear is held open and the refresh is checked for *not* having
   * happened yet.
   */
  it("clears the combos first, and only fetches once the clear has answered", async () => {
    const held = deferred<typeof COMBOS>();
    combosClear.mockReturnValueOnce(held.promise);
    const { result } = renderHook(() => useLocalCache(), { wrapper });

    act(() => result.current.combos.run());

    await waitFor(() => expect(combosClear).toHaveBeenCalledOnce());
    expect(combosRefresh).not.toHaveBeenCalled();

    await act(async () => held.resolve({ ...COMBOS, combos: 0, cards: 0, stale: true }));

    await waitFor(() => expect(combosRefresh).toHaveBeenCalledOnce());
    // `force: true` and not the default: the schedule is weekly, so an honoured throttle would
    // leave the table this press has just emptied empty until the next launch that is due.
    expect(combosRefresh).toHaveBeenCalledWith(true);
  });

  /**
   * The download is 27.5 MB over 639 MB of JSON — tens of seconds — and the button is greyed off
   * this flag. A `pending` that dropped when the *clear* returned would hand the reader an armed
   * button over a table that is briefly empty, which is the one moment a second press is worst.
   */
  it("stays pending across the download and not just the clear", async () => {
    const held = deferred<typeof COMBOS>();
    combosRefresh.mockReturnValueOnce(held.promise);
    const { result } = renderHook(() => useLocalCache(), { wrapper });

    act(() => result.current.combos.run());

    await waitFor(() => expect(combosRefresh).toHaveBeenCalledOnce());
    expect(result.current.combos.pending).toBe(true);
    expect(useNotifications.getState().notices).toHaveLength(0);

    await act(async () => held.resolve(COMBOS));

    await waitFor(() => expect(result.current.combos.pending).toBe(false));
  });

  it("reports the table that came back", async () => {
    const { result } = renderHook(() => useLocalCache(), { wrapper });

    act(() => result.current.combos.run());

    await waitFor(() =>
      expect(newest()).toMatchObject({
        tone: "success",
        title: "Downloaded 105,478 combos covering 7,310 cards",
      }),
    );
  });

  /**
   * **`onSettled` rather than `onSuccess`, and this is the half that says why.** The clear lands
   * first, so a refresh that then fails has still emptied the tables — every cached combo answer
   * is describing rows that are gone, and `lib/query.ts` caches 30 s, which is exactly long
   * enough for an open deck's bracket advisory to look deliberate rather than stale.
   */
  it("marks the combo root stale whichever way the press ended", async () => {
    const { result } = renderHook(() => useLocalCache(), { wrapper });

    act(() => result.current.combos.run());
    await waitFor(() => expect(newest()?.tone).toBe("success"));
    expect(invalidatedRoots()).toEqual(["combos"]);

    invalidate.mockClear();
    combosRefresh.mockRejectedValueOnce("Commander Spellbook could not be reached.");
    act(() => result.current.combos.run());

    await waitFor(() => expect(newest()?.tone).toBe("error"));
    expect(invalidatedRoots()).toEqual(["combos"]);
  });

  /** A failed re-download is a refusal, not a table of zeroes — the reader is told which. */
  it("surfaces a failed re-download instead of claiming a number", async () => {
    combosRefresh.mockRejectedValueOnce("Commander Spellbook could not be reached.");
    const { result } = renderHook(() => useLocalCache(), { wrapper });

    act(() => result.current.combos.run());

    await waitFor(() =>
      expect(newest()).toMatchObject({
        tone: "error",
        title: "Couldn't refresh combos",
        body: "Commander Spellbook could not be reached.",
      }),
    );
  });
});
