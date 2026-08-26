import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { nextOffset } from "@/features/collection/useCollection";
import {
  colorParam,
  cycleTriState,
  DEBOUNCE_MS,
  FORMATS,
  toggleColor,
  toggleIn,
  type ColorKey,
} from "@/features/search/useCardSearch";
import { ipc, type WishlistQuery, type WishlistSortKey } from "@/lib/ipc";
import { sortOptions } from "@/lib/options";
import { applySort, type SortDir, type SortSpec } from "@/lib/sort";
import { useMarketplace } from "@/lib/useMarketplace";

/**
 * Rows per request. The backend clamps at 500 and defaults to this. A wishlist is tens of
 * rows where a collection is thousands, so this is a ceiling nobody meets rather than a page
 * size anybody scrolls past — which is also why the header below can add the list up itself.
 */
export const WISHLIST_PAGE_SIZE = 100;

/** The sort key the backend understands. Re-exported so call sites keep one import. */
export type WishlistSort = WishlistSortKey;

/**
 * The orders the filter bar's select offers.
 *
 * **This array's order is its declaration order and nothing else.** `WishlistPage`'s sort
 * `<select>` draws it alphabetically by label through `sortOptions` (`lib/options.ts`), and
 * the only other reader — `sortSelection` below — asks which keys are *in* it. So
 * reordering these four lines changes nothing on screen; it only breaks the reasoning that
 * follows, which pairs each order with the collection's twin. Add to the end.
 *
 * Four where the collection has five, and one of them means something different: `quantity`
 * is "most wanted" here, not "most copies", because these are cards the reader does not have
 * yet. There is still no `set` order — an any-printing wish has no set to sort by, and a
 * list where half the rows sort under the same blank is not an order. That is also why the
 * **Printing column is the one header on any of these tables that is not sortable**.
 *
 * Two of these have a header to press as well. "Recently added" has no column and cannot
 * afford one, and "Highest price" is the *unit* price — the Cost column's other question,
 * where the header sorts by what finishing the wish still costs.
 */
export const WISHLIST_SORTS = [
  { value: "name", label: "Name" },
  { value: "added", label: "Recently added" },
  { value: "quantity", label: "Most wanted" },
  { value: "price", label: "Highest price" },
] as const satisfies readonly { value: WishlistSort; label: string }[];

/** Which direction one press on each column asks for first. */
const WISHLIST_FIRST_DIR: Record<WishlistSortKey, SortDir> = {
  name: "asc",
  owned: "desc",
  quantity: "desc",
  cost: "desc",
  price: "desc",
  added: "desc",
};

/** Everything {@link activeFilterCount} counts — every filter the wishlist view offers. */
export interface WishlistFilterState {
  text: string;
  format: string;
  colors: readonly string[];
  sets: readonly string[];
  manaValues: readonly number[];
  manaX: boolean;
  rarities: readonly string[];
  /** `false` is a filter too — "the wishes nothing covers" — so this is compared against
   *  `undefined` rather than tested for truthiness. */
  fulfilled: boolean | undefined;
  /** `true` is the wishes a sync flagged, `false` everything it did not touch. Three-way for
   *  the same reason `fulfilled` is: the complement is a real question. */
  needsReview: boolean | undefined;
}

/**
 * How many *kinds* of filter are on — the number on the Reset all badge.
 *
 * Eight, where it was three until 2026-08-26 and the argument for three was about the *screen*
 * rather than the plumbing: a shopping list is read by name, so a row of colour chips over forty
 * rows was chrome that would never be pressed. What overturned it is that the chips are no longer
 * a row — the three card views draw one `FilterBar` now, where everything but the box, the
 * colours and the order lives behind a disclosure. A filter nobody presses costs a shut tray
 * nothing, and a wishlist that answered fewer of its own backend's fields than the collection
 * beside it was the odd page out rather than a smaller control.
 *
 * `WishlistQuery extends CardFilters`, so every one of these was already a field the backend read
 * and this hook simply never sent. Kinds and not values, as both siblings count them.
 */
