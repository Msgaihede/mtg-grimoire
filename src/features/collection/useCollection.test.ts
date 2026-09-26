import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
// The sentinel by its name and never as `"NONE"`, which in this file would also sit two letters
// from the local `NONE` — the no-filters fixture, and a different idea entirely.
import { CONDITION_NOT_SET } from "@/lib/conditions";
import type { CollectionFolder, CollectionPage, CollectionQuery } from "@/lib/ipc";
import { UNFILED_SHELF } from "@/lib/shelves";
import { useAppStore } from "@/lib/store";

const collectionList = vi.hoisted(() => vi.fn());
const collectionSummary = vi.hoisted(() => vi.fn());
/** The folder census the shelves are built from, the per-shelf counts, and the stored folds —
 *  the three reads this hook added with shelves. Answered on every mount, because an `ipc` mock
 *  is an object literal and a command it does not carry is a synchronous `TypeError` inside a
 *  hook. */
const collectionFolderList = vi.hoisted(() => vi.fn());
const collectionShelfCounts = vi.hoisted(() => vi.fn());
const shelfFolds = vi.hoisted(() => vi.fn());
const setShelfFolds = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    collectionList,
    collectionSummary,
    collectionFolderList,
    collectionShelfCounts,
    shelfFolds,
    setShelfFolds,
  },
}));

import { activeFilterCount, nextOffset, useCollection } from "./useCollection";

/**
 * The app store is a module singleton, so unlike every `useState` in this hook it is not handed
 * back fresh to each `renderHook`. Nothing here writes it any more — Flatten was its one field
 * this hook read — but the reset is `store.test.ts`'s idiom and costs nothing to keep.
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
  types: [],
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
    // The type chips are the same rule over a row of eight: a reader narrowed to creatures and
    // lands has narrowed once.
    expect(activeFilterCount({ ...NONE, types: ["Creature", "Land"] })).toBe(1);
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
   * what state it is in (condition), and whether it is one of the rows a sync flagged. Eleven
   * kinds over thirteen fields — the price band is one kind with two ends, and the X chip rides
   * with the mana values. Reset all has to reach every one of them, so the count has to see
   * every one of them.
   *
   * **`colorsStrict` is not one of the thirteen and never will be**: it is not a field of
   * `CollectionFilterState` at all, because it modifies what a picked colour means rather than
   * narrowing anything of its own.
   */
  it("sees all eleven kinds the collection offers", () => {
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
        priceMin: 5,
        priceMax: 20,
        finishes: ["foil"],
        conditions: ["NM"],
        needsReview: true,
      }),
    ).toBe(11);
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

/** What the header last asked — the same read as {@link lastQuery}, one query along. The two are
 *  drawn together because `collection::scope` is one predicate list and they must agree. */
const lastSummary = () =>
  collectionSummary.mock.calls[collectionSummary.mock.calls.length - 1][0] as CollectionQuery;

/** What the shelf counts last asked — every shelf at and below the level, collapsed ones too. */
const lastCounts = () =>
  collectionShelfCounts.mock.calls[collectionShelfCounts.mock.calls.length - 1][0] as CollectionQuery;

