import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
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
import { CONDITIONS, type Condition } from "@/lib/conditions";
import { FINISHES, type Finish } from "@/lib/finish";
import { lockedFolderIds } from "@/lib/folderTree";
import { ipc, type CollectionQuery, type CollectionSortKey } from "@/lib/ipc";
import { sortOptions } from "@/lib/options";
import {
  buildShelves,
  shelvesToCount,
  shelvesToFetch,
  visibleShelves,
} from "@/lib/shelves";
import { applySort, type SortDir, type SortSpec } from "@/lib/sort";
import { useMarketplace } from "@/lib/useMarketplace";
import { countsById, shelfFolderOf } from "./collectionShelfModel";
import { useCollectionFolderList } from "./useCollectionFolders";

/**
 * Rows per request. The backend clamps at 500 and defaults to this; a collection is
 * thousands of rows rather than the search's 116 k, so the page is twice the search's.
 */
export const COLLECTION_PAGE_SIZE = 100;

/** The sort key the backend understands. Re-exported so call sites keep one import. */
export type CollectionSort = CollectionSortKey;

/**
 * The orders the filter bar's select offers.
 *
 * **This array's order is its declaration order and nothing else.** `FilterBar`'s
 * sort `<select>` draws it alphabetically by label through `sortOptions` (`lib/options.ts`),
 * and the only other reader — `sortSelection` below — asks which keys are *in* it. So
 * reordering these five lines changes nothing a reader sees; it only breaks the reasoning
 * that follows, which groups them by what they answer rather than by where they land on
 * screen. Add to the end.
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
export const COLLECTION_FIRST_DIR: Record<CollectionSortKey, SortDir> = {
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
  /** The colour chips. **The tray's `Exact` toggle is deliberately not a field here** — it
   *  modifies what a picked colour means rather than being a filter of its own, so counting it
   *  would move the number on Reset all over a press that narrowed nothing new. The search's
   *  `FilterState` carries the same omission and the same argument. */
  colors: readonly string[];
  sets: readonly string[];
  manaValues: readonly number[];
  /** The X chip — "also the cards with `{X}` in their printed cost". The other half of the
   *  question `manaValues` asks, and counted with it below for that reason. */
  manaX: boolean;
  rarities: readonly string[];
  /** The card-type chips — `CARD_TYPES`, ORed with each other. One kind however many are
   *  pressed, for `rarities`' reason. */
  types: readonly string[];
  /** The band the Price cell sets, at the marketplace the list is quoting. Either end alone is a
   *  filter; both `undefined` is none. */
  priceMin: number | undefined;
  priceMax: number | undefined;
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
    // One term with the numerals, as the search counts it: the X chip is the last chip of
    // that same group and is OR'd with them, so "3 and X" is one thing to clear. In here at
    // all, though — an X-only filter that counted zero would hide the Reset all that clears it.
    f.manaValues.length > 0 || f.manaX,
    f.rarities.length > 0,
    // One kind however many chips are pressed, the way the colours and the rarities beside it
    // are counted: `Creature` and `Land` together are one narrowing of one question.
    f.types.length > 0,
    // One kind for both ends, as the search counts it: `$5 – $20` is one band and one thing to
    // clear, so a reader who set both ends and saw `Reset all 2` would have been told the wrong
    // number about one control.
    f.priceMin !== undefined || f.priceMax !== undefined,
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
 * Filter state, the debounce, the shelves, and the three queries behind the collection view.
 *
 * The same shape as `useCardSearch` — one key built from every input, `keepPreviousData` so
 * a refined filter does not blank the table — with the collection's own three filters and a
 * sort on top, and one addition of substance: the aggregate header is a **second query over
 * the same filters**, not a field of the page. A header that describes a different set of
 * rows than the table under it is worse than no header, and recomputing nine aggregates on
 * every scrolled page would be worse still. The per-shelf counts are the third, over the same
 * scope again, for the headings.
 */
