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

/**
 * The metered-link guard, standing in for the provider.
 *
 * Its default is the desktop one — `AskFirst`'s own `RUN_IT`, synchronous and a pass-through —
 * so every other test here reads as though the wrapper were not there. Mocked rather than driven
 * through `FeedDownloadProvider` because the real one branches on `isWebTarget()` and probes a
 * size over `fetch`, and what this hook owes the guard is one call with one feed id.
 */
const askFirst = vi.hoisted(() => vi.fn((_feed: string, run: () => void) => run()));
vi.mock("@/pwa/FeedDownloadProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/pwa/FeedDownloadProvider")>()),
  useFeedDownload: () => askFirst,
}));

import { useDangerZone, useLocalCache } from "./useDataReset";

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
  // `mockClear` and not `mockReset`: the default pass-through implementation is what every test
  // but one relies on, and a reset would take it away.
  askFirst.mockClear();
});

describe("useDangerZone", () => {
  /**
   * The four roots, and three of them are joins rather than the table that was emptied. This is
   * the assertion that would have caught the obvious version of this hook — the one that
   * invalidates `["collection"]` and leaves every search row still claiming an `ownedQuantity`.
   *
   * **`["wishlist"]` is a fifth that used to be here and is now pinned as an absence**, which is
   * the more interesting half: a wish counted the copies that already filled it, so a wipe moved
   * a figure on every row of that page. It reads nothing out of `collection_entries` any more, so
   * a collection clear leaves the wishlist saying exactly what it said before — and this
   * assertion is what would go red if the root came back.
   */
  it("marks every root a cleared collection can have made wrong", async () => {
    const { result } = renderHook(() => useDangerZone(), { wrapper });

    act(() => result.current.collection.run());

    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(invalidatedRoots().sort()).toEqual(["card", "cards", "collection", "decks"]);
  });

  /**
   * **Two roots, and the second is what schema v25 added.** Every deck's group is a
   * `collection_folders` row, so a wipe takes the whole set of them and files the copies they
   * were holding into `Recently removed` — the collection's folder tree, its summary and its
   * list are all changed by that press. The **card** roots are still an absence worth pinning:
   * a copy that changes folder is a copy the reader still owns, `CardSummary.ownedQuantity` is
   * a sum over quantities, and no quantity moved — so the search wall cannot read differently
   * afterwards, and neither can the wishlist, which reads no collection figure at all.
   */
  it("marks the decks and the collection when the decks are cleared", async () => {
    const { result } = renderHook(() => useDangerZone(), { wrapper });

    act(() => result.current.decks.run());

    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(invalidatedRoots().sort()).toEqual(["collection", "decks"]);
  });

  it("reports what the clear did, in the panel's plain tone", async () => {
    const { result } = renderHook(() => useDangerZone(), { wrapper });

    act(() => result.current.wishlist.run());

    await waitFor(() =>
      expect(result.current.status).toEqual({
        tone: "plain",
        text: "Cleared 4 wishlist entries.",
      }),
    );
  });

  /**
   * The rule `@/lib/writes` exists for, applied across three buttons: a refusal replaces the
   * sentence a *different* button left standing, rather than the panel reporting a success that
   * has been overtaken.
   */
  it("lets a refused clear replace an earlier one's success", async () => {
    const { result } = renderHook(() => useDangerZone(), { wrapper });

    act(() => result.current.wishlist.run());
    await waitFor(() => expect(result.current.status?.tone).toBe("plain"));

    decksClear.mockRejectedValueOnce("The card database is busy.");
    act(() => result.current.decks.run());

    await waitFor(() =>
      expect(result.current.status).toEqual({
        tone: "problem",
        text: "The card database is busy.",
      }),
    );
  });

  /** And back the other way, which is the half a one-directional implementation gets wrong. */
  it("lets a later success replace a refusal", async () => {
    const { result } = renderHook(() => useDangerZone(), { wrapper });

    decksClear.mockRejectedValueOnce("The card database is busy.");
    act(() => result.current.decks.run());
    await waitFor(() => expect(result.current.status?.tone).toBe("problem"));

    act(() => result.current.collection.run());

    await waitFor(() =>
      expect(result.current.status).toEqual({
        tone: "plain",
        text: "Cleared 12 collection entries.",
      }),
    );
  });

  it("says nothing at all until something has been pressed", () => {
    const { result } = renderHook(() => useDangerZone(), { wrapper });

    expect(result.current.status).toBeNull();
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

    await waitFor(() => expect(result.current.status).not.toBeNull());
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("says what it freed", async () => {
    const { result } = renderHook(() => useLocalCache(), { wrapper });

    act(() => result.current.clear.run());

    await waitFor(() =>
      expect(result.current.status).toEqual({
        tone: "plain",
        text: "Freed 4 KB across 20 files.",
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
      expect(result.current.status).toEqual({
        tone: "problem",
        text: "a card update is running — clear the cache once it has finished",
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
   * **The guard wraps the press, not the mutation.** 27.5 MB gzipped: on the web target that is
   * a question before it is a download, and a reader who answers Not now must be left with a
   * button that has done nothing and a table still full — so nothing is cleared and `pending`
   * never rises. On desktop the same call is a synchronous pass-through and costs a frame of
   * nothing.
   */
  it("puts the metered-link question before the 27.5 MB", () => {
    askFirst.mockImplementationOnce(() => {});
    const { result } = renderHook(() => useLocalCache(), { wrapper });

    act(() => result.current.combos.run());

    expect(askFirst).toHaveBeenCalledWith("combos", expect.any(Function));
    expect(combosClear).not.toHaveBeenCalled();
    expect(result.current.combos.pending).toBe(false);
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
    expect(result.current.status).toBeNull();

    await act(async () => held.resolve(COMBOS));

    await waitFor(() => expect(result.current.combos.pending).toBe(false));
  });

  it("reports the table that came back", async () => {
    const { result } = renderHook(() => useLocalCache(), { wrapper });

    act(() => result.current.combos.run());

    await waitFor(() =>
      expect(result.current.status).toEqual({
        tone: "plain",
        text: "Cleared and downloaded again: 105,478 combos, naming 7,310 cards between them.",
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
    await waitFor(() => expect(result.current.status).not.toBeNull());
    expect(invalidatedRoots()).toEqual(["combos"]);

    invalidate.mockClear();
    combosRefresh.mockRejectedValueOnce("Commander Spellbook could not be reached.");
    act(() => result.current.combos.run());

    await waitFor(() => expect(result.current.status?.tone).toBe("problem"));
    expect(invalidatedRoots()).toEqual(["combos"]);
  });

  /** A failed re-download is a refusal, not a table of zeroes — the reader is told which. */
  it("surfaces a failed re-download instead of claiming a number", async () => {
    combosRefresh.mockRejectedValueOnce("Commander Spellbook could not be reached.");
    const { result } = renderHook(() => useLocalCache(), { wrapper });

    act(() => result.current.combos.run());

    await waitFor(() =>
      expect(result.current.status).toEqual({
        tone: "problem",
        text: "Commander Spellbook could not be reached.",
      }),
    );
  });

  /**
   * One banner for two buttons, `useDangerZone`'s rule on a smaller panel: the most recently
   * *started* write owns the line, so the image sweep's sentence does not sit under a combo
   * refusal, or the other way round.
   */
  it("lets the newer of the two presses own the one status line", async () => {
    const { result } = renderHook(() => useLocalCache(), { wrapper });

    act(() => result.current.clear.run());
    await waitFor(() => expect(result.current.status?.text).toContain("Freed"));

    act(() => result.current.combos.run());

    await waitFor(() => expect(result.current.status?.text).toContain("105,478 combos"));
  });
});