/** A folder row. `sortOrder` follows the id, so siblings draw in id order. */
const folder = (id: number, over: Partial<CollectionFolder> = {}): CollectionFolder => ({
  id,
  parentId: null,
  name: `F${id}`,
  kind: "user",
  deckId: null,
  sortOrder: id,
  locked: false,
  syncUid: null,
  ...over,
});

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
    collectionFolderList.mockReset().mockResolvedValue([]);
    collectionShelfCounts.mockReset().mockResolvedValue([]);
    shelfFolds.mockReset().mockResolvedValue({ collection: {}, wishlist: {} });
    setShelfFolds.mockReset().mockResolvedValue(undefined);
  });

  it("clears all nine filters at once", async () => {
    const { result } = renderHook(() => useCollection(), { wrapper });
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    act(() => {
      result.current.setText("bolt");
      result.current.setFormat("modern");
      result.current.toggleColor("R");
      result.current.toggleSet("lea");
      result.current.toggleManaValue(1);
      // The tenth chip of the mana-value group, cleared by the same press — and not a kind of
      // its own: it is counted with the numerals it sits among, so the badge does not move.
      result.current.toggleManaX();
      result.current.toggleType("Creature");
      result.current.toggleFinish("foil");
      result.current.toggleCondition("NM");
      result.current.toggleNeedsReview();
    });

    expect(result.current.activeCount).toBe(9);

    act(() => result.current.resetAll());

    expect(result.current.activeCount).toBe(0);
    expect(result.current.finishes).toEqual([]);
    expect(result.current.conditions).toEqual([]);
    expect(result.current.manaX).toBe(false);
    expect(result.current.types).toEqual([]);
    // Cleared although the badge above never counted it — Reset all means "no filters", and a
    // strict flag left over an emptied colour row is state with no control drawn for it.
    expect(result.current.colorsStrict).toBe(false);
    expect(result.current.needsReview).toBeUndefined();
    await waitFor(() => {
      const q = lastQuery();
      expect(q.text).toBeUndefined();
      expect(q.finishes).toBeUndefined();
      expect(q.conditions).toBeUndefined();
      expect(q.manaX).toBeUndefined();
      expect(q.types).toBeUndefined();
      expect(q.colorsStrict).toBeUndefined();
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
   * The `Exact` toggle and the type chips, end to end — the X chip's test one row over, and for
   * its reason.
   *
   * The key is the half that fails silently: `R` loose and `R` strict are two different sets of
   * copies over the same local SQLite, so a key that could not tell them apart would serve the
   * strict press out of the loose list's cached pages instantly, with nothing on screen to
   * notice. A new request having gone out at all is therefore the assertion.
   */
  it("sends both new filters and keys the query on each", async () => {
    const { result } = renderHook(() => useCollection(), { wrapper });
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    // Absent rather than `false`: an off chip is not a filter, and `false` on the wire would read
    // as "the reader chose loose" where they chose nothing at all.
    expect(lastQuery().colorsStrict).toBeUndefined();
    expect(lastQuery().types).toBeUndefined();

    act(() => result.current.toggleColor("R"));
    await waitFor(() => expect(lastQuery().colors).toBe("R"));
    const askedColours = collectionList.mock.calls.length;
    const looseKey = result.current.queryKeyString;

    act(() => result.current.toggleColorsStrict());

    await waitFor(() => expect(collectionList.mock.calls.length).toBeGreaterThan(askedColours));
    expect(result.current.queryKeyString).not.toBe(looseKey);
    expect(lastQuery().colorsStrict).toBe(true);
    // The letters are unchanged: strict modifies the row rather than replacing it.
    expect(lastQuery().colors).toBe("R");

    const askedTypes = collectionList.mock.calls.length;
    const strictKey = result.current.queryKeyString;

    act(() => result.current.toggleType("Creature"));

    await waitFor(() => expect(collectionList.mock.calls.length).toBeGreaterThan(askedTypes));
    expect(result.current.queryKeyString).not.toBe(strictKey);
    expect(lastQuery().types).toEqual(["Creature"]);
    // Sorted on the way out, so a press order is not a fact about the filter — picking Land
    // second has to be the same request, and the same cache entry, as picking it first.
    act(() => result.current.toggleType("Land"));
    await waitFor(() => expect(lastQuery().types).toEqual(["Creature", "Land"]));

    // **Clearing the last colour leaves strict standing and takes it off the wire.** It used to
    // clear the flag, because the `Exactly` chip was only rendered while a colour was picked; the
    // `Exact` toggle is in the tray and always drawn now, so clearing the colours would flip a
    // control the reader can see. `strictParam` is what keeps a modifier with nothing to modify
    // out of the key above.
    act(() => result.current.toggleColor("R"));

    expect(result.current.colors).toEqual([]);
    expect(result.current.colorsStrict).toBe(true);
    await waitFor(() => expect(lastQuery().colorsStrict).toBeUndefined());
  });

  /**
   * **"Which copies have I never graded?" is a filter, and it costs nothing to be one.**
   *
   * The grade the sixth chip stands for is a stored value like the other five — the `NONE`
   * sentinel, not a `NULL` and not an absent row — so the filter arrives for free the moment
   * `CONDITIONS` grows: this hook narrows the reader's picks *through* that list rather than
   * validating against it, which is also what canonicalises the payload. The order asserted here
   * is `CONDITIONS`' own, so the ungraded pile leads the list on the wire the same way it leads
   * the chips; picking the two the other way round has to be the same request, or every chip row
   * would be a cache miss waiting to happen.
   *
   * The literal is deliberately the imported constant. A test spelling `"NONE"` would go on
   * passing against a hook that had stopped agreeing with the vocabulary it filters through.
   */
  it("asks for the copies whose grade was never stated", async () => {
    const { result } = renderHook(() => useCollection(), { wrapper });
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    act(() => result.current.toggleCondition(CONDITION_NOT_SET));
    await waitFor(() => expect(lastQuery().conditions).toEqual([CONDITION_NOT_SET]));

    act(() => result.current.toggleCondition("LP"));
    await waitFor(() => expect(lastQuery().conditions).toEqual([CONDITION_NOT_SET, "LP"]));
    const both = result.current.queryKeyString;

    act(() => {
      result.current.toggleCondition("LP");
      result.current.toggleCondition(CONDITION_NOT_SET);
      result.current.toggleCondition("LP");
      result.current.toggleCondition(CONDITION_NOT_SET);
    });

    expect(result.current.queryKeyString).toBe(both);
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
   * **A locked drawer's copies belong to this page, and neither read may ask them away** —
   * [issue #436](https://github.com/Msgaihede/mtg-grimoire/issues/436).
   *
   * Both queries sent `excludeLocked: true` from #365 until 2026-09-09, so setting a drawer
   * aside took its copies off the flattened wall **and** out of the reader's card count, unique
   * count and total value. The report was the header: a set-aside card is still a card they own,
   * and a collection page that will not count it is the app disagreeing with the cardboard on
   * their shelf. The lock is about what the app offers a *deck*, which is why
   * `useCollectionSearch` still sends the flag unconditionally and has its own assertion saying
   * so — that test is this one's other half, and one of the two going green alone is the
   * feature half-undone.
   *
   * **Asserted on both calls, because widening one alone is the plausible mistake.** `scope` is
   * one predicate list, so a summary that asked a different question than the list would price a
   * wall the reader is not looking at — 38 cards over 26 tiles, which is a worse sentence than
   * the one #436 was reported about. Read off the wire rather than off any state, exactly like
   * the three-state test below it.
   *
   * A real filter is on throughout, so this cannot pass by both payloads being empty.
   */
  it("asks neither its list nor its header to leave out a locked drawer", async () => {
    const { result } = renderHook(() => useCollection(), { wrapper });
    await waitFor(() => expect(collectionSummary).toHaveBeenCalled());

    act(() => result.current.toggleFinish("foil"));

    await waitFor(() => expect(lastQuery().finishes).toEqual(["foil"]));
    expect(lastQuery().excludeLocked).toBeUndefined();

    await waitFor(() => expect(lastSummary().finishes).toEqual(["foil"]));
    expect(lastSummary().excludeLocked).toBeUndefined();
  });

  /**
   * **The wire, at the root and inside a folder.** `shelves` replaces both old fields: the list
   * is every shelf the wall draws, in the order it draws them — Not sorted, then the reader's
   * tree depth-first — and inside a folder it starts with that folder's own (headless) shelf.
   * `folderId` and `rootOnly` never ride beside it; the backend would ignore them, and a payload
   * saying something the backend ignores is lying about intent.
   */
  it("sends the shelves at and below the level, and never folderId or rootOnly", async () => {
    collectionFolderList.mockResolvedValue([folder(3), folder(9, { parentId: 3 }), folder(4)]);
    const { result } = renderHook(() => useCollection(), { wrapper });

    await waitFor(() => expect(lastQuery().shelves).toEqual([UNFILED_SHELF, 3, 9, 4]));
    expect(lastQuery().folderId).toBeUndefined();
    expect(lastQuery().rootOnly).toBeUndefined();

    act(() => result.current.openFolder(3));

    await waitFor(() => expect(lastQuery().shelves).toEqual([3, 9]));
    expect(lastQuery().folderId).toBeUndefined();
    expect(lastQuery().rootOnly).toBeUndefined();
  });

  /**
   * **The list asks for the open shelves; the header and the counts ask for all of them** (spec
   * §4.1–§4.3). A collapsed shelf's cards are never fetched, but its heading still states its
   * figures and the header still counts it — so collapsing `3` takes `3` *and its child* off the
   * list's wire and off neither of the others.
   */
  it("fetches only the open shelves, and counts every one of them", async () => {
    collectionFolderList.mockResolvedValue([folder(3), folder(9, { parentId: 3 }), folder(4)]);
    shelfFolds.mockResolvedValue({ collection: { "3": true }, wishlist: {} });
    renderHook(() => useCollection(), { wrapper });

    await waitFor(() => expect(lastQuery().shelves).toEqual([UNFILED_SHELF, 4]));
    await waitFor(() => expect(lastSummary().shelves).toEqual([UNFILED_SHELF, 3, 9, 4]));
    await waitFor(() => expect(lastCounts().shelves).toEqual([UNFILED_SHELF, 3, 9, 4]));
  });

  /** Deck groups and Recently removed start shut (spec §3.4): counted, never fetched. */
  it("keeps the app's own folders shut until the reader opens one", async () => {
    collectionFolderList.mockResolvedValue([
      folder(3),
      folder(20, { kind: "deck", deckId: 1, name: "Mono-Red Aggro" }),
      folder(21, { kind: "removed", name: "Recently removed" }),
    ]);
    renderHook(() => useCollection(), { wrapper });

    await waitFor(() => expect(lastSummary().shelves).toEqual([UNFILED_SHELF, 3, 20, 21]));
    expect(lastQuery().shelves).toEqual([UNFILED_SHELF, 3]);
  });

  /**
   * **Review Focus 4 at the hook: a filter suspends collapse, and clearing it restores every
   * fold without writing one.** The stored map is read, never rewritten, so Reset all is the
   * whole of the way back.
   */
  it("fetches a collapsed shelf while a filter is on, and folds it again after Reset all", async () => {
    collectionFolderList.mockResolvedValue([folder(3), folder(9, { parentId: 3 }), folder(4)]);
    shelfFolds.mockResolvedValue({ collection: { "3": true }, wishlist: {} });
    const { result } = renderHook(() => useCollection(), { wrapper });
    await waitFor(() => expect(lastQuery().shelves).toEqual([UNFILED_SHELF, 4]));

    act(() => result.current.toggleFinish("foil"));

    await waitFor(() => expect(lastQuery().shelves).toEqual([UNFILED_SHELF, 3, 9, 4]));
    expect(result.current.filtering).toBe(true);

    act(() => result.current.resetAll());

    await waitFor(() => expect(lastQuery().shelves).toEqual([UNFILED_SHELF, 4]));
    expect(result.current.filtering).toBe(false);
    expect(setShelfFolds).not.toHaveBeenCalled();
  });

  /**
   * **Nothing is asked before the folder census answers.** Built from an empty census the shelves
   * would be Not sorted alone, and a reader who files everything would watch an empty page draw
   * and then fill — the very page this design exists to remove.
   */
  it("waits for the folder census before asking for anything", async () => {
    let answer: (folders: CollectionFolder[]) => void = () => {};
    collectionFolderList.mockReturnValue(
      new Promise<CollectionFolder[]>((resolve) => {
        answer = resolve;
      }),
    );
    renderHook(() => useCollection(), { wrapper });
    await waitFor(() => expect(collectionFolderList).toHaveBeenCalled());
    expect(collectionList).not.toHaveBeenCalled();
    expect(collectionSummary).not.toHaveBeenCalled();
    expect(collectionShelfCounts).not.toHaveBeenCalled();

    await act(async () => answer([folder(3)]));

    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    expect((collectionList.mock.calls[0][0] as CollectionQuery).shelves).toEqual([
      UNFILED_SHELF,
      3,
    ]);
  });

  /**
   * Two levels are two lists, and a collapse is a third list **at the same scroll position**:
   * `queryKeyString` moves with the fetched shelves, `scrollKey` — what the wall resets its scroll
   * on — moves only with the level, the filters and the sort, so folding a shelf mid-scroll does
   * not throw the reader back to the top.
   */
  it("keys a level apart, and a collapse into the list but not into the scroll position", async () => {
    collectionFolderList.mockResolvedValue([folder(3), folder(4)]);
    const { result } = renderHook(() => useCollection(), { wrapper });
    await waitFor(() => expect(lastQuery().shelves).toEqual([UNFILED_SHELF, 3, 4]));
    const root = result.current.queryKeyString;
    const scroll = result.current.scrollKey;

    act(() => result.current.setFold(3, true));

    await waitFor(() => expect(lastQuery().shelves).toEqual([UNFILED_SHELF, 4]));
    expect(result.current.queryKeyString).not.toBe(root);
    expect(result.current.scrollKey).toBe(scroll);

    act(() => result.current.openFolder(3));
    expect(result.current.scrollKey).not.toBe(scroll);

    act(() => result.current.openFolder(null));
    act(() => result.current.setFold(3, null));
    await waitFor(() => expect(result.current.queryKeyString).toBe(root));
  });

  /** Reset all is about the filters: where the reader stands and what they folded are theirs. */
  it("leaves the level and the stored folds alone on Reset all", async () => {
    collectionFolderList.mockResolvedValue([folder(3)]);
    const { result } = renderHook(() => useCollection(), { wrapper });
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    act(() => {
      result.current.setText("bolt");
      result.current.openFolder(3);
    });
    act(() => result.current.resetAll());

    expect(result.current.text).toBe("");
    expect(result.current.folderId).toBe(3);
    expect(setShelfFolds).not.toHaveBeenCalled();
  });

  /**
   * Scryfall's syntax reaches the binder too — the same parse the search page makes, minus the
   * tags, which this surface has no wiring for.
   */
  it("sends the free text and the typed predicates apart", async () => {
    const { result } = renderHook(() => useCollection(), { wrapper });
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    act(() => result.current.setText("bolt cmc>=3"));

    await waitFor(() => expect(lastQuery().predicates).toBeDefined());
    expect(lastQuery().text).toBe("bolt");
    // No `start`/`end`: the spans are the box's business, and on the wire they would make two
    // cache entries out of one search typed at two positions.
    expect(lastQuery().predicates).toEqual([
      { field: "cmc", op: "gte", value: "3", negated: false },
    ]);
    // The header counts over the same rows the list draws, so it gets the same terms.
    expect(lastSummary().predicates).toEqual(lastQuery().predicates);
  });

  /**
   * **A tag typed here folds back into the free text rather than being dropped.**
   *
   * This surface resolves no tag names — no `tag_resolve` behind it, no chip row in front of it
   * — so a parsed tag token has nowhere to go. Dropped, `atag:dragon` would be a term the
   * reader typed that narrowed *nothing*, which silently **widens** the search: the one
   * direction a search must never fail in, and the failure a reader cannot see. Folded, they
   * get a name-and-rules search for the word instead — narrower in kind than they asked for,
   * never wider in extent.
   */
  it("folds a tag term back into the free text instead of dropping it", async () => {
    const { result } = renderHook(() => useCollection(), { wrapper });
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    act(() => result.current.setText("atag:dragon"));

    await waitFor(() => expect(lastQuery().text).toBe("dragon"));
    // Not a tag filter either — this hook sends none, which is what makes the fold necessary
    // rather than belt-and-braces.
    expect(lastQuery().artTags).toBeUndefined();
    expect(lastQuery().oracleTags).toBeUndefined();
  });

  /** A box with no syntax in it sends exactly the payload it always did: an empty `predicates`
   *  would be a payload lying about intent and a second cache key for one search. */
  it("sends no predicates field for a plain search", async () => {
    const { result } = renderHook(() => useCollection(), { wrapper });
    await waitFor(() => expect(collectionList).toHaveBeenCalled());

    act(() => result.current.setText("bolt"));

    await waitFor(() => expect(lastQuery().text).toBe("bolt"));
    expect(lastQuery().predicates).toBeUndefined();
  });
});
