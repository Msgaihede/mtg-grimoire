import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  colorParam,
  cycleTriState,
  DEBOUNCE_MS,
  toggleColor,
  toggleIn,
  type ColorKey,
} from "@/features/search/useCardSearch";
import { CONDITIONS, type Condition } from "@/lib/conditions";
import { FINISHES, type Finish } from "@/lib/finish";
import { ipc, type CollectionQuery, type CollectionSortKey } from "@/lib/ipc";
import { applySort, type SortDir, type SortSpec } from "@/lib/sort";

/**
 * Rows per request. The backend clamps at 500 and defaults to this; a collection is
 * thousands of rows rather than the search's 116 k, so the page is twice the search's.
 */
export const COLLECTION_PAGE_SIZE = 100;

/** The sort key the backend understands. Re-exported so call sites keep one import. */
export type CollectionSort = CollectionSortKey;

/**
 * The orders the filter bar's select offers, in the order a reader reaches for them.
 *
 * Named for what they answer rather than for the column they touch: "Recently added" is
 * what a reader means by `added`, and `quantity` is asked as "which do I have most of".
 *
 * Four of them have a header to press as well, and this list is the shortcut to them. Two
 * do not, which is the whole reason the select survived the table's headers becoming
 * sortable: **"Recently added" has no column** — neither table can afford one, this one
 * having already dropped a column at 1280px with the card pane open — and **"Highest
 * price" is the unit price**, which is the Value column's *other* question. The Value
 * header sorts by unit × copies, because that is the figure the cell prints.
 */
export const COLLECTION_SORTS = [
  { value: "name", label: "Name" },
  { value: "set", label: "Set and number" },
  { value: "added", label: "Recently added" },
  { value: "quantity", label: "Most copies" },
  { value: "price", label: "Highest price" },
] as const satisfies readonly { value: CollectionSort; label: string }[];

/**
 * Which direction one press on each column asks for first.
 *
 * Descending on the money and count columns, because "highest first" is what pressing one
 * of those means, and on `added` because "recently added" is what the select calls it.
 */
const COLLECTION_FIRST_DIR: Record<CollectionSortKey, SortDir> = {
  name: "asc",
  set: "asc",
  finish: "asc",
  quantity: "desc",
  value: "desc",
  price: "desc",
  added: "desc",
};

/** Everything {@link activeFilterCount} counts — every filter the collection view offers. */
export interface CollectionFilterState {
  text: string;
  format: string;
  colors: readonly string[];
  sets: readonly string[];
  manaValues: readonly number[];
  finishes: readonly Finish[];
  conditions: readonly Condition[];
  /** `true` is the rows a sync flagged, `false` everything it did not touch. Three-way like
   *  the wishlist's twin, because the complement is a real question. */
  needsReview: boolean | undefined;
}

/**
 * How many *kinds* of filter are on.
 *
 * The same rule as the search's, over a longer row: kinds, not values, because this number
 * captions a Reset all button and its job is to say how much is about to change. The three
 * extra kinds are the ones only a collection can ask — what the copy is, what state it is
 * in, and whether a sync left a question against it.
 */
export function activeFilterCount(f: CollectionFilterState): number {
  return [
    f.text.trim().length > 0,
    f.format.length > 0,
    f.colors.length > 0,
    f.sets.length > 0,
    f.manaValues.length > 0,
    f.finishes.length > 0,
    f.conditions.length > 0,
    // Compared against `undefined`, never tested for truthiness: `false` — "the rows nothing
    // flagged" — is a filter that is on, and is where the reader lands once the flagged ones
    // are dealt with.
    f.needsReview !== undefined,
  ].filter(Boolean).length;
}

/** A page of a list whose total was counted in full — a collection, or a wishlist. */
interface CountedPage {
  items: readonly unknown[];
  total: number;
}

/**
 * The offset for the page after these, or `undefined` when there is nothing left.
 *
 * A collection total is counted in full — there is no capped-count case to page past, which
 * is the one thing that makes this shorter than the search's twin. A short page still ends
 * the list whatever the count says: a write landing between two requests moves what the
 * offsets address, and believing `total` alone would refetch the same empty page forever.
 *
 * Structural in its argument because the wishlist's pager is the same pager over the same
 * guarantee: `wishlist_list` counts in full too, and a second copy of this reasoning is a
 * second place for the short-page rule to be forgotten.
 */
