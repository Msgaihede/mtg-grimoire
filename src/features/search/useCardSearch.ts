import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { ipc, type SearchResponse, type SearchSortKey } from "@/lib/ipc";
import { MANA_KEYS, type ManaKey } from "@/lib/mana";
import type { Currency } from "@/lib/marketplace";
import { applySort, type SortDir, type SortSpec } from "@/lib/sort";
import { useMarketplace } from "@/lib/useMarketplace";
import { useCardFacets, type FacetRequest } from "./useCardFacets";

/** Rows per request. The backend clamps at 200; 50 is one screenful plus slack. */
export const PAGE_SIZE = 50;

/** How long the search box stays quiet before a keystroke becomes a query. */
export const DEBOUNCE_MS = 300;

/** The `legalities` keys the format picker offers, in the order players rank them. */
export const FORMATS = [
  { value: "standard", label: "Standard" },
  { value: "pioneer", label: "Pioneer" },
  { value: "modern", label: "Modern" },
  { value: "legacy", label: "Legacy" },
  { value: "vintage", label: "Vintage" },
  { value: "pauper", label: "Pauper" },
  { value: "commander", label: "Commander" },
] as const;

/**
 * Which direction one press on each column asks for first.
 *
 * Descending on price, because "highest first" is what clicking a money column means, and
 * ascending on everything that reads as a list. The table's own columns carry this too, as
 * documentation; this table is the one that runs, because the state lives here with the
 * query. Keep the two in step.
 */
const SEARCH_FIRST_DIR: Record<SearchSortKey, SortDir> = {
  name: "asc",
  set: "asc",
  type: "asc",
  rarity: "asc",
  price: "desc",
};

/**
 * The filter's colours are the interface's mana symbols — the same six letters in the same
 * order, and `colorParam` depends on that order to make "U then W" and "W then U" the same
 * query key. This module used to declare its own copy; an alias is what is left, because
 * two lists that must stay identical will not.
 */
export type ColorKey = ManaKey;

// `MANA_VALUES` moved to `@/components/FilterChips`, with the chips that draw it. It is not
// re-exported from here: the one importer moved with it, and a pass-through nobody imports
// is a second name for one thing that only exists to be found by a search.

/** Add or remove one value. The order values were picked in is not information. */
export function toggleIn<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/**
 * Move a three-state filter on one press: off → the caller's question → its opposite → off.
 *
 * One chip and not two, because the two questions are opposites of each other rather than
 * two independent switches — "owned" and "missing" cannot both be on, and a pair of chips
 * that can be would offer a combination meaning nothing. `first` is which of them the press
 * lands on, because it is not the same question in both views that use this: a search asks
 * "what have I already got", a shopping list asks "what am I still missing".
 *
 * The chip's *label* is what says which state is on — an unpressed chip cannot mean "not
 * owned" and also be the same chip that means it when pressed.
 */
export function cycleTriState(current: boolean | undefined, first: boolean): boolean | undefined {
  if (current === undefined) return first;
  return current === first ? !first : undefined;
}

/** Everything {@link activeFilterCount} counts — every filter the search view offers. */
export interface FilterState {
  text: string;
  format: string;
  colors: readonly string[];
  sets: readonly string[];
  manaValues: readonly number[];
  /** `false` is a filter too — "the cards I do *not* have" — so this is compared against
   *  `undefined` rather than tested for truthiness. */
  owned: boolean | undefined;
}

/**
 * How many *kinds* of filter are on.
 *
 * Kinds, not values: this number captions a Reset all button, and its job is to tell the
 * reader how much is about to change. Three colours in one chip row is one thing that is
 * on, not three.
 */
export function activeFilterCount(f: FilterState): number {
  return [
    f.text.trim().length > 0,
    f.format.length > 0,
    f.colors.length > 0,
    f.sets.length > 0,
    f.manaValues.length > 0,
    f.owned !== undefined,
  ].filter(Boolean).length;
}

/**
 * The picked colours as the backend spells them — `"WU"`, `"C"`, or nothing.
 *
 * Always WUBRG order, so `U` then `W` and `W` then `U` produce the same string and
 * therefore the same query key: picking the same two colours in the other order must not
 * cost a second round trip.
 */
