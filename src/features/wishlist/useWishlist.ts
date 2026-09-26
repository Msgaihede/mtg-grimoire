import { useEffect, useMemo, useState } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
} from "@tanstack/react-query";
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
import { useShelfFolds } from "@/features/shelves/useShelfFolds";
import {
  ipc,
  type ShelfCount,
  type WishlistPage,
  type WishlistQuery,
  type WishlistSortKey,
} from "@/lib/ipc";
import { sortOptions } from "@/lib/options";
import { buildShelves, shelvesToCount, shelvesToFetch } from "@/lib/shelves";
import { applySort, type SortDir, type SortSpec } from "@/lib/sort";
import { useMarketplace } from "@/lib/useMarketplace";
import { useWishlistFolderList } from "./useWishlistFolders";
import { toShelfFolder } from "./wishShelfPlan";

/**
 * Rows per request. The backend clamps at 500 and defaults to this. A wishlist is tens of
 * rows where a collection is thousands, so this is a ceiling nobody meets rather than a page
 * size anybody scrolls past — which is also why the header below can add the list up itself.
 */
export const WISHLIST_PAGE_SIZE = 100;

/** The sort key the backend understands. Re-exported so call sites keep one import. */
export type WishlistSort = WishlistSortKey;

/** The level segment of every key this hook builds — `null` is the root, a real level. */
const levelSegment = (level: number | null): string => (level === null ? "root" : String(level));

/**
 * **One level as the page draws it** — the last level whose list and counts both answered for their
 * own keys, and what they were asked with. It is what the page is drawn from while a walk to an
 * uncached level is in flight (see `useWishlist`'s `shown`), and it is drawn **whole from the
 * frame**: the pages and the counts are one answer about one level, and a held wall laid out with
 * the *current* filtering and folds, or scrolled on the *current* list identity, would be the old
 * level's rows under shelves they were never fetched for (review Minor 3). `useCollection`'s
 * `ShownLevel` holds the same fields for the same reason.
 */
interface ShownLevel {
  levelId: number | null;
  pages: InfiniteData<WishlistPage, unknown> | undefined;
  counts: ShelfCount[] | undefined;
  /** Whether a filter was on, and the folds, as the frame's answers were asked for. */
  filtering: boolean;
  folds: Readonly<Record<string, boolean>>;
  /** The list identity the frame's wall scrolls on — `queryKeyString` while it is held. */
  scrollKey: string;
  /** What a sweep of the frame's wall asks — the export's and the price sweep's scope while it is
   *  held, so the sweep covers the wall on screen and not the level still arriving (review Minor
   *  2). `countsKey` is its identity: the counts' own key, which every field of it is a segment
   *  of, so the frame catches up when the scope moves and only then. */
  filters: Omit<WishlistQuery, "limit" | "offset" | "sort">;
  countsKey: string;
}

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
 * short-page pager.
 *
 * **Two reads, not one, since the shelves (2026-09-26):** the list, and `wishlist_shelf_counts`
 * over the same scope — the counts are what the header, the headings and every unfetched slot are
 * drawn from, because the list only ever holds the shelves that are open.
 *
 * @param options.initialNeedsReview The needs-review filter this list **mounts** with, read once by
 *   `useState` — `useCollection`'s parameter of the same name, and `useReviewHandoff` has the
 *   measurement behind it. **There is no `flattenLocally` beside it**, which `useReviewHandoff`'s
 *   sweep was handed until Flatten went: the root's shelves already hold every wish, so a review
 *   hand-off needs the filter and the root and nothing else (`WishlistPage` has the consume site).
 */
