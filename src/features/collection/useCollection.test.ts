import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { CollectionPage, CollectionQuery } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";

const collectionList = vi.hoisted(() => vi.fn());
const collectionSummary = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { collectionList, collectionSummary },
}));

import { activeFilterCount, nextOffset, useCollection } from "./useCollection";

/**
 * Flatten lives in the app store now, and the app store is a **module singleton** — so unlike
 * every `useState` in this hook it is not handed back fresh to each `renderHook`. A test that
 * left it on would hand the next one a flattened cabinet, and the failure would land wherever
 * the file happens to run that test rather than where the bug is.
 *
 * The whole initial state rather than the one field, which is `store.test.ts`'s idiom: it cannot
 * go stale when the default moves, and it resets anything a later test in this file starts using.
 */
beforeEach(() => useAppStore.setState(useAppStore.getInitialState()));

const NONE = {
  text: "",
  format: "",
  colors: [],
  sets: [],
  manaValues: [],
  manaX: false,
  rarities: [],
  priceMin: undefined,
  priceMax: undefined,
  finishes: [],
  conditions: [],
  needsReview: undefined,
};

describe("activeFilterCount", () => {
  it("is zero when nothing is filtered", () => {
    expect(activeFilterCount(NONE)).toBe(0);
  });

  /**
   * Kinds, not values — the badge on Reset all tells the reader how much is about to
   * change, and "two finishes" is one thing that is on.
   */
  it("counts each kind of filter once", () => {
    expect(activeFilterCount({ ...NONE, finishes: ["foil", "etched"] })).toBe(1);
    expect(activeFilterCount({ ...NONE, conditions: ["NM", "LP"] })).toBe(1);
    expect(activeFilterCount({ ...NONE, needsReview: true })).toBe(1);
    // `false` — "the rows nothing flagged" — is a filter too, and is where the reader lands
    // once the flagged ones are dealt with. Compared against `undefined`, never tested for
    // truthiness, which is the whole difference between a tri-state and a checkbox.
    expect(activeFilterCount({ ...NONE, needsReview: false })).toBe(1);
    expect(activeFilterCount({ ...NONE, rarities: ["rare", "mythic"] })).toBe(1);
  });

  /**
   * The band is one kind however many of its two ends are set — `$5 – $20` is one control and
   * one thing to clear, so a reader who set both ends must not read `Reset all 2` over it.
   */
  it("counts a price band once, whichever ends of it are set", () => {
    expect(activeFilterCount({ ...NONE, priceMin: 5 })).toBe(1);
    expect(activeFilterCount({ ...NONE, priceMax: 20 })).toBe(1);
    expect(activeFilterCount({ ...NONE, priceMin: 5, priceMax: 20 })).toBe(1);
  });

  /** A floor of zero is a bound the reader typed, and `0` is falsy — so this is the case a
   *  truthiness test would drop, leaving Reset all dark over a list that really is banded. */
  it("counts a floor of zero", () => {
    expect(activeFilterCount({ ...NONE, priceMin: 0 })).toBe(1);
  });

  /** Whitespace is not a search. */
  it("ignores a blank search box", () => {
    expect(activeFilterCount({ ...NONE, text: "   " })).toBe(0);
  });

  /**
   * The collection's row is longer than the search's by three: what the copy is (finish),
   * what state it is in (condition), and whether it is one of the rows a sync flagged. Ten
   * kinds over twelve fields — the price band is one kind with two ends, and the X chip rides
   * with the mana values. Reset all has to reach every one of them, so the count has to see
   * every one of them.
   */
  it("sees all ten kinds the collection offers", () => {
    expect(
      activeFilterCount({
        text: "bolt",
        format: "modern",
        colors: ["R"],
        sets: ["lea"],
        manaValues: [1],
        manaX: true,
        rarities: ["rare"],
        priceMin: 5,
        priceMax: 20,
        finishes: ["foil"],
        conditions: ["NM"],
        needsReview: true,
      }),
    ).toBe(10);
  });

  /** X is the last chip of the mana-value group and is OR'd with the numerals, so it is that
   *  same kind — but an X-only filter still has to be seen, or Reset all would hide over a
   *  list that is filtered. */
  it("counts the X chip with the mana values it sits among", () => {
    expect(activeFilterCount({ ...NONE, manaX: true })).toBe(1);
    expect(activeFilterCount({ ...NONE, manaValues: [1], manaX: true })).toBe(1);
  });
});