export function colorParam(picked: readonly ColorKey[]): string | undefined {
  if (picked.length === 0) return undefined;
  return MANA_KEYS.filter((c) => picked.includes(c)).join("");
}

/**
 * Add or remove one colour.
 *
 * `C` is exclusive both ways. The backend reads a `colors` of exactly `"C"` as
 * colourless-only and anything else as subset-of-these-letters — and subset semantics
 * already include colourless cards. So `"WC"` would not mean "white or colourless", it
 * would mean plain `"W"`, and a button that silently does nothing is worse than one that
 * clears the others.
 */
export function toggleColor(picked: readonly ColorKey[], key: ColorKey): ColorKey[] {
  if (picked.includes(key)) return picked.filter((c) => c !== key);
  if (key === "C") return ["C"];
  return [...picked.filter((c) => c !== "C"), key];
}

/**
 * The currency a money sort has to cross the wire with — or `undefined`, when none does.
 *
 * **The one place the selected marketplace reaches the backend.** Every other price decision
 * in this app is made on this side, off the twin columns Rust returns on every row, so a
 * marketplace switch is a re-render rather than a refetch (`useMarketplace`'s doc is the
 * promise this keeps). Ordering is the exception: `ORDER BY` runs inside SQLite, and a Price
 * column sorted by dollars while printing euros is a column that lies about its own arrow.
 *
 * So it is sent **only while a money column is actually deciding the order**, and it is part
 * of the query key on exactly the same condition. That is what keeps the promise intact for
 * the common case: a name-ordered list is byte-for-byte the payload it always was and is
 * never refetched on a switch, while a price-ordered one is re-asked — which it must be,
 * because the answer genuinely differs.
 *
 * Every term is checked, not just the first: a secondary money key breaks the ties, and ties
 * broken in the wrong currency are rows in the wrong places.
 */
export function sortCurrency<K extends string>(
  sort: SortSpec<K>,
  moneyKeys: readonly K[],
  currency: Currency,
): Currency | undefined {
  const money = moneyKeys as readonly string[];
  return sort.some((term) => money.includes(term.key)) ? currency : undefined;
}

/**
 * The offset for the page after these, or `undefined` when there is nothing left.
 *
 * Counts the rows actually delivered rather than multiplying a page number by `PAGE_SIZE`.
 * The two agree only while every page comes back full, and one need not: a sync swapping
 * the `cards` table between two requests changes what the offsets address, so a page can
 * arrive short of what was asked for. A computed offset would then point past rows that
 * were never delivered, and the reader would never see them.
 *
 * `total` is only an end when the backend counted to it. A capped total means "5 000 or
 * more", and stopping there would cut a 116 k-card browse off at the five-thousandth row
 * — so when it is capped, the short page is the only signal that the data ran out.
 */
export function nextOffset(pages: readonly SearchResponse[]): number | undefined {
  const last = pages[pages.length - 1];
  if (!last) return undefined;
  const seen = pages.reduce((n, p) => n + p.items.length, 0);
  // A short page is the end of the data whatever `total` says. The two can disagree — a
  // sync swapping the table between two requests is enough — and believing `total` alone
  // would refetch the same empty page forever.
  if (last.items.length === 0) return undefined;
  if (!last.totalIsCapped && seen >= last.total) return undefined;
  return seen;
}

/**
 * Whether the reader is deep enough into the loaded rows to want the next page.
 *
 * `lastRenderedIndex` is the bottom of the virtualiser's window, so the next page starts
 * downloading while roughly a fifth of the current one is still ahead of the scrollbar.
 */
export function needsNextPage(lastRenderedIndex: number, loadedCount: number): boolean {
  if (loadedCount === 0) return false;
  return lastRenderedIndex >= loadedCount * 0.8 - 1;
}

/**
 * Filter state, the debounce, and the paged query behind the search view.
 *
 * The query is never disabled: an empty box with no filters is a browse of the whole
 * database sorted by name, which is what a card app should open on, and it is also the
 * one request whose empty answer proves the database itself is empty (see `unfiltered`).
 */