export function useWishlist({ initialNeedsReview }: { initialNeedsReview?: boolean } = {}) {
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

  /**
   * **The shelves this level draws (spec §5.1)** — built here, beside the wire, because the two id
   * lists sent to Rust are functions of them and nothing else.
   *
   * `filtering` is the **debounced** answer: the list asks with `debouncedText`, and a flag that
   * flipped on the keystroke would change the shelves sent a whole debounce before the text did —
   * two reads for one search. Any chip counts, text or not (spec §3.4, decision 4).
   *
   * **Nothing is asked until the folder list has answered** ({@link ready}). A read before it is a
   * read for Not sorted alone, then a second read for the wall a moment later — a flash of the
   * wrong page. The folds are not waited for: `useShelfFolds` is prefetched in `AppShell` and at
   * `staleTime: Infinity`, and an answer arriving late re-keys the read rather than wasting one.
   */
  const folderList = useWishlistFolderList();
  const { folds, setFold, setMany } = useShelfFolds("wishlist");
  const shelfFolders = useMemo(() => folderList.folders.map(toShelfFolder), [folderList.folders]);
  const filtering =
    activeFilterCount({
      text: debouncedText,
      format,
      colors,
      sets,
      manaValues,
      manaX,
      rarities,
      types,
      needsReview,
    }) > 0;
  const shelves = useMemo(
    () => buildShelves({ folders: shelfFolders, levelId: folderId, folds, filtering }),
    [shelfFolders, folderId, folds, filtering],
  );
  /** What the list fetches: the open shelves, in the order they are drawn — which is the list's
   *  first `ORDER BY` term, so the rows arrive in wall order. */
  const fetchIds = useMemo(() => shelvesToFetch(shelves), [shelves]);
  /** What the counts cover: every shelf at and below the level, shut ones included (spec §4.2). */
  const countIds = useMemo(() => shelvesToCount(shelves), [shelves]);
  const ready = !folderList.query.isPending;

  /** Every filter as the backend reads it, and nothing about which shelves. */
  const scope: Omit<WishlistQuery, "limit" | "offset" | "sort" | "shelves"> = {
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
    needsReview,
    // The marketplace is always sent: it is which prices the list is quoting rather than a
    // refinement that can be left off, and the backend's default happens to be one of the
    // five rather than "no opinion".
    marketplace: marketplace.id,
  };

  /**
   * **What the export sweep and the price sweep cover: the whole wall** — every shelf at and below
   * the level, shut ones included, which is exactly what the header's `Wishes` counts. The folder
   * and flatten fields that stood here are gone: an absent `folderId` meant "the root's loose
   * wishes" and would now narrow a sweep of the wall to its first shelf. `shelves` absent keeps
   * meaning what it always did for every caller that does not send it.
   */
  const filters: Omit<WishlistQuery, "limit" | "offset" | "sort"> = { ...scope, shelves: countIds };

  // Every segment is a **string**, and the normalised one where there is a normal form: a key
  // holding an array compares by structure, so `["W","U"]` and `["U","W"]` would be two entries
  // for one answer. The params above have already put each in order.
  const filterKey = [
    debouncedText,
    format,
    colorsParam ?? "",
    // `WU` loose and `WU` strict are two different sets of wishes, so the flag has a segment.
    strictParam ? "strict" : "",
    setsParam?.join(",") ?? "",
    typesParamValue?.join(",") ?? "",
    manaParam?.join(",") ?? "",
    // X is a second axis over the same chips, so "3, and also X" must not be served from plain "3".
    manaX ? "x" : "",
    raritiesParam?.join(",") ?? "",
    needsReview === undefined ? "" : needsReview ? "review" : "clear",
    // Two marketplaces are two answers to the same wishlist.
    marketplace.id,
  ];
  const scopeKey = [...filterKey, levelSegment(folderId)];
  const sortKey = sort.map((t) => `${t.key}:${t.dir}`).join(",");
  /**
   * The list's **identity** — the level, the filters and the sort, and deliberately not the
   * shelves it fetched. It is what {@link queryKeyString} publishes and the scroll reset follows,
   * and folding a shelf changes what is fetched without making it another list.
   */
  const listIdentity = ["wishlist", "list", ...scopeKey, sortKey];
  // `["wishlist", …]`, so every write to *this* list refreshes it.
  const listKey = [...listIdentity, fetchIds.join(",")];

  const query = useInfiniteQuery({
    queryKey: listKey,
    queryFn: ({ pageParam }) =>
      ipc.wishlistList({
        ...scope,
        shelves: fetchIds,
        // Absent rather than `[]` when nothing is sorted, so an untouched table produces
        // exactly the payload it always did.
        sort: sort.length > 0 ? sort : undefined,
        limit: WISHLIST_PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (_last, pages) => nextOffset(pages),
    placeholderData: keepPreviousData,
    enabled: ready,
  });

  /**
   * The per-shelf counts (spec §4.2) — `["wishlist", …]` like the list, so `settleWhole`'s
   * invalidation reaches it, and so does `crossWindow.ts`'s: `wishlist_entries` and
   * `wishlist_folders` both map to the `["wishlist"]` root. No sort in the key, because a count
   * cannot come back different for an order. `limit`/`offset` are required by `WishlistQuery` and
   * read by nothing on this command.
   */
  const countsKey = ["wishlist", "shelfCounts", ...scopeKey, countIds.join(",")];
  const countsQuery = useQuery({
    queryKey: countsKey,
    queryFn: () => ipc.wishlistShelfCounts({ ...scope, shelves: countIds, limit: 0, offset: 0 }),
    placeholderData: keepPreviousData,
    enabled: ready,
  });

  /**
   * **A walk to a level the cache does not hold keeps drawing the level being left, whole, until the
   * new one has answered — and then switches in one render** (live pass §14; `useCollection` holds
   * the same rule, so the two pages walk alike).
   *
   * Both reads are `keepPreviousData`, so the moment the level changes each serves the *previous*
   * level's answer as a placeholder — while the shelves, built from `folderId` right here, are
   * already the new level's. Drawn as it arrives, that was a wall laid out for the new level from
   * the old level's rows (the level's own wishes missing, then popping in above the first heading)
   * under the old level's figures, for 36–106 ms; and the two reads land apart, so for a frame the
   * figures could be one level's and the wall another's. So the page is handed a **drawn** level:
   *
   * - `shown` is the last level whose list **and** counts both answered for their own key — kept
   *   whole ({@link ShownLevel}): its pages and its counts together, and the filtering, folds, list
   *   identity and sweep scope they were asked with, so nothing drawn can mix two levels or two
   *   questions. It is state written during render (React's "information from previous renders"),
   *   and only when an answer or its question actually changes, so it costs one extra render per
   *   answer and never an effect.
   * - `levelHeld` is a level change in flight: the level asked for is not the one shown, and its
   *   two answers are not both in. The page then gets `shown` — its level, shelves, rows, counts,
   *   list identity, filtering, folds and sweep scope — and **nothing of the level being asked
   *   for**. A filter typed or a shelf folded during the hold is drawn with the new level.
   * - A read that **fails** counts as answered, so a refused level is switched to and says why
   *   rather than holding the old one for ever.
   *
   * **A cached level answers in the render that asks for it**, so it switches with no hold — the
   * behaviour the live pass measured as right, kept. And nothing but a level change holds: a new
   * filter or a fold is the same level, drawn as it always was.
   */
  const listAnswered = query.isError || (query.data !== undefined && !query.isPlaceholderData);
  const countsAnswered =
    countsQuery.isError || (countsQuery.data !== undefined && !countsQuery.isPlaceholderData);
  const answered = ready && listAnswered && countsAnswered;
  const scrollKey = JSON.stringify(listIdentity);
  const countsKeyString = JSON.stringify(countsKey);
  const [shown, setShown] = useState<ShownLevel | null>(null);
  if (
    answered &&
    (shown === null ||
      shown.levelId !== folderId ||
      shown.pages !== query.data ||
      shown.counts !== countsQuery.data ||
      shown.filtering !== filtering ||
      shown.folds !== folds ||
      shown.scrollKey !== scrollKey ||
      shown.countsKey !== countsKeyString)
  ) {
    setShown({
      levelId: folderId,
      pages: query.data,
      counts: countsQuery.data,
      filtering,
      folds,
      scrollKey,
      filters,
      countsKey: countsKeyString,
    });
  }
  const held = !answered && shown !== null && shown.levelId !== folderId ? shown : null;
  const levelId = held === null ? folderId : held.levelId;
  const drawnFiltering = held === null ? filtering : held.filtering;
  const drawnFolds = held === null ? folds : held.folds;
  // The held wall is laid out from the frame's filtering and folds, never the current ones — a
  // filter typed or a shelf folded during the hold would otherwise re-lay the previous level's rows
  // under shelves they were never fetched for.
  const drawnShelves = useMemo(
    () =>
      held === null
        ? shelves
        : buildShelves({
            folders: shelfFolders,
            levelId: held.levelId,
            folds: held.folds,
            filtering: held.filtering,
          }),
    [held, shelves, shelfFolders],
  );
  const pages = held === null ? query.data : held.pages;
  const counts = held === null ? countsQuery.data : held.counts;

  const rows = useMemo(() => pages?.pages.flatMap((p) => p.items) ?? [], [pages]);

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
     *  reads, not what they are looking at. `folderId` stays for the same reason — where the reader
     *  is standing is navigation — and so does every fold, which is `useShelfFolds`' and not a
     *  `set*` this list may grow. */
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
    /** The level the page **draws** — where the reader is standing, as far as anything on screen
     *  is concerned. `null` is the root wishlist — a real destination, the same folder every
     *  unfiled wish lands in — and not "no folder chosen". Navigation, not a filter: excluded from
     *  {@link WishlistFilterState} on purpose, so it is invisible to {@link activeFilterCount} and
     *  untouched by `resetAll` above. **It lags {@link requestedFolderId} while a walk to an
     *  uncached level is answering** (see `shown`), and equals it otherwise. */
    folderId: levelId,
    /** The level **asked for** — the last `openFolder`, drawn or not. What a render-phase hand-off
     *  must compare against (comparing the drawn level, it would ask again on every render of the
     *  hold), and what Escape walks up from, so two quick presses climb two levels. The
     *  collection's hook publishes the same answer under the same name. */
    requestedFolderId: folderId,
    /** A walk to an uncached level is answering, and the page is still drawing the level before
     *  it. Nothing may page the list in the meantime: the query is the new level's. */
    levelHeld: held !== null,
    /** Open a folder, or `null` for the root. This hook only tracks where the reader now
     *  stands — it does not own the write that files a wish there, or the one that creates a
     *  folder; both live on the page, beside the headings. */
    openFolder: (id: number | null) => setFolderId(id),
    /**
     * The shelves at and below the **drawn** level, in tree order, shut ones included —
     * `buildShelves`' answer, which the page draws from and re-asks with the folder being added
     * put in.
     */
    shelves: drawnShelves,
    /** The same folders `shelves` was built from, as `buildShelves` takes them. */
    shelfFolders,
    /** The stored folds for this page — overrides only (spec §5.7) — **as the wall is drawn from**:
     *  the held frame's while a level is held. `setFold` and `setMany` always write the reader's. */
    folds: drawnFolds,
    /** Fold one shelf: `true`/`false` stores an override, `null` returns it to its default. */
    setFold,
    /** Many folds in one write — Expand all and Collapse all. */
    setMany,
    /** A search or a filter is on — collapse is suspended (spec §3.4, decision 4). **The wall's
     *  answer**: the held frame's while a level is held, which is what its shelves were laid out
     *  from. */
    filtering: drawnFiltering,
    /** Per-shelf counts over every shelf at and below the drawn level; `undefined` until answered. */
    counts,
    countsQuery,
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
     *
     * **The drawn wall's, so the held frame's while a level is held** (review Minor 2): an Export
     * or an Optimise pressed during the hold covers what the page draws — the level its sentence
     * names — and not the level still arriving.
     */
    filters: held === null ? filters : held.filters,
    query,
    rows,
    /** Whether the drawn list has pages still to load — `query.hasNextPage`, asked of the held
     *  level's own pages while a walk is answering, since the query's belong to the new level. */
    hasMore:
      held === null
        ? query.hasNextPage
        : held.pages !== undefined && nextOffset(held.pages.pages) !== undefined,
    /** Wishes on the **open** shelves matching the filters, counted in full — the list's own
     *  total. `0` until the first page answers. The whole wall's count is {@link counts}'. */
    total: pages?.pages[0]?.total ?? 0,
    /**
     * Identity of the **drawn** list, for anything that has to react to "this is a different
     * list now" — the scroll reset, above all, which must not fire on a level the page is not yet
     * drawing. The query key less the shelves fetched, built from the same segments, so the two
     * cannot drift. **The held frame's while a level is held**, whole — not its level under the
     * current filter and sort, which reset the held wall's scroll on a keystroke made during the
     * hold (review Minor 3).
     */
    queryKeyString: held === null ? scrollKey : held.scrollKey,
  };
}

/** The whole of what the view and its filter bar consume, named so the two agree. */
export type Wishlist = ReturnType<typeof useWishlist>;