const page = (items: number, total: number): CollectionPage => ({
  items: Array.from({ length: items }, (_, i) => ({ id: i }) as never),
  total,
});

describe("nextOffset", () => {
  it("asks for the next page at the number of rows already seen", () => {
    expect(nextOffset([page(100, 250)])).toBe(100);
    expect(nextOffset([page(100, 250), page(100, 250)])).toBe(200);
  });

  it("stops once the whole collection is loaded", () => {
    expect(nextOffset([page(100, 100)])).toBeUndefined();
    expect(nextOffset([page(100, 150), page(50, 150)])).toBeUndefined();
  });

  /** `total` and the rows can disagree while a write lands between two pages; a short page
   *  is the end of the data whatever the count says. */
  it("stops on a short page even when the total disagrees", () => {
    expect(nextOffset([page(0, 9999)])).toBeUndefined();
  });
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

const lastQuery = () =>
  collectionList.mock.calls[collectionList.mock.calls.length - 1][0] as CollectionQuery;

describe("useCollection", () => {
  beforeEach(() => {
    collectionList.mockReset().mockResolvedValue({ items: [], total: 0 });
    collectionSummary.mockReset().mockResolvedValue({
      totalCards: 0,
      uniqueCards: 0,
      entries: 0,
      tradelistCards: 0,
      value: 0,
      unpriced: 0,
      needsReview: 0,
    });
  });

  it("clears all eight filters at once", async () => {
    const { result } = renderHook(() => useCollection(), { wrapper });
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    act(() => {
      result.current.setText("bolt");
      result.current.setFormat("modern");
      result.current.toggleColor("R");
      result.current.toggleSet("lea");
      result.current.toggleManaValue(1);
      // The tenth chip of the mana-value group, cleared by the same press — and not a ninth
      // kind: it is counted with the numerals it sits among, so the badge still reads 8.
      result.current.toggleManaX();
      result.current.toggleFinish("foil");
      result.current.toggleCondition("NM");
      result.current.toggleNeedsReview();
    });

    expect(result.current.activeCount).toBe(8);

    act(() => result.current.resetAll());

    expect(result.current.activeCount).toBe(0);
    expect(result.current.finishes).toEqual([]);
    expect(result.current.conditions).toEqual([]);
    expect(result.current.manaX).toBe(false);
    expect(result.current.needsReview).toBeUndefined();
    await waitFor(() => {
      const q = lastQuery();
      expect(q.text).toBeUndefined();
      expect(q.finishes).toBeUndefined();
      expect(q.conditions).toBeUndefined();
      expect(q.manaX).toBeUndefined();
      expect(q.needsReview).toBeUndefined();
    });
  });

  /**
   * The X chip, end to end and without a facet in sight — this view wires no counts at all,
   * so the chip's whole job here is to reach the query and the key.
   *
   * The key is the half that can fail silently: "costs 1" and "costs 1, or has an X in its
   * cost" are two different sets of rows over the same local SQLite, so a key that could not
   * tell them apart would answer the second out of the first's cached pages instantly, with
   * nothing on screen to notice. A new request having gone out at all is therefore the
   * assertion, and the payload is read from that request rather than from a re-render.
   */
  it("sends the X chip and keys the query on it", async () => {
    const { result } = renderHook(() => useCollection(), { wrapper });
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    act(() => result.current.toggleManaValue(1));
    await waitFor(() => expect(lastQuery().manaValues).toEqual([1]));
    const asked = collectionList.mock.calls.length;
    const key = result.current.queryKeyString;

    act(() => result.current.toggleManaX());

    await waitFor(() => expect(collectionList.mock.calls.length).toBeGreaterThan(asked));
    expect(result.current.queryKeyString).not.toBe(key);
    expect(lastQuery().manaX).toBe(true);
    // Additive: the numeral it was pressed beside is still on the wire, because `cmc` counts
    // `{X}` as zero and a `{X}` card answers both chips.
    expect(lastQuery().manaValues).toEqual([1]);

    // …and turning it back off is the same search again, by the same key. The key is a
    // function of the filters and of nothing else, so this is also what says the segment is
    // the chip's own rather than something that grows on every press.
    act(() => result.current.toggleManaX());

    expect(result.current.queryKeyString).toBe(key);
  });

  /**
   * The chip the wishlist's twin already was. The backend has always taken three states
   * here — `collection::scope`'s `match` over `Option<bool>` — and the collection was the
   * one view that could only ask two of them, so "everything the sync did not touch" was a
   * question the reader could not put to the list they were looking at.
   *
   * `false` reaches the wire as `false`, which is the load-bearing half: dropping it the way
   * a blank string is dropped would silently turn the complement back into "ask nothing".
   */
  it("walks the needs-review filter through all three states", async () => {
    const { result } = renderHook(() => useCollection(), { wrapper });
    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    expect(result.current.needsReview).toBeUndefined();

    act(() => result.current.toggleNeedsReview());
    expect(result.current.needsReview).toBe(true);
    await waitFor(() => expect(lastQuery().needsReview).toBe(true));

    act(() => result.current.toggleNeedsReview());
    expect(result.current.needsReview).toBe(false);
    await waitFor(() => expect(lastQuery().needsReview).toBe(false));

    act(() => result.current.toggleNeedsReview());
    expect(result.current.needsReview).toBeUndefined();
    await waitFor(() => expect(lastQuery().needsReview).toBeUndefined());
  });

  /** The two answered states are two different sets of rows, so they are two different
   *  requests — a key that spelled both `""` would serve the complement from the cache of
   *  the flagged rows. */
  it("keys the three needs-review states apart", () => {
    const { result } = renderHook(() => useCollection(), { wrapper });
    const off = result.current.queryKeyString;

    act(() => result.current.toggleNeedsReview());
    const flagged = result.current.queryKeyString;
    act(() => result.current.toggleNeedsReview());
    const clear = result.current.queryKeyString;

    expect(new Set([off, flagged, clear]).size).toBe(3);
  });

  /**
   * The key is the identity of the request. A new finish is a different set of rows and has
   * to cost a round trip; the *same* two finishes picked in the other order is the same set
   * of rows and must not, or every chip row would be a cache miss waiting to happen.
   */
  it("keys the query on which finishes are picked, not on the order they were picked in", async () => {
    const { result } = renderHook(() => useCollection(), { wrapper });
    const empty = result.current.queryKeyString;

    act(() => result.current.toggleFinish("foil"));
    const foil = result.current.queryKeyString;
    expect(foil).not.toBe(empty);

    act(() => result.current.toggleFinish("etched"));
    const both = result.current.queryKeyString;
    expect(both).not.toBe(foil);

    act(() => {
      result.current.toggleFinish("foil");
      result.current.toggleFinish("etched");
      result.current.toggleFinish("etched");
      result.current.toggleFinish("foil");
    });

    expect(result.current.finishes).toEqual(["etched", "foil"]);
    expect(result.current.queryKeyString).toBe(both);
  });

  /**
   * The summary is a statement about a *set* of rows, and an order is not part of a set —
   * so re-sorting the table must not re-run nine aggregates over the same rows.
   */
  it("re-sorts the list without re-asking what the collection adds up to", async () => {
    const { result } = renderHook(() => useCollection(), { wrapper });
    await waitFor(() => expect(collectionSummary).toHaveBeenCalledTimes(1));

    act(() => result.current.setSortKey("price"));

    await waitFor(() => expect(lastQuery().sort).toEqual([{ key: "price", dir: "desc" }]));
    expect(collectionSummary).toHaveBeenCalledTimes(1);
  });

  /**
   * The three states the collection's root gained when Flatten landed, read off the wire.
   *
   * This is the assertion that keeps `useCollection.ts`'s comments honest, and it is worth
   * making at the payload rather than at the state: the meaning of an absent `folderId` did
   * **not** change — it is still "every folder" on the other end, because the mirror, the
   * export sweep, the deck panel and the importer's preview all ask their question by saying
   * nothing. What changed is that this view now says the narrow thing explicitly.
   *
   * **The unflattened start is stated rather than assumed.** It used to be `useState(false)` and
   * therefore free; the store's default is `true`, so this test would otherwise open on the third
   * of its three states and never reach the first two.
   */
  it("sends rootOnly at the root, folderId inside a folder, and neither when flattened", async () => {
    useAppStore.setState({ collectionFlattened: false });
    const { result } = renderHook(() => useCollection(), { wrapper });
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    // The view opens at the root, which narrows now — `rootOnly` is what says which of the two
    // things an absent `folderId` could mean is the one meant.
    expect(lastQuery().folderId).toBeUndefined();
    expect(lastQuery().rootOnly).toBe(true);

    act(() => result.current.openFolder(3));

    await waitFor(() => expect(lastQuery().folderId).toBe(3));
    // `folderId` outranks the flag on the other end, so a flag riding along beside it would be
    // a payload saying something the backend then ignores.
    expect(lastQuery().rootOnly).toBeUndefined();

    act(() => result.current.openFolder(null));
    act(() => result.current.toggleFlatten());

    // Neither field: absent + absent is "every folder", which is exactly what Flatten asks for
    // and the one state this query has always been able to answer.
    await waitFor(() => expect(lastQuery().rootOnly).toBeUndefined());
    expect(lastQuery().folderId).toBeUndefined();
  });

  /** Flatten while standing in a folder drops the id rather than intersecting with it — the
   *  half `useCollection.ts` writes down at `filters.folderId`, and the one a reader would
   *  see as a Flatten that showed one drawer. The start is stated for the reason the test above
   *  states it: the store opens this view flattened. */
  it("stops sending folderId the moment the list is flattened", async () => {
    useAppStore.setState({ collectionFlattened: false });
    const { result } = renderHook(() => useCollection(), { wrapper });
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    act(() => result.current.openFolder(3));
    await waitFor(() => expect(lastQuery().folderId).toBe(3));

    act(() => result.current.toggleFlatten());

    await waitFor(() => expect(lastQuery().folderId).toBeUndefined());
    expect(lastQuery().rootOnly).toBeUndefined();
    // The reader has not left the folder — Flatten is a lens over where they are standing, so
    // turning it back off puts them back in it rather than at the root.
    expect(result.current.folderId).toBe(3);

    act(() => result.current.toggleFlatten());

    await waitFor(() => expect(lastQuery().folderId).toBe(3));
  });

  /**
   * Flatten is navigation, not a filter — the same fence `folderId` and `sort` already sit
   * behind. `useCollection.ts` states it at the selector, at `activeCount` and at `resetAll`;
   * this is what keeps all three honest.
   *
   * **`resetAll` leaving it alone matters more now that it is store state, not less.** It is a
   * list of `set*` calls over this hook's own `useState`s, and the one thing it must never grow
   * is a reach into the store: `collectionFlattened` is persisted, so a Reset all that cleared it
   * would throw away a preference that outlives the session rather than merely re-filing the wall.
   * Asserted at the store as well as at the hook for exactly that reason.
   *
   * A real filter is on throughout, so a bug that folded navigation into the count could not
   * hide behind "both read zero".
   */
  it("neither counts flatten as a filter nor lets resetAll clear it", () => {
    useAppStore.setState({ collectionFlattened: false });
    const { result } = renderHook(() => useCollection(), { wrapper });
    expect(result.current.flatten).toBe(false);
    expect(result.current.activeCount).toBe(0);

    act(() => {
      result.current.setText("bolt");
      result.current.openFolder(3);
      result.current.toggleFlatten();
    });

    expect(result.current.flatten).toBe(true);
    expect(result.current.activeCount).toBe(1);

    act(() => result.current.resetAll());

    expect(result.current.activeCount).toBe(0);
    expect(result.current.text).toBe("");
    // The two parts `resetAll` must not touch: a cleared search that also marched the reader
    // back to the root, or out of Flatten, would be navigating on their behalf.
    expect(result.current.flatten).toBe(true);
    expect(result.current.folderId).toBe(3);
    // …and the store still holds it, which is the half a `flatten` read off a stale render
    // could not tell you. This is the assertion a `resetAll` that reset the store would fail.
    expect(useAppStore.getState().collectionFlattened).toBe(true);
  });

  /**
   * The hook reports the store's value and `toggleFlatten` writes it back — the whole of what
   * moving Flatten out of `useState` had to preserve, checked in both directions.
   *
   * The store write is the one a reader cannot make: nothing on screen sets this field outright,
   * so this stands in for the launch that hands the hook a remembered `true`.
   */
  it("reports the store's flatten and writes back through it", () => {
    useAppStore.setState({ collectionFlattened: false });
    const { result } = renderHook(() => useCollection(), { wrapper });
    expect(result.current.flatten).toBe(false);

    // The store moving is enough — the hook subscribes to the field rather than copying it.
    act(() => useAppStore.setState({ collectionFlattened: true }));
    expect(result.current.flatten).toBe(true);

    act(() => result.current.toggleFlatten());
    expect(useAppStore.getState().collectionFlattened).toBe(false);
    expect(result.current.flatten).toBe(false);

    act(() => result.current.toggleFlatten());
    expect(useAppStore.getState().collectionFlattened).toBe(true);
    expect(result.current.flatten).toBe(true);
  });

  /**
   * **The collection opens flattened**, which is the one default that changed with the move —
   * a cabinet is the reader's whole binder, and the drawers are how they file it rather than how
   * they usually read it. The wishlist's twin field starts `false`, and this is where the two
   * would be caught being the same field again.
   */
  it("starts flattened, because that is what the store remembers by default", async () => {
    const { result } = renderHook(() => useCollection(), { wrapper });

    expect(result.current.flatten).toBe(true);
    // …and it reaches the wire as the flattened request rather than the root's.
    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    expect(lastQuery().rootOnly).toBeUndefined();
    expect(lastQuery().folderId).toBeUndefined();
  });

  /**
   * The point of the move, stated as the thing `useState` could not do: two mounted hooks are
   * two subscribers to one field, so a press on either agrees on both. Under `useState` each
   * had a switch of its own and this read `true, false`.
   *
   * Not hypothetical — the collection page and its filter bar mount this hook's value from one
   * call today, but a second surface over the same list is exactly what persistence invites.
   */
  it("agrees with a second hook mounted over the same store", () => {
    useAppStore.setState({ collectionFlattened: false });
    const first = renderHook(() => useCollection(), { wrapper });
    const second = renderHook(() => useCollection(), { wrapper });

    act(() => first.result.current.toggleFlatten());

    expect(first.result.current.flatten).toBe(true);
    expect(second.result.current.flatten).toBe(true);

    act(() => second.result.current.toggleFlatten());

    expect(first.result.current.flatten).toBe(false);
    expect(second.result.current.flatten).toBe(false);
  });

  /**
   * Three levels are three lists, and the key is what keeps them apart. Against local SQLite a
   * collision answers instantly out of the wrong cache with nothing on screen to notice, which
   * is why this is asserted on the key rather than on what came back.
   */
  it("keys the root, one folder and the flattened cabinet apart", () => {
    useAppStore.setState({ collectionFlattened: false });
    const { result } = renderHook(() => useCollection(), { wrapper });
    const root = result.current.queryKeyString;

    act(() => result.current.openFolder(3));
    const folder = result.current.queryKeyString;

    act(() => result.current.openFolder(null));
    expect(result.current.queryKeyString).toBe(root);

    act(() => result.current.toggleFlatten());
    const flat = result.current.queryKeyString;

    expect(new Set([root, folder, flat]).size).toBe(3);

    // …and flattened is **one** list however the reader got there. Neither field reaches the
    // wire under Flatten, so "flattened in the Binder" and "flattened at the root" are the same
    // request, and two keys for it would be two cache entries for one answer.
    act(() => result.current.openFolder(3));

    expect(result.current.queryKeyString).toBe(flat);
  });
});