export function useCardSearch() {
  // Which marketplace's prices this list is quoting. Only its **currency** is read, and only
  // for the sort — the Price cell reads the twin field the row already carries.
  const { marketplace } = useMarketplace();
  const [text, setText] = useState("");
  const [format, setFormat] = useState("");
  const [colors, setColors] = useState<readonly ColorKey[]>([]);
  const [sets, setSets] = useState<readonly string[]>([]);
  const [manaValues, setManaValues] = useState<readonly number[]>([]);
  const [owned, setOwned] = useState<boolean | undefined>(undefined);
  // Not a filter, and deliberately outside `resetAll`: clearing what you are looking at
  // should not also throw away the order you chose to read it in.
  const [sort, setSort] = useState<SortSpec<SearchSortKey>>([]);
  // A **view mode**, and outside `resetAll` for the same reason the sort is: clearing what
  // you are looking at should not also change *how* you are looking at it.
  //
  // Off is one row per card — 37 553 cards rather than 107 337 printings — because "which
  // cards exist" is the question a search box is asked, and "which printings exist" is the
  // question the card detail pane answers.
  const [allPrintings, setAllPrintings] = useState(false);
  const [debouncedText, setDebouncedText] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedText(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const colorsParam = colorParam(colors);
  // Sorted before they reach the key: picking two sets in either order is the same search
  // and must not cost a second round trip.
  const setsParam = sets.length > 0 ? [...sets].sort() : undefined;
  const manaParam = manaValues.length > 0 ? [...manaValues].sort((a, b) => a - b) : undefined;
  // `undefined` unless the Price header is deciding the order — see {@link sortCurrency}.
  const currencyParam = sortCurrency(sort, ["price"], marketplace.currency);

  // Every input the request is built from, so a changed filter can never be answered by
  // another filter's cached pages.
  const queryKey = [
    "cards",
    "search",
    debouncedText,
    format,
    colorsParam ?? "",
    setsParam?.join(",") ?? "",
    manaParam?.join(",") ?? "",
    // Three states in one segment, spelled rather than stringified: `String(undefined)` and
    // `String(false)` are both truthy strings, and a key that cannot tell "off" from "the
    // ones I do not own" answers one with the other's cached pages.
    owned === undefined ? "" : owned ? "owned" : "missing",
    // The whole sort in one segment: a differently-ordered page is a different answer, and
    // must not be served from the cached pages of the order before it.
    sort.map((t) => `${t.key}:${t.dir}`).join(","),
    // Spelled rather than stringified, for the reason `owned` is: these are different
    // *rows*, not a different order over the same rows, so the two modes must never answer
    // each other from cache.
    allPrintings ? "all" : "collapsed",
    // Empty on every search that is not price-ordered, which is what keeps a marketplace
    // switch off the wire: the key is unchanged, so the cached pages stand and the Price
    // cells simply read the other twin field. Present — and therefore a different question —
    // exactly when the backend was asked to order by money.
    currencyParam ?? "",
  ];

  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) =>
      ipc.searchCards({
        // Blank strings are dropped rather than sent: the backend treats them as unset
        // anyway, and sending them would make the request payload lie about intent.
        text: debouncedText || undefined,
        format: format || undefined,
        colors: colorsParam,
        sets: setsParam,
        manaValues: manaParam,
        // Sent only when it is set, so an untouched filter row produces exactly the payload
        // it always did. `false` is meaningful here and `undefined` is not sent at all.
        owned,
        // Absent rather than `[]` when nothing is sorted, so an untouched table produces
        // exactly the payload it always did.
        sort: sort.length > 0 ? sort : undefined,
        // Absent unless a money column is deciding the order — the backend defaults to
        // `usd`, which is what every non-price sort has always been answered with.
        currency: currencyParam,
        // Absent rather than `false` when all printings are asked for: uncollapsed is the
        // backend's own default, and sending it would make the payload lie about intent —
        // the same rule `paperOnly` follows below.
        collapse: allPrintings ? undefined : true,
        // `paperOnly` is deliberately absent — omitted means true, which is the default
        // this view wants. Sending `true` explicitly would be the same request with more
        // ways to get it wrong.
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (_last, pages) => nextOffset(pages),
    // Filter changes keep the old rows on screen until the new ones land, so a search
    // that has to wait out an ingest's database lock does not blank the list first.
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);

  /**
   * The same filters the page above is built from, and nothing else.
   *
   * Written out rather than derived from the query's own payload, because the two differ in
   * exactly the way that matters: the page carries a sort, an offset and a collapse, and a
   * facet answer depends on none of the three. {@link FacetRequest} is the fence — it cannot
   * hold them — and this object is what has to stay in step with the payload above it.
   */
  const facetReq: FacetRequest = {
    text: debouncedText || undefined,
    format: format || undefined,
    colors: colorsParam,
    sets: setsParam,
    manaValues: manaParam,
    owned,
  };
  const facets = useCardFacets(facetReq);

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
    /**
     * `true` narrows to printings the collection has an entry for, `false` to those it does
     * not, `undefined` asks nothing. **An entry, not a copy**: a row emptied to zero passes
     * `true` while its badge reads `×0` (see `SearchRequest.owned`).
     */
    owned,
    /** Off → owned → missing → off. The search asks "what have I already got" first. */
    toggleOwned: () => setOwned((current) => cycleTriState(current, true)),
    /**
     * Show every printing rather than one row per card.
     *
     * `false` — one row per card — is the default. A view mode and not a filter, so it is
     * absent from {@link activeFilterCount} and survives `resetAll`.
     */
    allPrintings,
    toggleAllPrintings: () => setAllPrintings((on) => !on),
    /** How many kinds of filter are on — the number on the Reset all badge. */
    activeCount: activeFilterCount({ text, format, colors, sets, manaValues, owned }),
    /**
     * The columns this list is ordered by, first one deciding. Empty is the view's own
     * default: relevance when there is a query, name order when there is not.
     */
    sort,
    /** One press on a column header. `additive` is Shift being held. */
    toggleSort: (key: string, additive: boolean) =>
      setSort((spec) =>
        applySort(spec, key as SearchSortKey, {
          additive,
          firstDir: SEARCH_FIRST_DIR[key as SearchSortKey] ?? "asc",
        }),
      ),
    /** Clear every filter at once, including the search box. */
    resetAll: () => {
      setText("");
      setFormat("");
      setColors([]);
      setSets([]);
      setManaValues([]);
      setOwned(undefined);
    },
    /**
     * The marketplace every price on this view is quoted from — its label for the as-of
     * sentence, its currency for the formatter and for the fields a row is read by.
     *
     * Handed on rather than read again in the view: it is already here for the sort, and one
     * source means a header that names TCGplayer and a cell that prints euros cannot happen.
     */
    marketplace,
    query,
    rows,
    /**
     * How many printings each filter option would leave, for the row that draws them —
     * `undefined` whenever that is not known, which is what every control reads as "leave
     * this live". See `useCardFacets`, which owns that collapse, and `facets.ts`, which owns
     * the rule the controls apply to it.
     *
     * **`facets.total` is not {@link total}.** This one counts printings and is exact; that
     * one counts the rows the list will draw (collapsed to one per card) and stops at 5 000.
     * Only the former is what a colour count is read against.
     */
    facets,
    /**
     * Identity of the current search, for anything that has to react to "this is a
     * different search now" — resetting the scroll position, above all. Derived from the
     * query key itself rather than rebuilt from the same fields, so the two cannot drift.
     * Serialised rather than joined: the text half is whatever the user typed, and a
     * separator a user can type is a separator that can collide.
     */
    searchKey: JSON.stringify(queryKey),
    /** Size of the whole match set, not of `rows`. `0` until the first page answers. */
    total: query.data?.pages[0]?.total ?? 0,
    /** `total` is a floor, not a figure: render it as `5,000+`. */
    totalIsCapped: query.data?.pages[0]?.totalIsCapped ?? false,
    /**
     * Nothing was asked of the database at all. An empty answer to *this* is an empty
     * database, not a search that missed — the difference between "wait for the sync"
     * and "try another word".
     */
    unfiltered:
      !debouncedText && !format && !colorsParam && !setsParam && !manaParam && owned === undefined,
  };
}

/** The whole of what `FilterBar` consumes — named so the component and its test agree. */
export type CardSearch = ReturnType<typeof useCardSearch>;