export function nextOffset(pages: readonly CountedPage[]): number | undefined {
  const last = pages[pages.length - 1];
  if (!last || last.items.length === 0) return undefined;
  const seen = pages.reduce((n, p) => n + p.items.length, 0);
  return seen >= last.total ? undefined : seen;
}

/**
 * Filter state, the debounce, and the two queries behind the collection view.
 *
 * The same shape as `useCardSearch` — one key built from every input, `keepPreviousData` so
 * a refined filter does not blank the table — with the collection's own three filters and a
 * sort on top, and one addition of substance: the aggregate header is a **second query over
 * the same filters**, not a field of the page. A header that describes a different set of
 * rows than the table under it is worse than no header, and recomputing nine aggregates on
 * every scrolled page would be worse still.
 */
export function useCollection() {
  const [text, setText] = useState("");
  const [format, setFormat] = useState("");
  const [colors, setColors] = useState<readonly ColorKey[]>([]);
  const [sets, setSets] = useState<readonly string[]>([]);
  const [manaValues, setManaValues] = useState<readonly number[]>([]);
  const [finishes, setFinishes] = useState<readonly Finish[]>([]);
  const [conditions, setConditions] = useState<readonly Condition[]>([]);
  const [needsReview, setNeedsReview] = useState<boolean | undefined>(undefined);
  // Empty is name order — the view's own default, which is what a cleared sort falls back
  // to. Not a filter, so `resetAll` leaves it alone.
  const [sort, setSort] = useState<SortSpec<CollectionSortKey>>([]);
  const [debouncedText, setDebouncedText] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedText(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const colorsParam = colorParam(colors);
  // Every multi-select is canonicalised before it reaches the key: picking two finishes in
  // either order is the same set of rows and must not cost a second round trip. Ordered by
  // the app's own vocabulary rather than alphabetically, so the request reads the way the
  // chips do.
  const setsParam = sets.length > 0 ? [...sets].sort() : undefined;
  const manaParam = manaValues.length > 0 ? [...manaValues].sort((a, b) => a - b) : undefined;
  const finishParam =
    finishes.length > 0 ? FINISHES.filter((f) => finishes.includes(f)) : undefined;
  const conditionParam =
    conditions.length > 0 ? CONDITIONS.filter((c) => conditions.includes(c)) : undefined;

  const filters: Omit<CollectionQuery, "limit" | "offset" | "sort"> = {
    // Blank strings are dropped rather than sent: the backend reads them as unset anyway,
    // and sending them would make the payload lie about intent.
    text: debouncedText || undefined,
    format: format || undefined,
    colors: colorsParam,
    sets: setsParam,
    manaValues: manaParam,
    finishes: finishParam,
    conditions: conditionParam,
    // Sent only when it is set — and `false`, "everything the sync did not touch", is
    // meaningful on the wire and is sent as `false`. `collection::scope` has always matched
    // three ways over this; dropping the complement the way a blank string is dropped would
    // silently turn it back into "ask nothing".
    needsReview,
    // `paperOnly` is deliberately absent: the collection forces it off. A paper test over a
    // printing that has left `cards` would throw away exactly the rows this list exists to
    // keep showing.
  };

  /**
   * Which rows are being asked for — and nothing about what order they come back in.
   *
   * The summary is keyed on this alone: it is a statement about a *set* of rows, and an
   * order is not part of a set, so re-sorting the table must not re-run nine aggregates
   * over the same collection.
   */
  const filterKey = [
    debouncedText,
    format,
    colorsParam ?? "",
    setsParam?.join(",") ?? "",
    manaParam?.join(",") ?? "",
    finishParam?.join(",") ?? "",
    conditionParam?.join(",") ?? "",
    // Three terms, not two: the flagged rows and the rows nothing flagged are two different
    // sets, so a key that spelled both `""` would serve the complement from the other's cache.
    needsReview === undefined ? "" : needsReview ? "review" : "clear",
  ];

  // `["collection", …]` on both, so the one `invalidateQueries({ queryKey: ["collection"] })`
  // every write in the app already fires refreshes the table and the header together.
  const sortKey = sort.map((t) => `${t.key}:${t.dir}`).join(",");
  const listKey = ["collection", "list", filterKey, sortKey];

  const query = useInfiniteQuery({
    queryKey: listKey,
    queryFn: ({ pageParam }) =>
      ipc.collectionList({
        ...filters,
        // Absent rather than `[]` when nothing is sorted, so an untouched table produces
        // exactly the payload it always did.
        sort: sort.length > 0 ? sort : undefined,
        limit: COLLECTION_PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (_last, pages) => nextOffset(pages),
    placeholderData: keepPreviousData,
  });

  const summary = useQuery({
    queryKey: ["collection", "summary", filterKey],
    queryFn: () => ipc.collectionSummary({ ...filters, limit: 0, offset: 0 }),
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);

  return {
    text,
    setText,
    format,
    setFormat,
    colors,
    toggleColor: (key: ColorKey) => setColors((picked) => toggleColor(picked, key)),
    sets,
    toggleSet: (code: string) => setSets((picked) => toggleIn(picked, code)),
    manaValues,
    toggleManaValue: (value: number) => setManaValues((picked) => toggleIn(picked, value)),
    finishes,
    toggleFinish: (finish: Finish) => setFinishes((picked) => toggleIn(picked, finish)),
    conditions,
    toggleCondition: (condition: Condition) =>
      setConditions((picked) => toggleIn(picked, condition)),
    /**
     * `true` narrows to the rows a Scryfall migration or a vanished printing flagged,
     * `false` to those it did not, `undefined` asks nothing.
     */
    needsReview,
    /** Off → flagged → not flagged → off. The flagged ones first: that is the only reason
     *  anybody presses this, and the complement is where you go once they are dealt with. */
    toggleNeedsReview: () => setNeedsReview((current) => cycleTriState(current, true)),
    /** The banner's "Show them", which has a destination rather than a next state — it is
     *  offering the flagged rows, not cycling the chip the reader has not touched. */
    setNeedsReview,
    /** The columns this list is ordered by, first one deciding. Empty is name order. */
    sort,
    /** One press on a column header. `additive` is Shift being held. */
    toggleSort: (key: string, additive: boolean) =>
      setSort((spec) =>
        applySort(spec, key as CollectionSortKey, {
          additive,
          firstDir: COLLECTION_FIRST_DIR[key as CollectionSortKey] ?? "asc",
        }),
      ),
    /** The filter bar's select: one term, replacing whatever was there. */
    setSortKey: (key: CollectionSortKey) => setSort([{ key, dir: COLLECTION_FIRST_DIR[key] }]),
    /**
     * What the select shows.
     *
     * The sort's *first* term when the select offers it, and `""` — drawn as `Custom…` —
     * when the sort starts from a column the select has no option for, which is the Value
     * and Finish headers. Read off the first term rather than requiring a single one,
     * because "sorted primarily by Name" is true of a two-key sort and is what a reader
     * glancing at the control wants to know. An empty spec reads as the default it is.
     */
    sortSelection: (sort.length === 0
      ? "name"
      : COLLECTION_SORTS.some((s) => s.value === sort[0].key)
        ? sort[0].key
        : "") as CollectionSortKey | "",
    /** How many kinds of filter are on — the number on the Reset all badge. */
    activeCount: activeFilterCount({
      text,
      format,
      colors,
      sets,
      manaValues,
      finishes,
      conditions,
      needsReview,
    }),
    /** Clear every filter at once, including the search box. The sort is not a filter and
     *  stays: it is how the reader reads, not what they are looking at. */
    resetAll: () => {
      setText("");
      setFormat("");
      setColors([]);
      setSets([]);
      setManaValues([]);
      setFinishes([]);
      setConditions([]);
      setNeedsReview(undefined);
    },
    query,
    summary,
    rows,
    /** Rows matching the filters, counted in full. `0` until the first page answers. */
    total: query.data?.pages[0]?.total ?? 0,
    /**
     * Identity of the current list, for anything that has to react to "this is a different
     * list now" — the scroll reset, above all. Derived from the query key itself rather
     * than rebuilt from the same fields, so the two cannot drift.
     */
    queryKeyString: JSON.stringify(listKey),
  };
}

/** The whole of what the view and its filter bar consume, named so the two agree. */
export type Collection = ReturnType<typeof useCollection>;