export function useCollection() {
  // Which marketplace this list quotes — an input to both queries below, and part of both
  // keys: it decides what a Value cell contains, not merely how it is written.
  const { marketplace } = useMarketplace();
  const [text, setText] = useState("");
  const [format, setFormat] = useState("");
  // **One state for the row and its `Exact` flag, not two** — see {@link ColorFilter}, which
  // is shared with the other three hooks that own a colour filter and carries the reason.
  // `CollectionFilterState` still has no field for the flag: it is a modifier on the row rather
  // than a filter of its own, so it is counted by no `activeFilterCount`.
  const [colorFilter, setColorFilter] = useState<ColorFilter>(NO_COLORS);
  const colors = colorFilter.picked;
  const colorsStrict = colorFilter.strict;
  // The eight card-type chips, ORed with each other and ANDed with everything else — the rarity
  // chips' shape exactly. On the wire for free: `CollectionQuery extends CardFilters`.
  const [types, setTypes] = useState<readonly string[]>([]);
  const [sets, setSets] = useState<readonly string[]>([]);
  const [manaValues, setManaValues] = useState<readonly number[]>([]);
  // Additive rather than exclusive, exactly as the search's is: `cmc` counts `{X}` as zero, so
  // a `{X}{B}{B}{B}` in the collection answers the `3` chip and this one both.
  const [manaX, setManaX] = useState(false);
  // On the wire since `CardFilters` was shared and drawn since 2026-08-26 — the four gems the
  // search's tray has always offered, over the reader's own binder.
  const [rarities, setRarities] = useState<readonly string[]>([]);
  // The band the Price cell sets. `collection::scope` bands the **copy's own per-finish price**
  // rather than the printing's fallback chain, so a banded row is a row the Value column agrees
  // with — the contrast is written down there.
  const [priceMin, setPriceMin] = useState<number | undefined>(undefined);
  const [priceMax, setPriceMax] = useState<number | undefined>(undefined);
  const [finishes, setFinishes] = useState<readonly Finish[]>([]);
  const [conditions, setConditions] = useState<readonly Condition[]>([]);
  const [needsReview, setNeedsReview] = useState<boolean | undefined>(undefined);
  // Empty is name order — the view's own default, which is what a cleared sort falls back
  // to. Not a filter, so `resetAll` leaves it alone.
  const [sort, setSort] = useState<SortSpec<CollectionSortKey>>([]);
  /**
   * Which folder the reader is standing in — `null` is the **root of the cabinet**.
   *
   * **The level, and since shelves the level is what the wall covers from, never what it
   * narrows to.** At the root the wall is every card — Not sorted, then every folder, then the
   * app's own under **Decks** — and inside a folder it is that folder and everything under it
   * (spec §3.1). The wire says so with `shelves`, never with `folderId` / `rootOnly`, which stay on
   * `CollectionQuery` for the callers that send an unasked query (the mirror, the export sweep, the
   * deck panel, the importer).
   *
   * Deliberately outside `CollectionFilterState`: it is navigation, not something the reader
   * narrowed, so `activeFilterCount` never sees it and `resetAll` leaves it alone.
   *
   * **`store.ts`'s `pendingFolder` is a one-shot hand-off, not a memory**: `CollectionPage` reads
   * it once as it renders and spends it, so nothing restores a folder at launch.
   */
  const [folderId, setFolderId] = useState<number | null>(null);
  const [debouncedText, setDebouncedText] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedText(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const colorsParam = colorParam(colors);
  /**
   * **The flag only rides with the letters** — `useCardSearch`'s `strictParam`, same rule and same
   * reason. Strict over an empty colour row filters nothing (the backend's arm is inside its own
   * `nonblank` guard), and the `Exact` toggle in the tray is always drawn, so a reader can press
   * it with no colour picked. Without this gate that press would mint a second query key for a
   * list that cannot differ.
   */
  const strictParam = colorsStrict && colorsParam !== undefined;
  // Every multi-select is canonicalised before it reaches the key: picking two finishes in
  // either order is the same set of rows and must not cost a second round trip. Ordered by
  // the app's own vocabulary rather than alphabetically, so the request reads the way the
  // chips do.
  const setsParam = sets.length > 0 ? [...sets].sort() : undefined;
  const manaParam = manaValues.length > 0 ? [...manaValues].sort((a, b) => a - b) : undefined;
  const raritiesParam = rarities.length > 0 ? [...rarities].sort() : undefined;
  // Through the shared `typesParam` rather than a fourth inline sort: three other hooks
  // canonicalise this same list, and four copies of one normal form is four places for it to
  // drift.
  const typesParamValue = typesParam(types);
  const finishParam =
    finishes.length > 0 ? FINISHES.filter((f) => finishes.includes(f)) : undefined;
  const conditionParam =
    conditions.length > 0 ? CONDITIONS.filter((c) => conditions.includes(c)) : undefined;

  /**
   * The box, read as Scryfall's query syntax — the free text and the typed predicates.
   *
   * **This surface has no tag wiring**, so a tag term folds back into the free text rather than
   * being dropped: see {@link searchTerms}, which is the whole rule and the whole reason.
   *
   * Nothing new is owed to `filterKey` below. `debouncedText` is already a segment of it and
   * these two fields are a pure function of that string, so a payload that changed without the
   * key changing would be a parser that is not a function.
   */
  const terms = useMemo(() => searchTerms(debouncedText), [debouncedText]);

  /**
   * **The shelves** (spec §5.1): the folder census, the level, the stored folds and whether a
   * filter is on, built into the ordered list the wall is drawn from — by `lib/shelves.ts`, which
   * is where the order is decided. This hook owns the inputs because two of them are its own
   * state: where the reader stands, and what the filters are.
   *
   * `filtering` reads the **debounced** box, the same text the query sends, so collapse is
   * suspended by the search that is actually on the wire rather than by a keystroke still waiting
   * out `DEBOUNCE_MS`.
   */
  const folderList = useCollectionFolderList();
  const { folds, setFold, setMany } = useShelfFolds("collection");
  /**
   * The drawers set aside, **every folder inside a locked one included** — `lockedFolderIds` is
   * the single place that inheritance is computed on this side, and a shelf's `locked` is this
   * answer, never `CollectionFolder.locked`. Published for the page, which reads the same set for
   * its menu, its drag confirmation and its tiles.
   */
  const lockedIds = useMemo(() => lockedFolderIds(folderList.folders), [folderList.folders]);
  const shelfFolders = useMemo(
    () => folderList.folders.map((one) => shelfFolderOf(one, lockedIds)),
    [folderList.folders, lockedIds],
  );
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
      priceMin,
      priceMax,
      finishes,
      conditions,
      needsReview,
    }) > 0;
  const shelves = useMemo(
    () => buildShelves({ folders: shelfFolders, levelId: folderId, folds, filtering }),
    [shelfFolders, folderId, folds, filtering],
  );
  const toCount = useMemo(() => shelvesToCount(shelves), [shelves]);
  const toFetch = useMemo(() => shelvesToFetch(shelves), [shelves]);
  /**
   * **Nothing is asked until the census has answered.** Before it, `buildShelves` has no folders
   * and the list would be Not sorted alone — the empty page of a reader who files everything,
   * drawn for one round trip and then filled. A census that *fails* is not pending, and the page
   * then draws what it can: the cards filed nowhere.
   */
  const censusReady = !folderList.query.isPending;

  const filters: Omit<CollectionQuery, "limit" | "offset" | "sort"> = {
    // Blank strings and empty term lists are dropped rather than sent: the backend reads them
    // as unset anyway, and sending them would make the payload lie about intent.
    ...terms,
    format: format || undefined,
    colors: colorsParam,
    // Absent rather than `false` when the chip is off, which is the rule every optional filter
    // on this payload follows: `false` on the wire reads as "the reader chose loose" where they
    // chose nothing at all.
    colorsStrict: strictParam || undefined,
    sets: setsParam,
    types: typesParamValue,
    manaValues: manaParam,
    // Absent rather than `false`, which is what the backend defaults to: an off chip is not a
    // filter, and a payload that said so would be lying about intent the way a blank `text`
    // would. `true` widens — it adds the `{X}` rows to whatever the numerals matched.
    manaX: manaX || undefined,
    rarities: raritiesParam,
    // Each end sent only where the reader set one, so a band open at the bottom is one bound on
    // the wire rather than a zero the backend would have to tell apart from "no floor".
    priceMin,
    priceMax,
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
    //
    // The marketplace **is** a filter in the sense that matters here: it decides the numbers
    // the list and the header both carry, so it belongs on the shared object and in the key
    // both queries are built from.
    marketplace: marketplace.id,
    // **Every shelf at and below the level, collapsed ones included** — what the wall covers,
    // which is what the header counts and what an export of "matching your filters" exports.
    // The list query below overrides it with the open shelves only. `folderId` and `rootOnly`
    // are not sent: `shelves` outranks both on the other end.
    //
    // It rides on `filters` because `useExportScope`'s sweep reads this object: standing in a
    // folder and pressing Export exports that folder *and everything under it*, which is what is
    // on screen. `everythingFilters` strips it with the rest, and absent `shelves` + absent
    // `folderId` + absent `rootOnly` is "every folder" — the widest answer, which is exactly what
    // "everything" means.
    shelves: toCount,
  };

  /**
   * Which rows are being asked for, and whose prices they are quoted at — and nothing about
   * what order they come back in.
   *
   * The summary is keyed on this alone: it is a statement about a *set* of rows, and an
   * order is not part of a set, so re-sorting the table must not re-run nine aggregates
   * over the same collection.
   *
   * The marketplace is in here rather than beside the sort, and it is the one segment that is
   * not about which rows: `value` and `unpriced` are sums **at one marketplace**, and the two
   * are not conversions of each other — each omits the copies it cannot price. So a switch
   * genuinely does re-run the aggregates, which is the cost the singular-price shape trades
   * for never having to carry four of every figure.
   */
  const filterKey = [
    debouncedText,
    format,
    colorsParam ?? "",
    // Its own segment beside the letters, and load-bearing for the X chip's reason one field
    // down: `WU` loose and `WU` strict are two different sets of rows over the same local
    // SQLite, so a key built from the letters alone would serve the strict press out of the
    // loose list's cached pages — instantly, with nothing on screen to notice.
    strictParam ? "strict" : "",
    setsParam?.join(",") ?? "",
    typesParamValue?.join(",") ?? "",
    manaParam?.join(",") ?? "",
    // Its own segment, and load-bearing: X is a second axis over the same chips, so a key
    // built from the numerals alone would serve "3, and also X" out of the pages cached for
    // plain "3" — against local SQLite, instantly, with nothing on screen to notice.
    manaX ? "x" : "",
    raritiesParam?.join(",") ?? "",
    // `String(undefined)` is `"undefined"`, which is a segment as good as any other and cannot
    // collide with a number — where an empty string could be read as a bound of zero by anyone
    // debugging the key.
    String(priceMin),
    String(priceMax),
    finishParam?.join(",") ?? "",
    conditionParam?.join(",") ?? "",
    // Three terms, not two: the flagged rows and the rows nothing flagged are two different
    // sets, so a key that spelled both `""` would serve the complement from the other's cache.
    needsReview === undefined ? "" : needsReview ? "review" : "clear",
    marketplace.id,
    // The level. `String(n)` is digits, so it cannot collide with `"root"`. The shelves
    // themselves are keyed beside this rather than in it — see `countKey` and `fetchKey` below —
    // so that `scrollKey`, which is built from this array, moves with the level and not with a
    // collapse.
    folderId === null ? "root" : String(folderId),
  ];

  // `["collection", …]` on all three, so the one `invalidateQueries({ queryKey: ["collection"] })`
  // every write in the app already fires refreshes the wall, the header and the headings together.
  const sortKey = sort.map((t) => `${t.key}:${t.dir}`).join(",");
  /** Every shelf the wall covers — a new folder, a deleted one or a new level is a new list. */
  const countKey = toCount.join(",");
  /** The shelves drawn open — a collapse is a new list, and only for the list. */
  const fetchKey = toFetch.join(",");
  const listKey = ["collection", "list", filterKey, sortKey, fetchKey];

  const query = useInfiniteQuery({
    queryKey: listKey,
    queryFn: ({ pageParam }) =>
      ipc.collectionList({
        ...filters,
        // **The open shelves, in wall order** — the backend orders by position in this list and
        // then by the sort, so the rows arrive shelf by shelf and a shelf's tiles are contiguous.
        shelves: toFetch,
        // **No `excludeLocked` here, and none on the summary below** — issue #436: a set-aside
        // card is still a card the reader owns. The lock is marked on the tile and the heading.
        //
        // Absent rather than `[]` when nothing is sorted, so an untouched table produces exactly
        // the payload it always did.
        sort: sort.length > 0 ? sort : undefined,
        limit: COLLECTION_PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (_last, pages) => nextOffset(pages),
    placeholderData: keepPreviousData,
    enabled: censusReady,
  });

  const summary = useQuery({
    queryKey: ["collection", "summary", filterKey, countKey],
    // **Every shelf the wall covers** (spec §3.6) — collapsed ones included — so `Cards`, `Unique`,
    // `Value` and `For trade` are the reader's real figures whatever is folded. `filters` already
    // carries `shelves: toCount`; the list above is the one query that narrows it.
    queryFn: () => ipc.collectionSummary({ ...filters, limit: 0, offset: 0 }),
    placeholderData: keepPreviousData,
    enabled: censusReady,
  });

  /**
   * One row per non-empty shelf, over the same scope and filters (spec §4.2) — what places every
   * heading before a page of cards has arrived, what hides a shelf with no match under a filter,
   * and what a heading's figures are summed from. `keepPreviousData` so a keystroke does not
   * blank every heading's figures for a round trip: the last answer stands until the next lands.
   */
  const shelfCounts = useQuery({
    queryKey: ["collection", "shelfCounts", filterKey, countKey],
    queryFn: () => ipc.collectionShelfCounts({ ...filters, limit: 0, offset: 0 }),
    placeholderData: keepPreviousData,
    enabled: censusReady,
  });
  const counts = useMemo(() => countsById(shelfCounts.data), [shelfCounts.data]);
  /** The shelves that get a place on the wall — `lib/shelves.ts`'s rule, over the counts. */
  const visible = useMemo(
    () => visibleShelves(shelves, counts, filtering),
    [shelves, counts, filtering],
  );

  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);

  return {
    text,
    setText,
    format,
    setFormat,
    /**
     * The rows the format picker offers — the shared {@link FORMATS} and nothing added to it.
     *
     * Unlike the deck editor's two search surfaces there is no default format to seed: nothing
     * opens this page pointed at a format, so the picker can never be sitting on a key the list
     * does not hold. `formatsWithDefault`'s whole job is that seeding, which is why it is not
     * called here.
     *
     * **And no `anyCard`** — see `FilterSurface.anyCard`. Every row of this picker is a real
     * `legalities` key or the empty string, because a collection's corpus is the reader's own
     * cardboard and is narrowed by nothing a widening row could put back.
     */
    formats: FORMATS,
    colors,
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
    /** The card-type chips, ORed with each other and ANDed with everything else. A copy matches
     *  a chip if that word is on its printing's type line as a whole word, so an artifact land
     *  answers `Land` and `Artifact` both. */
    types,
    toggleType: (type: string) => setTypes((picked) => toggleIn(picked, type)),
    rarities,
    toggleRarity: (rarity: string) => setRarities((picked) => toggleIn(picked, rarity)),
    priceMin,
    priceMax,
    /** Both ends at once, because `PriceRange` moves them together — a slider drag can change
     *  either, and two setters would be two renders and two query keys for one gesture. */
    setPriceRange: (min: number | undefined, max: number | undefined) => {
      setPriceMin(min);
      setPriceMax(max);
    },
    /**
     * **No facets, and that is a fact about this list rather than a gap.** `facets.ts` reads
     * `undefined` as "we do not know", which leaves every chip live and nothing greyed — the
     * honest state here, because `collection_list` has no facet command behind it the way
     * `search_cards` does. Counting would be a second query per keystroke over the reader's whole
     * binder, for a row of numbers beside a list already on screen.
     */
    facets: undefined,
    manaValues,
    toggleManaValue: (value: number) => setManaValues((picked) => toggleIn(picked, value)),
    /**
     * Also match the rows whose printed cost contains `{X}`.
     *
     * **Additive, never exclusive** — OR'd with the numeral chips as they are OR'd with each
     * other, so `3` and `X` together ask for "costs 3, or has an X" and a `{X}{B}{B}{B}`
     * appears once. Counted with `manaValues` as one kind, and cleared by `resetAll`.
     */
    manaX,
    toggleManaX: () => setManaX((on) => !on),
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
    /**
     * Which folder the reader is standing in. `null` is the root of the cabinet — a real
     * destination, the drawer every unfiled copy lands in, and not "no folder chosen".
     * Navigation, not a filter: excluded from {@link CollectionFilterState} on purpose, so it is
     * invisible to {@link activeFilterCount} and untouched by `resetAll` below.
     */
    folderId,
    /** Open a folder, or `null` for the root. This hook only tracks where the reader now is; it
     *  does not create, rename, move or delete a folder — those live on the page, beside the
     *  folder cards. */
    openFolder: setFolderId,
    /**
     * The wall's shelves at this level, in drawing order, **as built** — collapsed ones and an
     * empty Not sorted included. The page draws `visible`; this is what the fold controls and
     * **Expand all** / **Collapse all** act on, and what a draft folder is added to.
     */
    shelves,
    /** The shelves that get a place on the wall (`visibleShelves`). */
    visible,
    /** `collection_shelf_counts` by shelf id, or `null` before it has answered. */
    counts,
    /**
     * Why the counts did not answer, or `null`. The page waits for the counts before it lays the
     * wall out — a layout drawn from no counts would put an empty box under every folder for a
     * round trip — so a refusal here has to be said rather than left as a wall that never arrives.
     */
    countsError: shelfCounts.isError ? shelfCounts.error : null,
    /** Whether any search text or filter is on — collapse is suspended while it is (decision 4). */
    filtering,
    /** The stored folds for this page (`useShelfFolds("collection")`), and its two writes. */
    folds,
    setFold,
    setMany,
    /** The folder census as `buildShelves` takes it — the page adds a draft to it while naming. */
    shelfFolders,
    /** {@link lockedFolderIds} over the census — the effective lock, computed once. */
    lockedIds,
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
    setSortKey: (key: CollectionSortKey | "") =>
      setSort(key === "" ? [] : [{ key, dir: COLLECTION_FIRST_DIR[key] }]),
    /**
     * Which way the list runs — **never `undefined`, which is where this parts company with the
     * card search's twin.**
     *
     * An empty spec is this list's name order rather than a ranking, so it has a direction and
     * that direction is `COLLECTION_FIRST_DIR.name`. The search's empty spec is `Best match`,
     * which has none, and its arrow greys there; greying this one would grey a button that works,
     * on a list whose order is on screen in front of the reader.
     */
    sortDir: sort.length === 0 ? COLLECTION_FIRST_DIR.name : sort[0].dir,
    /**
     * Turn the first term over — the same control the table's headers drive, from the other end.
     *
     * **An empty spec is written out rather than left alone.** It *is* name order here, so the
     * button is drawn live and pointing up; leaving it alone would be a control that visibly does
     * nothing. Flipping it materialises the order the list was already in, reversed.
     */
    flipSortDir: () =>
      setSort((spec) =>
        spec.length === 0
          ? [{ key: "name", dir: COLLECTION_FIRST_DIR.name === "asc" ? "desc" : "asc" }]
          : spec.map((term, at) =>
              at === 0 ? { key: term.key, dir: term.dir === "asc" ? "desc" : "asc" } : term,
            ),
      ),
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
    /**
     * The rows that select draws, **including the `Custom…` the sort can only be *put* into.**
     *
     * It lives here rather than in `FilterBar` because it is a fact about this list's *state*
     * rather than about the control: the Value and Finish headers sort by keys the select has no
     * option for, so the select would otherwise be sitting on a value none of its rows carries —
     * and a controlled `<select>` whose value matches no option silently reports the **first**
     * one. That is the trap `FilterBar`'s format picker writes down at length, arriving on a
     * different control.
     *
     * Drawn only while the sort is in that state, and `disabled` when it is: picking it would be
     * picking the sort you already have. `disabled` and not `aria-disabled` — a native `<option>`
     * is the house rule's one exception, because the reason behind that rule (a disabled control
     * leaves the tab order) is about something that was in it to begin with.
     *
     * Sorted alphabetically by label like every other option list (`lib/options.ts`), with the
     * pinned row outside the sort — it is the state of the control rather than an order to pick.
     */
    sortRows: [
      ...(sort.length > 0 && !COLLECTION_SORTS.some((s) => s.value === sort[0].key)
        ? ([{ value: "", label: "Custom…", disabled: true }] as const)
        : []),
      ...sortOptions(COLLECTION_SORTS, (s) => s.label),
    ] as readonly { value: CollectionSortKey | ""; label: string; disabled?: boolean }[],
    /** How many kinds of filter are on — the number on the Reset all badge. `colorsStrict` is
     *  deliberately not passed: it is not a field of {@link CollectionFilterState}, for the
     *  reason written there. */
    activeCount: activeFilterCount({
      text,
      format,
      colors,
      sets,
      manaValues,
      manaX,
      rarities,
      types,
      priceMin,
      priceMax,
      finishes,
      conditions,
      needsReview,
    }),
    /** Clear every filter at once, including the search box. The sort is not a filter and
     *  stays: it is how the reader reads, not what they are looking at. `folderId` stays for the
     *  same reason — where they are standing is navigation — and so do the stored folds, which
     *  this function never touches: a filter only ever *suspends* collapse, so clearing it hands
     *  every fold back exactly as the reader left it. */
    resetAll: () => {
      setText("");
      setFormat("");
      // `Exact` goes with the colours, although it is not counted, and the asymmetry is the point:
      // Reset all means "no filters", and a strict flag left standing over an empty colour row is
      // state with no control drawn for it.
      setColorFilter(NO_COLORS);
      setSets([]);
      setTypes([]);
      setManaValues([]);
      setManaX(false);
      setRarities([]);
      setPriceMin(undefined);
      setPriceMax(undefined);
      setFinishes([]);
      setConditions([]);
      setNeedsReview(undefined);
    },
    /**
     * The marketplace every price on this view is quoted from — its label for the as-of
     * sentence and its currency for the formatter. The figures themselves were decided by the
     * two queries this is part of the key of.
     */
    marketplace,
    /**
     * Every filter as one object, without the paging — what a request for "the whole filtered
     * list" needs and a request for "the page on screen" does not. `useExportScope`'s sweep is
     * the one other reader: exporting "matching your filters" means this object plus a page size
     * of its own (`SWEEP_PAGE`), never the 100-row page this view happens to have loaded.
     */
    filters,
    query,
    summary,
    rows,
    /** Rows matching the filters, counted in full. `0` until the first page answers. */
    total: query.data?.pages[0]?.total ?? 0,
    /**
     * Identity of the current list — the rows being fetched, collapse included. Derived from the
     * query key itself rather than rebuilt from the same fields, so the two cannot drift.
     */
    queryKeyString: JSON.stringify(listKey),
    /**
     * What the wall and the table reset their scroll on: the level, the filters and the sort —
     * **not** which shelves are open. A reader who folds a shelf half-way down the wall is still
     * reading the same wall, and throwing them back to the top for it would be the page moving
     * under their hand.
     */
    scrollKey: JSON.stringify(["collection", "list", filterKey, sortKey]),
  };
}

/** The whole of what the view and its filter bar consume, named so the two agree. */
export type Collection = ReturnType<typeof useCollection>;
