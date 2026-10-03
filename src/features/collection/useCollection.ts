import { useEffect, useMemo, useState } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  bordersParam,
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
import type { Border } from "@/lib/border";
import { CONDITIONS, type Condition } from "@/lib/conditions";
import { FINISHES, type Finish } from "@/lib/finish";
import { lockedFolderIds } from "@/lib/folderTree";
import {
  ipc,
  type CollectionPage,
  type CollectionQuery,
  type CollectionSortKey,
  type CollectionSummary,
  type ShelfCount,
} from "@/lib/ipc";
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
  /** The border chips — `regular`/`borderless`/`fullart`, over the copy's printing. One kind
   *  however many are pressed, for `types`' reason. */
  borders: readonly Border[];
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
    // One kind however many are pressed, for the type row's reason.
    f.borders.length > 0,
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
 * **One level as the page draws it** — the last level whose figures, shelf counts and list all
 * answered for their own keys, and what they were asked with. It is what the page is drawn from
 * while a walk to an uncached level is in flight (see `useCollection`'s `shown`), and it is drawn
 * **whole from the frame**: the three answers are one answer about one level, and a held wall laid
 * out with the *current* filtering and folds, scrolled on the *current* list identity or exported
 * with the *current* filters would be the old level's rows under a question they were never asked.
 * `useWishlist`'s `ShownLevel` holds the same fields for the same reason, less the figures its page
 * has no read of its own for.
 */
interface ShownLevel {
  levelId: number | null;
  figures: CollectionSummary | undefined;
  counts: ShelfCount[] | undefined;
  pages: InfiniteData<CollectionPage> | undefined;
  /** Whether a filter was on, and the folds, as the frame's answers were asked for. */
  filtering: boolean;
  folds: ReturnType<typeof useShelfFolds>["folds"];
  /** What the wall resets its scroll on — held with the rest, so the jump lands with the wall. */
  scrollKey: string;
  /** What a sweep of the frame's wall asks — the export's scope while it is held, so an Export
   *  pressed in that round trip covers the wall on screen and not the level still arriving.
   *  `countsKey` is its identity: the counts' own key, which every field of it is a segment of, so
   *  the frame catches up when the scope moves and only then. */
  filters: Omit<CollectionQuery, "limit" | "offset" | "sort">;
  countsKey: string;
}

/**
 * Whether a read has answered **for its own key**: not still waiting for a first answer, and not
 * showing the previous key's (`keepPreviousData`). A refusal counts as an answer — it is one, and a
 * hold that waited out an error would never end.
 */
function answered(read: { isPending: boolean; isPlaceholderData: boolean }): boolean {
  return !read.isPending && !read.isPlaceholderData;
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
 *
 * @param options.initialNeedsReview The needs-review filter this list **mounts** with — read once,
 *   by `useState`, and ignored afterwards. `CollectionPage` passes `useReviewHandoff`'s
 *   `initialNeedsReview`, which has to be the *initial* state rather than a render-phase write:
 *   TanStack's observer keeps the first render pass's options, so a filter switched on while
 *   rendering still fetched the unfiltered list once. `useReviewHandoff` has the measurement.
 *   **There is no `flattenLocally` beside it any more**: that was the hand-off's sweep, a flat read
 *   of every drawer, and the root's shelves are every drawer already.
 * @param options.folds The folds the shelves are built from, **in place of the stored ones** —
 *   `useShelfFolds("collection")`'s, which is what every caller that passes nothing gets, the
 *   desktop page included. The light app's phone face passes its own: a heading pressed there
 *   folds the shelf in place without writing `app_meta`, which `mobile:tauri` shares with the
 *   desktop's database, and nothing on the phone face writes yet. Held still by the caller (a
 *   `useMemo`): it is a level frame's input, and a fresh object every render is a new frame every
 *   render. `setFold` and `setMany` below still write the stored folds whichever was passed.
 */
export function useCollection({
  initialNeedsReview,
  folds: foldsOverride,
}: {
  initialNeedsReview?: boolean;
  folds?: Readonly<Record<string, boolean>>;
} = {}) {
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
  // The border chips (issue #573), a fact about the copy's *printing* rather than the copy — so
  // unlike `finishes` below they ask what the search's chips ask. On the wire for the type chips'
  // reason: `CardFilters.borders`, which `push_card_filters` emits for all three lists.
  const [borders, setBorders] = useState<readonly Border[]>([]);
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
  const [needsReview, setNeedsReview] = useState<boolean | undefined>(initialNeedsReview);
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
   *
   * **This is where the reader *asked* to stand, and the level the queries are keyed on.** What the
   * page draws can trail it by a round trip — see {@link ShownLevel} — so the hook publishes it as
   * `requestedFolderId` and publishes the level on screen as `folderId`.
   */
  const [asked, setAsked] = useState<number | null>(null);
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
  const bordersParamValue = bordersParam(borders);
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
  const stored = useShelfFolds("collection");
  const { setFold, setMany } = stored;
  const folds = foldsOverride ?? stored.folds;
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
      borders,
      priceMin,
      priceMax,
      finishes,
      conditions,
      needsReview,
    }) > 0;
  /** The shelves at the level the reader **asked** for — what the three queries below cover. The
   *  wall is drawn from `shelves` further down, which is these once that level has answered. */
  const askedShelves = useMemo(
    () => buildShelves({ folders: shelfFolders, levelId: asked, folds, filtering }),
    [shelfFolders, asked, folds, filtering],
  );
  const toCount = useMemo(() => shelvesToCount(askedShelves), [askedShelves]);
  const toFetch = useMemo(() => shelvesToFetch(askedShelves), [askedShelves]);
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
    borders: bordersParamValue,
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
    bordersParamValue?.join(",") ?? "",
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
    asked === null ? "root" : String(asked),
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

  /**
   * **The level on screen, which is not always the level asked for** (live pass, FAIL 14). Walking
   * to a level none of the three reads has cached used to draw the new level's *shelves* over the
   * old level's rows and counts — `keepPreviousData`'s placeholders — beside the old level's
   * figures: for 36–106 ms `Showcase` was `Cards 5 · $13.55` over a wall missing its own leading
   * row, then its cards popped in above the first heading. The rule, shared word for word with the
   * wishlist: **until the new level's figures, shelf counts and first page have all answered, the
   * page draws the previous level whole; it switches in one render once all three have.**
   *
   * So the hook keeps the last level it could draw whole — `shown`, a {@link ShownLevel} — and serves
   * every level-shaped answer (the level, its shelves, the counts, the rows, the figures, the scroll
   * key and the export's filters) from it while the asked level is still arriving. Three things make
   * it the rule rather than a softer one:
   *
   * - **All three, each answered for the asked level's own key** — `isPlaceholderData` is how a
   *   read says it is showing the previous key's answer, and `isPending` how it says it has none.
   *   A refusal answers too, so a read that fails ends the hold and the page says so.
   * - **The frame is a copy, not the placeholders.** The three reads cache apart: the figures and
   *   the counts are keyed without the sort or the folds and the list with both, so a level visited
   *   under another sort has its figures cached and its list not. Held on the placeholders alone,
   *   that walk drew the *new* figures over the *old* wall — the very mix this exists to prevent.
   * - **A level already answered switches at once**, frame or no frame: a cached level is drawn in
   *   the render that asked for it, which the live pass measured as correct and is kept.
   *
   * `shown` is written **during render**, the way `CollectionPage` answers a `pendingFolder` — never
   * from an effect (the lint rule and its cascading renders) and never from a ref read in render
   * (React's `refs` rule) — and only when an answer or its question actually changed, so it costs one
   * extra render per answer. It is `null` until a level has answered whole, so the first level a page
   * ever draws — a hand-off included — is never held behind nothing. `held` is `shown` while a level
   * change is in flight, and `null` otherwise: nothing but a level change holds, and a filter typed
   * or a shelf folded during the hold is drawn with the new level. `useWishlist` spells it the same.
   */
  const scrollKey = JSON.stringify(["collection", "list", filterKey, sortKey]);
  const countsKey = JSON.stringify(["collection", "shelfCounts", filterKey, countKey]);
  const levelAnswered = answered(query) && answered(summary) && answered(shelfCounts);
  const [shown, setShown] = useState<ShownLevel | null>(null);
  if (
    levelAnswered &&
    (shown === null ||
      shown.levelId !== asked ||
      shown.figures !== summary.data ||
      shown.counts !== shelfCounts.data ||
      shown.pages !== query.data ||
      shown.filtering !== filtering ||
      shown.folds !== folds ||
      shown.scrollKey !== scrollKey ||
      shown.countsKey !== countsKey)
  ) {
    setShown({
      levelId: asked,
      figures: summary.data,
      counts: shelfCounts.data,
      pages: query.data,
      filtering,
      folds,
      scrollKey,
      filters,
      countsKey,
    });
  }
  const held = !levelAnswered && shown !== null && shown.levelId !== asked ? shown : null;
  const levelId = held === null ? asked : held.levelId;
  const drawnFiltering = held === null ? filtering : held.filtering;
  const drawnFolds = held === null ? folds : held.folds;

  /**
   * The wall's shelves: the asked level's once it has answered, and until then the held level's —
   * **built from the frame's filtering and folds**, never the current ones, so the held wall is the
   * previous level whole rather than its rows under shelves laid out for a filter it never asked.
   */
  const heldShelves = useMemo(
    () =>
      held === null
        ? null
        : buildShelves({
            folders: shelfFolders,
            levelId: held.levelId,
            folds: held.folds,
            filtering: held.filtering,
          }),
    // Nothing of the asked level's in here: a filter or a fold changed during the hold re-lays the
    // level being asked for, never the held one.
    [held, shelfFolders],
  );
  const shelves = heldShelves ?? askedShelves;
  const figures = held === null ? summary.data : held.figures;
  const shelfCountRows = held === null ? shelfCounts.data : held.counts;
  const pages = held === null ? query.data : held.pages;
  const counts = useMemo(() => countsById(shelfCountRows), [shelfCountRows]);
  /** The shelves that get a place on the wall — `lib/shelves.ts`'s rule, over the counts. */
  const visible = useMemo(
    () => visibleShelves(shelves, counts, drawnFiltering),
    [shelves, counts, drawnFiltering],
  );

  const rows = useMemo(() => pages?.pages.flatMap((p) => p.items) ?? [], [pages]);

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
    /** The border chips, ORed with each other and ANDed with everything else — a copy answers
     *  the chip its printing's frame answers, so a borderless full-art copy answers two. */
    borders,
    toggleBorder: (border: Border) => setBorders((picked) => toggleIn(picked, border)),
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
     * Which folder the reader is standing in **as the page draws it**. `null` is the root of the
     * cabinet — a real destination, the drawer every unfiled copy lands in, and not "no folder
     * chosen". Navigation, not a filter: excluded from {@link CollectionFilterState} on purpose, so
     * it is invisible to {@link activeFilterCount} and untouched by `resetAll` below.
     *
     * **It trails {@link requestedFolderId} while a level nothing has cached is arriving** — see
     * {@link ShownLevel} — so everything drawn from it (the path row, the wall, the export's
     * sentence, the Share control) names the level that is on screen.
     */
    folderId: levelId,
    /**
     * Where the reader last **asked** to stand — `folderId` one round trip early. The page's
     * navigation reads this and nothing else does: Escape's step up (two presses in quick
     * succession are two levels, not one level twice), and the two render-phase hand-offs, which
     * would chase a level the queries have already moved to and loop.
     */
    requestedFolderId: asked,
    /** Whether the page is still drawing the previous level while {@link requestedFolderId}
     *  arrives. The rows on screen are that level's, so nothing may page past them meanwhile. */
    levelHeld: held !== null,
    /** Open a folder, or `null` for the root. This hook only tracks where the reader now is; it
     *  does not create, rename, move or delete a folder — those live on the page, on the path row
     *  and the shelf headings. */
    openFolder: setAsked,
    /**
     * The wall's shelves at the level on screen, in drawing order, **as built** — collapsed ones and
     * an empty Not sorted included. The page draws `visible`; this is what the fold controls and
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
    /** Whether any search text or filter is on — collapse is suspended while it is (decision 4).
     *  **The wall's answer**: while a level is held, the frame's, which is what its shelves were
     *  laid out from. */
    filtering: drawnFiltering,
    /** The stored folds for this page (`useShelfFolds("collection")`) as the wall is drawn from —
     *  the frame's while a level is held — and its two writes, which always write the reader's. */
    folds: drawnFolds,
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
      borders,
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
      setBorders([]);
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
     *
     * **Over the level the page draws**: while a level is held, the held level's filters **whole** —
     * its shelves, and the text and chips its answers were asked with — so an Export pressed in that
     * round trip sweeps the wall on screen, even with a filter typed since, and the sentence that
     * names it — built from `folderId`, the level drawn — says the same thing the sweep does.
     */
    filters: held === null ? filters : held.filters,
    /**
     * The list read **for the level asked for** — for its paging and its refusal. The rows on
     * screen are {@link rows}, which are the held level's while a level is held.
     */
    query,
    /**
     * `collection_summary` for the level on screen — the figures band. **Never the summary read
     * itself**, which answers for the level asked for and would put that level's figures over the
     * held level's wall: the one frame this hook exists to rule out.
     */
    figures,
    /**
     * Whether the read behind {@link figures} was refused, while there is no figure to show for
     * it — `countsError`'s companion, for the one page that has to know.
     *
     * **An empty wall cannot say which empty it is without the figures**: no rows on the open
     * shelves is an empty collection *or* one whose copies are all on folded shelves, and only
     * the whole-level count tells them apart. The phone face's collection page says neither
     * sentence when this is set, and says the read failed instead of drawing nothing.
     */
    figuresRefused: held === null && summary.isLoadingError,
    /** The rows of the level on screen, in wall order. */
    rows,
    /** Rows matching the filters at the level on screen, counted in full. `0` until the first page
     *  answers. */
    total: pages?.pages[0]?.total ?? 0,
    /**
     * Whether every row of the level on screen has been loaded — what the table's shelved rows stop
     * short of while pages remain. From the list drawn rather than from `query.hasNextPage`, which
     * answers about the level asked for.
     */
    listComplete: nextOffset(pages?.pages ?? []) === undefined,
    /**
     * Identity of the current list — the rows being fetched, collapse included. Derived from the
     * query key itself rather than rebuilt from the same fields, so the two cannot drift.
     */
    queryKeyString: JSON.stringify(listKey),
    /**
     * What the wall and the table reset their scroll on: the level, the filters and the sort —
     * **not** which shelves are open. A reader who folds a shelf half-way down the wall is still
     * reading the same wall, and throwing them back to the top for it would be the page moving
     * under their hand. **The level on screen's**, so the wall jumps to the top as the new level
     * is drawn rather than a round trip before, under the old one.
     */
    scrollKey: held === null ? scrollKey : held.scrollKey,
  };
}

/** The whole of what the view and its filter bar consume, named so the two agree. */
export type Collection = ReturnType<typeof useCollection>;
