import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { nextOffset } from "@/features/collection/useCollection";
import {
  colorParam,
  cycleTriState,
  DEBOUNCE_MS,
  FORMATS,
  NO_COLORS,
  searchTerms,
  toggleColorFilter,
  toggleIn,
  typesParam,
  type ColorFilter,
  type ColorKey,
} from "@/features/search/useCardSearch";
import { ipc, type WishlistQuery, type WishlistSortKey } from "@/lib/ipc";
import { sortOptions } from "@/lib/options";
import { applySort, type SortDir, type SortSpec } from "@/lib/sort";
import { useAppStore } from "@/lib/store";
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
  quantity: "desc",
  cost: "desc",
  price: "desc",
  added: "desc",
};

/** Everything {@link activeFilterCount} counts — every filter the wishlist view offers. */
export interface WishlistFilterState {
  text: string;
  format: string;
  /** The colour chips. **The tray's `Exact` toggle is deliberately not a field here** — it
   *  modifies what a picked colour means rather than being a filter of its own, so counting it
   *  would move the number on Reset all over a press that narrowed nothing new. Both siblings
   *  carry the same omission and the same argument. */
  colors: readonly string[];
  sets: readonly string[];
  manaValues: readonly number[];
  manaX: boolean;
  rarities: readonly string[];
  /** The card-type chips — `CARD_TYPES`, ORed with each other. One kind however many are
   *  pressed, for `rarities`' reason. */
  types: readonly string[];
  /** `true` is the wishes a sync flagged, `false` everything it did not touch. Three-way
   *  because the complement is a real question, and compared against `undefined` rather than
   *  tested for truthiness because `false` is a filter too. */
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
 *
 * **The number has been eight before, and for a different eighth kind.** `fulfilled` — the wishes
 * the collection already covered — was counted here until 2026-09-08, when it went with every
 * other comparison this list made against the binder; the card-type chips took the eighth place
 * back on 2026-09-22. A count is a fact about the list below it and nothing else, so read that
 * list rather than this sentence if the two ever disagree.
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
    // One kind however many chips are pressed, the way the colours and the rarities beside it
    // are counted: `Creature` and `Land` together are one narrowing of one question.
    f.types.length > 0,
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
 *
 * @param options.flattenLocally Draw the list flat **without writing** `wishlistFlattened` —
 *   `useReviewHandoff`'s `reviewSweep`, `useCollection`'s parameter of the same name one cabinet
 *   over and for its reason. OR'd with the stored switch into the one `flatten` this hook sends
 *   and returns.
 * @param options.initialNeedsReview The needs-review filter this list **mounts** with, read once by
 *   `useState` — `useCollection`'s parameter of the same name, and `useReviewHandoff` has the
 *   measurement behind it.
 */
export function useWishlist({
  flattenLocally = false,
  initialNeedsReview,
}: { flattenLocally?: boolean; initialNeedsReview?: boolean } = {}) {
  // Which marketplace this list quotes — an input to the query and part of its key, because
  // it decides what a Cost cell contains and not merely how it is written.
  const { marketplace } = useMarketplace();
  const [text, setText] = useState("");
  // The card filters, drawn since 2026-08-26 and **on the wire the whole time before that**:
  // `WishlistQuery` has extended `CardFilters` since it was written, so every one of these was a
  // field the backend already read and this hook simply never sent. See {@link activeFilterCount}
  // for what changed on screen.
  const [format, setFormat] = useState("");
  // **One state for the row and its `Exact` flag, not two** — see {@link ColorFilter}, which
  // is shared with the other three hooks that own a colour filter and carries the reason.
  // `WishlistFilterState` still has no field for the flag: it is a modifier on the row rather
  // than a filter of its own, so it is counted by no `activeFilterCount`.
  const [colorFilter, setColorFilter] = useState<ColorFilter>(NO_COLORS);
  const colors = colorFilter.picked;
  const colorsStrict = colorFilter.strict;
  // The eight card-type chips, ORed with each other and ANDed with everything else — the rarity
  // chips' shape exactly, and on the wire for free: `WishlistQuery extends CardFilters`.
  const [types, setTypes] = useState<readonly string[]>([]);
  const [sets, setSets] = useState<readonly string[]>([]);
  const [manaValues, setManaValues] = useState<readonly number[]>([]);
  // Additive rather than exclusive, exactly as both siblings are: `cmc` counts `{X}` as zero, so
  // a `{X}{B}{B}{B}` on the list answers the `3` chip and this one both.
  const [manaX, setManaX] = useState(false);
  const [rarities, setRarities] = useState<readonly string[]>([]);
  const [needsReview, setNeedsReview] = useState<boolean | undefined>(initialNeedsReview);
  // Empty is name order — the view's own default, which is what a cleared sort falls back
  // to. Not a filter, so `resetAll` leaves it alone.
  const [sort, setSort] = useState<SortSpec<WishlistSortKey>>([]);
  // Where the reader is standing — `null` is the root wishlist, a real destination and not
  // "nothing chosen yet". Deliberately outside `WishlistFilterState`: it is navigation, not
  // something the reader narrowed, so `activeFilterCount` never sees it and `resetAll` leaves
  // it alone, the same reason `sort` does.
  //
  // **`useState` and not the store, which is `useCollection`'s rule and its reason**: a folder
  // restored at launch would open the app somewhere the reader did not navigate to. `store.ts`'s
  // `pendingFolder` is not that rule bending — it is a one-shot hand-off that `WishlistPage`
  // reads once as it renders and spends, so what arrives through it is a press made a moment ago
  // on another page rather than a memory.
  const [folderId, setFolderId] = useState<number | null>(null);
  /**
   * `true` ignores `folderId` and answers every wish wherever it is filed. Also navigation
   * rather than a filter, for the same reason `folderId` is — Flatten is "how much of the
   * tree am I looking at", not "which wishes qualify".
   *
   * **The one piece of this hook's state that is not `useState`**, `useCollection`'s twin and
   * for its reason: whether the reader reads their list flat is how they read it at all, so it
   * is held in the app store and persisted behind it. **`wishlistFlattened` is its own field
   * and starts `false`**, where the collection's starts `true` — a shopping list of tens of rows
   * is usually read whole, but its folders are how the reader groups what they are saving *for*,
   * and a reader who flattened their cabinet was not saying anything about that.
   *
   * **Two selectors, never one object literal**: a selector returning a fresh object is a new
   * reference on every store write, so this hook would re-render on a card zoom or a view
   * switch. `FilterBar`'s `ViewToggle` reads its eight fields the same way.
   *
   * **What the list draws is the stored switch _or_ the caller's `flattenLocally`**, and the
   * second is never written back — `useCollection`'s arrangement, where it is argued. The wire,
   * the key and the returned `flatten` all read the combined value.
   */
  const flattenStored = useAppStore((s) => s.wishlistFlattened);
  const flatten = flattenStored || flattenLocally;
  const toggleFlatten = useAppStore((s) => s.toggleWishlistFlattened);
  const [debouncedText, setDebouncedText] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedText(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  // Every multi-select is canonicalised before it reaches the key: picking two sets in either
  // order is the same list of rows and must not cost a second round trip.
  const colorsParam = colorParam(colors);
  /**
   * **The flag only rides with the letters** — `useCardSearch`'s `strictParam`, same rule and same
   * reason. Strict over an empty colour row filters nothing (the backend's arm is inside its own
   * `nonblank` guard), and the `Exact` toggle in the tray is always drawn, so a reader can press
   * it with no colour picked. Without this gate that press would mint a second query key for a
   * list that cannot differ.
   */
  const strictParam = colorsStrict && colorsParam !== undefined;
  const setsParam = sets.length > 0 ? [...sets].sort() : undefined;
  const manaParam = manaValues.length > 0 ? [...manaValues].sort((a, b) => a - b) : undefined;
  const raritiesParam = rarities.length > 0 ? [...rarities].sort() : undefined;
  // Through the shared `typesParam` rather than a fourth inline sort: three other hooks
  // canonicalise this same list, and four copies of one normal form is four places for it to
  // drift.
  const typesParamValue = typesParam(types);

  /**
   * The box, read as Scryfall's query syntax — the free text and the typed predicates.
   *
   * **This surface has no tag wiring**, so a tag term folds back into the free text rather than
   * being dropped: see {@link searchTerms}, which is the whole rule and the whole reason.
   *
   * Nothing new is owed to `filterKey` below: `debouncedText` is already a segment of it and
   * these two fields are a pure function of that string.
   */
  const terms = useMemo(() => searchTerms(debouncedText), [debouncedText]);

  const filters: Omit<WishlistQuery, "limit" | "offset" | "sort"> = {
    // A blank string and an empty term list are dropped rather than sent: the backend reads
    // them as unset anyway, and sending them would make the payload lie about intent.
    ...terms,
    // The same rule for all five. **`playableOnly` is deliberately never sent beside `format`** —
    // the card search pairs the two (`formatParams`), and that pairing must not travel here: a
    // wish for an art card is a card the reader wants, and a corpus filter would answer their own
    // shopping list with a shorter one. It is also why this surface does not set
    // `FilterSurface.anyCard`: with nothing narrowing the corpus there is nothing for a widening
    // row to put back.
    format: format || undefined,
    colors: colorsParam,
    // Absent rather than `false` when the chip is off, the rule every optional filter on this
    // payload follows: `false` on the wire reads as "the reader chose loose" where they chose
    // nothing at all.
    colorsStrict: strictParam || undefined,
    sets: setsParam,
    types: typesParamValue,
    manaValues: manaParam,
    // Absent rather than `false`, which is what the backend defaults to. `true` widens — it adds
    // the `{X}` rows to whatever the numerals matched.
    manaX: manaX || undefined,
    rarities: raritiesParam,
    // Sent only when it is set. `false` — "everything the sync did not touch" — is meaningful on
    // the wire, and `undefined` is not sent at all.
    //
    // **A `fulfilled` field stood beside this one until 2026-09-08.** It asked the backend which
    // wishes the collection already covered, and the backend has stopped counting: the wishlist
    // compares itself to the collection nowhere, because the reader is the one who decides a wish
    // is done, by taking the card off the list.
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
    // `text` and `needsReview`.
    flatten: flatten || undefined,
  };

  // `["wishlist", …]`, so every write to *this* list refreshes it.
  //
  // **A collection write no longer fires it and no longer should.** The root was shared on the
  // grounds that a wish counted the copies the binder held (`WishRow.ownedQuantity`, computed
  // from `collection_entries`), so a stepper press two views away changed what this list said.
  // Nothing on a wish is derived from a collection row now, so `AddToCollection` narrowed its
  // invalidation to the list it actually wrote to — see the comment at that write.
  const listKey = [
    "wishlist",
    "list",
    debouncedText,
    // Every segment is a **string**, and the normalised one where there is a normal form: a key
    // holding an array compares by structure, so `["W","U"]` and `["U","W"]` would be two entries
    // for one answer. The four params above have already put each in order.
    format,
    colorsParam ?? "",
    // Its own segment beside the letters, and load-bearing for the X chip's reason one field
    // down: `WU` loose and `WU` strict are two different sets of wishes over the same local
    // SQLite, so a key built from the letters alone would serve the strict press out of the
    // loose list's cached pages.
    strictParam ? "strict" : "",
    setsParam?.join(",") ?? "",
    typesParamValue?.join(",") ?? "",
    manaParam?.join(",") ?? "",
    // Its own segment, and load-bearing: X is a second axis over the same chips, so a key built
    // from the numerals alone would serve "3, and also X" out of the pages cached for plain "3".
    manaX ? "x" : "",
    raritiesParam?.join(",") ?? "",
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
    // A functional updater, so a batch of presses composes, and clearing the last colour clears
    // `Exact` — one rule in {@link toggleColorFilter}, shared by all four hooks, and the
    // clearing rule it used to carry is written down there too.
    toggleColor: (key: ColorKey) => setColorFilter((s) => toggleColorFilter(s, key)),
    /** Read the colour row as "exactly these colours" rather than "at least these" — the
     *  tray's `Exact` toggle. A modifier on the row rather than a filter beside it, which is why
     *  {@link activeFilterCount} never sees it and why `resetAll` clears it anyway. */
    colorsStrict,
    toggleColorsStrict: () => setColorFilter((s) => ({ ...s, strict: !s.strict })),
    sets,
    toggleSet: (code: string) => setSets((picked) => toggleIn(picked, code)),
    /** The card-type chips, ORed with each other and ANDed with everything else. A wish matches
     *  a chip if that word is on its card's type line as a whole word, so an artifact land
     *  answers `Land` and `Artifact` both. */
    types,
    toggleType: (type: string) => setTypes((picked) => toggleIn(picked, type)),
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
     * `true` shows only the wishes a Scryfall migration or a vanished printing flagged,
     * `false` only those it did not, `undefined` asks nothing.
     */
    needsReview,
    /** Off → flagged → not flagged → off. The flagged ones first: that is the only reason
     *  anybody presses this, and the complement is where you go once they are dealt with. */
    toggleNeedsReview: () => setNeedsReview((current) => cycleTriState(current, true)),
    /** The same field, set outright. `FilterBar` walks the cycle itself for the chip in its tray
     *  and needs this one to *clear* the kind in a single press — `FilterSurface.needsReview`
     *  carries the argument for both surfaces. */
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
    // `colorsStrict` is deliberately not passed: it is not a field of
    // {@link WishlistFilterState}, for the reason written there.
    activeCount: activeFilterCount({
      text,
      format,
      colors,
      sets,
      manaValues,
      manaX,
      rarities,
      types,
      needsReview,
    }),
    /** Clear every filter at once. The sort is not a filter and stays: it is how the reader
     *  reads, not what they are looking at. `folderId` and `flatten` stay for the same
     *  reason: where the reader is standing, and whether they are ignoring the filing, are
     *  navigation rather than something they narrowed, so clearing a search must not also
     *  march them back to the root or drop them out of Flatten.
     *
     *  **`flatten` now lives in the app store (`wishlistFlattened`) and is persisted, which makes
     *  that exclusion sharper rather than looser**: this function is a list of `set*` calls over
     *  local state, and the one thing it must never grow is a reach into the store. A Reset all
     *  that cleared it would write the reader's saved preference away, and it would still be gone
     *  the next time they launched the app. */
    resetAll: () => {
      setText("");
      setFormat("");
      setColorFilter(NO_COLORS);
      // Cleared although it is not counted, and the asymmetry is the point: Reset all means "no
      // filters", and a strict flag left standing over an empty colour row is exactly the
            setSets([]);
      setTypes([]);
      setManaValues([]);
      setManaX(false);
      setRarities([]);
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
     *
     * The store's `wishlistFlattened`, read straight through — **or'd with the caller's
     * `flattenLocally`**, which is the one way this can be `true` while the stored switch is off.
     */
    flatten,
    /** Off shows the current folder; on shows the whole wishlist. The store's own action —
     *  **toggle-only on purpose**, because a `set(value)` invites a caller to compute the next
     *  state from a `flatten` it captured a render ago. */
    toggleFlatten,
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
