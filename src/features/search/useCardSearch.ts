import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { ipc, type SearchResponse } from "@/lib/ipc";
import { MANA_KEYS, type ManaKey } from "@/lib/mana";

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

// The filter's colours and the interface's mana symbols are the same six letters in the
// same order, and `colorParam` depends on that order to make "U then W" and "W then U"
// the same query key. One definition, re-exported under the name the filter code uses:
// two lists that must stay identical will not.
export { MANA_KEYS as COLOR_KEYS, MANA_LABEL as COLOR_LABEL } from "@/lib/mana";
export type ColorKey = ManaKey;

/** The mana-value chips. The last one is open-ended — `8` means "8 or more". */
export const MANA_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;

/** Add or remove one value. The order values were picked in is not information. */
export function toggleIn<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** Everything {@link activeFilterCount} counts — every filter the search view offers. */
export interface FilterState {
  text: string;
  format: string;
  colors: readonly string[];
  sets: readonly string[];
  manaValues: readonly number[];
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
  const [text, setText] = useState("");
  const [format, setFormat] = useState("");
  const [colors, setColors] = useState<readonly ColorKey[]>([]);
  const [sets, setSets] = useState<readonly string[]>([]);
  const [manaValues, setManaValues] = useState<readonly number[]>([]);
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
    /** How many kinds of filter are on — the number on the Reset all badge. */
    activeCount: activeFilterCount({ text, format, colors, sets, manaValues }),
    /** Clear every filter at once, including the search box. */
    resetAll: () => {
      setText("");
      setFormat("");
      setColors([]);
      setSets([]);
      setManaValues([]);
    },
    query,
    rows,
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
    unfiltered: !debouncedText && !format && !colorsParam && !setsParam && !manaParam,
  };
}

/** The whole of what `FilterBar` consumes — named so the component and its test agree. */
export type CardSearch = ReturnType<typeof useCardSearch>;