export function activeFilterCount(f: WishlistFilterState): number {
  return [
    f.text.trim().length > 0,
    f.format.length > 0,
    f.colors.length > 0,
    f.sets.length > 0,
    // One term with the numerals, as both siblings count it: the X chip is the last chip of that
    // same group and is OR'd with them, so "3 and X" is one thing to clear.
    f.manaValues.length > 0 || f.manaX,
    f.rarities.length > 0,
    f.fulfilled !== undefined,
    f.needsReview !== undefined,
  ].filter(Boolean).length;
}

/**
 * Filter state, the debounce, and the paged query behind the wishlist view.
 *
 * `useCollection`'s shape, minus everything a shopping list does not ask: one key built from
 * every input, `keepPreviousData` so a refined filter does not blank the list, and the same
 * short-page pager. There is no summary query — a wishlist fits in one page, so what it adds
 * up to is arithmetic over the rows on screen rather than a second round trip.
 */
export function useWishlist() {
  // Which marketplace this list quotes — an input to the query and part of its key, because
  // it decides what a Cost cell contains and not merely how it is written.
  const { marketplace } = useMarketplace();
  const [text, setText] = useState("");
  // The card filters, drawn since 2026-08-26 and **on the wire the whole time before that**:
  // `WishlistQuery` has extended `CardFilters` since it was written, so every one of these was a
  // field the backend already read and this hook simply never sent. See {@link activeFilterCount}
  // for what changed on screen.
  const [format, setFormat] = useState("");
  const [colors, setColors] = useState<readonly ColorKey[]>([]);
  const [sets, setSets] = useState<readonly string[]>([]);
  const [manaValues, setManaValues] = useState<readonly number[]>([]);
  // Additive rather than exclusive, exactly as both siblings are: `cmc` counts `{X}` as zero, so
  // a `{X}{B}{B}{B}` on the list answers the `3` chip and this one both.
  const [manaX, setManaX] = useState(false);
  const [rarities, setRarities] = useState<readonly string[]>([]);
  const [fulfilled, setFulfilled] = useState<boolean | undefined>(undefined);
  const [needsReview, setNeedsReview] = useState<boolean | undefined>(undefined);
  // Empty is name order — the view's own default, which is what a cleared sort falls back
  // to. Not a filter, so `resetAll` leaves it alone.
  const [sort, setSort] = useState<SortSpec<WishlistSortKey>>([]);
  // Where the reader is standing — `null` is the root wishlist, a real destination and not
  // "nothing chosen yet". Deliberately outside `WishlistFilterState`: it is navigation, not
  // something the reader narrowed, so `activeFilterCount` never sees it and `resetAll` leaves
  // it alone, the same reason `sort` does.
  const [folderId, setFolderId] = useState<number | null>(null);
  // `true` ignores `folderId` and answers every wish wherever it is filed. Also navigation
  // rather than a filter, for the same reason `folderId` is — Flatten is "how much of the
  // tree am I looking at", not "which wishes qualify".
  const [flatten, setFlatten] = useState(false);
  const [debouncedText, setDebouncedText] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedText(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  // Every multi-select is canonicalised before it reaches the key: picking two sets in either
  // order is the same list of rows and must not cost a second round trip.
  const colorsParam = colorParam(colors);
  const setsParam = sets.length > 0 ? [...sets].sort() : undefined;
  const manaParam = manaValues.length > 0 ? [...manaValues].sort((a, b) => a - b) : undefined;
  const raritiesParam = rarities.length > 0 ? [...rarities].sort() : undefined;

  const filters: Omit<WishlistQuery, "limit" | "offset" | "sort"> = {
    // A blank string is dropped rather than sent: the backend reads it as unset anyway, and
    // sending it would make the payload lie about intent.
    text: debouncedText || undefined,
    // The same rule for all five. **`playableOnly` is deliberately never sent beside `format`** —
    // the card search pairs the two (`formatParams`), and that pairing must not travel here: a
    // wish for an art card is a card the reader wants, and a corpus filter would answer their own
    // shopping list with a shorter one. It is also why this surface does not set
    // `FilterSurface.anyCard`: with nothing narrowing the corpus there is nothing for a widening
    // row to put back.
    format: format || undefined,
    colors: colorsParam,
    sets: setsParam,
    manaValues: manaParam,
    // Absent rather than `false`, which is what the backend defaults to. `true` widens — it adds
    // the `{X}` rows to whatever the numerals matched.
    manaX: manaX || undefined,
    rarities: raritiesParam,
    // Sent only when it is set. `false` — "what is still missing" — is the list's usual
    // question and is meaningful on the wire; `undefined` is not sent at all.
    fulfilled,
    // Same rule: `false` — "everything the sync did not touch" — is meaningful on the wire,
    // and `undefined` is not sent at all.
    needsReview,
    // `paperOnly` is deliberately absent: the wishlist forces it off, exactly as the
    // collection does. A paper test over a printing that has left `cards` would throw away
    // the rows this list exists to keep showing.
    //
    // The marketplace is always sent: it is which prices the list is quoting rather than a
    // refinement that can be left off, and the backend's default happens to be one of the
    // five rather than "no opinion".
    marketplace: marketplace.id,
    // Sent only when the reader is actually inside a folder. The root is `#[serde(default)]`
    // on the other end, so an omitted field already reads as "the root" — sending `null`
    // there would say the same thing over the wire, but this keeps the same rule `text`
    // follows: a value the backend would infer anyway is dropped rather than spelled out.
    folderId: folderId ?? undefined,
    // Sent only when `true`. The backend's default is `false`, and sending it on every
    // request would make the payload lie about intent — the rule the file already applies to
    // `text`, `fulfilled` and `needsReview`.
    flatten: flatten || undefined,
  };

  // `["wishlist", …]`, so the one `invalidateQueries({ queryKey: ["wishlist"] })` that every
  // collection write in the app already fires refreshes this list too — a wish's
  // `ownedQuantity` is computed from `collection_entries`, so a stepper press two views away
  // has just changed what this list says.
  const listKey = [
    "wishlist",
    "list",
    debouncedText,
    // Every segment is a **string**, and the normalised one where there is a normal form: a key
    // holding an array compares by structure, so `["W","U"]` and `["U","W"]` would be two entries
    // for one answer. The four params above have already put each in order.
    format,
    colorsParam ?? "",
    setsParam?.join(",") ?? "",
    manaParam?.join(",") ?? "",
    // Its own segment, and load-bearing: X is a second axis over the same chips, so a key built
    // from the numerals alone would serve "3, and also X" out of the pages cached for plain "3".
    manaX ? "x" : "",
    raritiesParam?.join(",") ?? "",
    fulfilled === undefined ? "" : fulfilled ? "fulfilled" : "missing",
    needsReview === undefined ? "" : needsReview ? "review" : "clear",
    sort.map((t) => `${t.key}:${t.dir}`).join(","),
    // On every order, not only a money one: two marketplaces are two answers to the same
    // wishlist, and neither may be served from the other's cached page.
    marketplace.id,
    // Two folders are two lists, and flattened is a third: each keeps its own cached pages
    // and its own scroll position (`queryKeyString` below is what resets it), rather than one
    // list quietly showing another folder's page while the new one is still in flight.
    folderId === null ? "root" : String(folderId),
    flatten ? "flat" : "",
  ];

  const query = useInfiniteQuery({
    queryKey: listKey,
    queryFn: ({ pageParam }) =>
      ipc.wishlistList({
        ...filters,
        // Absent rather than `[]` when nothing is sorted, so an untouched table produces
        // exactly the payload it always did.
        sort: sort.length > 0 ? sort : undefined,
        limit: WISHLIST_PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (_last, pages) => nextOffset(pages),
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);

  return {
    text,
    setText,
    format,
    setFormat,
    /**
     * The rows the format picker offers — the shared {@link FORMATS} and nothing added to it,
     * `useCollection`'s note verbatim: nothing opens this page pointed at a format, so the picker
     * can never be sitting on a key the list does not hold, and `formatsWithDefault`'s whole job
     * is that seeding. **And no `anyCard`** — see the `format` field on `filters` above.
     */
    formats: FORMATS,
    colors,
    /** `toggleColor` rather than a plain `toggleIn`, so **C excludes the five and the five exclude
     *  C** — colourless is not a sixth colour, and the search's rule is the one to keep. */
    toggleColor: (key: ColorKey) => setColors((picked) => toggleColor(picked, key)),
    sets,
    toggleSet: (code: string) => setSets((picked) => toggleIn(picked, code)),
    manaValues,
    toggleManaValue: (value: number) => setManaValues((picked) => toggleIn(picked, value)),
    /** Also match the wishes whose printed cost contains `{X}` — **additive, never exclusive**,
     *  OR'd with the numeral chips as they are OR'd with each other. */
    manaX,
    toggleManaX: () => setManaX((on) => !on),
    rarities,
    toggleRarity: (rarity: string) => setRarities((picked) => toggleIn(picked, rarity)),
    /**
     * **No facets**, `useCollectionSearch`'s answer and for its reason: `facets.ts` reads
     * `undefined` as "we do not know", which leaves every chip live and nothing greyed. That is
     * the honest state — `wishlist_list` has no facet command behind it the way `search_cards`
     * does, and counting would be a second query per keystroke for numbers beside a list of tens.
     */
    facets: undefined,
    /**
     * `true` shows only the wishes the collection already covers, `false` only those it does
     * not, `undefined` asks nothing. Counted in **copies** and finish-aware: a foil wish is
     * not covered by the nonfoil in the binder.
     */
    fulfilled,
    /** Off → still missing → fulfilled → off. A shopping list asks what is left first. */
    toggleFulfilled: () => setFulfilled((current) => cycleTriState(current, false)),
    /** The same field, set outright. `FilterBar` walks the cycle itself for the chip in its tray
     *  and needs this one to *clear* the kind in a single press — `FilterSurface.needsReview`
     *  carries the argument for both surfaces. */
    setFulfilled,
    /**
     * `true` shows only the wishes a Scryfall migration or a vanished printing flagged,
     * `false` only those it did not, `undefined` asks nothing.
     */
    needsReview,
    /** Off → flagged → not flagged → off. The flagged ones first: that is the only reason
     *  anybody presses this, and the complement is where you go once they are dealt with. */
    toggleNeedsReview: () => setNeedsReview((current) => cycleTriState(current, true)),
    /** The same field, set outright — see {@link setFulfilled} beside it. */
    setNeedsReview,
    /** The columns this list is ordered by, first one deciding. Empty is name order. */
    sort,
    /** One press on a column header. `additive` is Shift being held. */
    toggleSort: (key: string, additive: boolean) =>
      setSort((spec) =>
        applySort(spec, key as WishlistSortKey, {
          additive,
          firstDir: WISHLIST_FIRST_DIR[key as WishlistSortKey] ?? "asc",
        }),
      ),
    /**
     * The filter bar's select: one term, replacing whatever was there.
     *
     * **It takes the `""` its own `Custom…` row carries**, which is a fact about the type rather
     * than about a press: that row is `disabled`, so nothing on screen can send it. The row exists
     * because the select's value has to be one its options carry ({@link sortRows}), and a
     * setter that refused the value the control can *hold* would be a signature that could not be
     * bound to it. It is written out rather than cast away — the empty spec is this list's name
     * order, so the unreachable arm has a right answer and says it.
     */
    setSortKey: (key: WishlistSortKey | "") =>
      setSort(key === "" ? [] : [{ key, dir: WISHLIST_FIRST_DIR[key] }]),
    /** Which way the list runs — **never `undefined`**, `useCollection`'s note and for its reason:
     *  an empty spec is this list's name order rather than a ranking, so it has a direction and
     *  the arrow that turns it is live rather than greyed. */
    sortDir: sort.length === 0 ? WISHLIST_FIRST_DIR.name : sort[0].dir,
    /** Turn the first term over. An empty spec is written out rather than left alone, so the press
     *  materialises the order the list was already in, reversed — see `useCollection`'s twin. */
    flipSortDir: () =>
      setSort((spec) =>
        spec.length === 0
          ? [{ key: "name", dir: WISHLIST_FIRST_DIR.name === "asc" ? "desc" : "asc" }]
          : spec.map((term, at) =>
              at === 0 ? { key: term.key, dir: term.dir === "asc" ? "desc" : "asc" } : term,
            ),
      ),
    /**
     * What the select shows — the sort's *first* term when the select offers it, and `""`,
     * drawn as `Custom…`, when the sort starts from a column it has no option for. See
     * `useCollection`'s, which is the same rule for the same reason.
     */
    sortSelection: (sort.length === 0
      ? "name"
      : WISHLIST_SORTS.some((s) => s.value === sort[0].key)
        ? sort[0].key
        : "") as WishlistSortKey | "",
    /**
     * The rows that select draws, including the `Custom…` the sort can only be *put* into — see
     * `useCollection.sortRows`, which is this rule and its whole argument. The Owned and Cost
     * headers are the two keys this select has no option for.
     */
    sortRows: [
      ...(sort.length > 0 && !WISHLIST_SORTS.some((s) => s.value === sort[0].key)
        ? ([{ value: "", label: "Custom…", disabled: true }] as const)
        : []),
      ...sortOptions(WISHLIST_SORTS, (s) => s.label),
    ] as readonly { value: WishlistSortKey | ""; label: string; disabled?: boolean }[],
    activeCount: activeFilterCount({
      text,
      format,
      colors,
      sets,
      manaValues,
      manaX,
      rarities,
      fulfilled,
      needsReview,
    }),
    /** Clear every filter at once. The sort is not a filter and stays: it is how the reader
     *  reads, not what they are looking at. `folderId` and `flatten` stay for the same
     *  reason: where the reader is standing, and whether they are ignoring the filing, are
     *  navigation rather than something they narrowed, so clearing a search must not also
     *  march them back to the root or drop them out of Flatten. */
    resetAll: () => {
      setText("");
      setFormat("");
      setColors([]);
      setSets([]);
      setManaValues([]);
      setManaX(false);
      setRarities([]);
      setFulfilled(undefined);
      setNeedsReview(undefined);
    },
    /** Which folder the reader is standing in. `null` is the root wishlist — a real
     *  destination, the same folder every unfiled wish lands in — and not "no folder chosen".
     *  Navigation, not a filter: excluded from {@link WishlistFilterState} on purpose, so it
     *  is invisible to {@link activeFilterCount} and untouched by `resetAll` above. */
    folderId,
    /** Open a folder, or `null` for the root. This hook only tracks where the reader now
     *  stands — it does not own the write that files a wish there, or the one that creates a
     *  folder; both live on the page, beside the folder cards. */
    openFolder: (id: number | null) => setFolderId(id),
    /**
     * `true` ignores `folderId` and shows every wish regardless of filing — no folder cards,
     * no drill-down, and every wish captioned with where it is filed instead. Also
     * navigation, for the reason `folderId` is: it says how much of the tree is on screen,
     * not which wishes qualify.
     */
    flatten,
    /** Off shows the current folder; on shows the whole wishlist. */
    toggleFlatten: () => setFlatten((current) => !current),
    /**
     * The marketplace every price on this view is quoted from — its label for the as-of
     * sentence and its currency for the formatter. The figures were decided by the query this
     * is part of the key of.
     */
    marketplace,
    /**
     * Every filter as one object, without the paging — `useCollection`'s `filters` for the same
     * reason: `useExportScope`'s sweep asks for the whole filtered list, and that needs this
     * object plus a page size of its own (`SWEEP_PAGE`) rather than the 100-row page on screen.
     */
    filters,
    query,
    rows,
    /** Wishes matching the filters, counted in full. `0` until the first page answers. */
    total: query.data?.pages[0]?.total ?? 0,
    /**
     * Identity of the current list, for anything that has to react to "this is a different
     * list now" — the scroll reset, above all. Derived from the query key itself rather than
     * rebuilt from the same fields, so the two cannot drift.
     */
    queryKeyString: JSON.stringify(listKey),
  };
}

/** The whole of what the view and its filter bar consume, named so the two agree. */
export type Wishlist = ReturnType<typeof useWishlist>;
