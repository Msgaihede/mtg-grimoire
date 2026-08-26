import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  colorParam,
  cycleTriState,
  DEBOUNCE_MS,
  FORMATS,
  toggleColor,
  toggleIn,
  type ColorKey,
} from "@/features/search/useCardSearch";
import { CONDITIONS, type Condition } from "@/lib/conditions";
import { FINISHES, type Finish } from "@/lib/finish";
import { ipc, type CollectionQuery, type CollectionSortKey } from "@/lib/ipc";
import { sortOptions } from "@/lib/options";
import { applySort, type SortDir, type SortSpec } from "@/lib/sort";
import { useMarketplace } from "@/lib/useMarketplace";

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
  colors: readonly string[];
  sets: readonly string[];
  manaValues: readonly number[];
  /** The X chip — "also the cards with `{X}` in their printed cost". The other half of the
   *  question `manaValues` asks, and counted with it below for that reason. */
  manaX: boolean;
  rarities: readonly string[];
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
  // Which marketplace this list quotes — an input to both queries below, and part of both
  // keys: it decides what a Value cell contains, not merely how it is written.
  const { marketplace } = useMarketplace();
  const [text, setText] = useState("");
  const [format, setFormat] = useState("");
  const [colors, setColors] = useState<readonly ColorKey[]>([]);
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
   * Which folder the reader is standing in — `null` is the **root of the cabinet**, the copies
   * filed nowhere, exactly as it is on the wishlist.
   *
   * **`null` used to be every folder on this view, and Flatten is what took that job over.** The
   * wire did not move with it: `CollectionQuery.folder_id` is still `None = every folder` (spec
   * §8.4), chosen so that every caller written before folders existed — the plain-text mirror,
   * the export sweep, the deck panel, the importer's preview — keeps asking the question it
   * always asked. This view says the narrower thing with `rootOnly`, a field only it sends, so
   * the third state arrived without touching anybody else's answer.
   *
   * Deliberately outside `CollectionFilterState`: it is navigation, not something the reader
   * narrowed, so `activeFilterCount` never sees it and `resetAll` leaves it alone — the same
   * reason `sort` is outside.
   */
  const [folderId, setFolderId] = useState<number | null>(null);
  // `true` ignores `folderId` and answers every copy wherever it is filed. Also navigation
  // rather than a filter, for the same reason `folderId` is — Flatten is "how much of the
  // cabinet am I looking at", not "which copies qualify".
  const [flatten, setFlatten] = useState(false);
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
  const raritiesParam = rarities.length > 0 ? [...rarities].sort() : undefined;
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
    // Sent only when the reader is actually inside a folder, and **not at all while the list is
    // flattened**: `folderId` outranks `rootOnly` on the other end, so an id riding along under
    // Flatten would narrow the one thing Flatten exists to widen. Dropped rather than spelled as
    // `null` for the rule `text` already follows — a value the backend would infer anyway is not
    // put on the wire.
    folderId: flatten ? undefined : (folderId ?? undefined),
    // The root narrows now, and this is the field that says so: `folder_id IS NULL`, the copies
    // filed nowhere. Sent only where it is true, by the same rule — `false` is the backend's
    // default and a payload carrying it would be lying about intent.
    //
    // Both fields ride on `filters` rather than beside it because `useExportScope`'s sweep reads
    // this object: standing in a folder and pressing Export exports that drawer, and
    // `everythingFilters` strips the lot to widen the sweep back out. **That strip is still
    // sufficient here, and unlike the wishlist's it always will be — but the reason has changed
    // even though the conclusion has not.** It used to be sufficient because there was only one
    // field to strip; it is sufficient now because stripping *both* lands on absent + absent,
    // which is "every folder", which is exactly what "everything" means. The wishlist has to say
    // `flatten: true` a second way because its own strip lands on the root; this surface's strip
    // lands on the widest answer there is, so the widest answer stays the one you get by asking
    // nothing.
    rootOnly: !flatten && folderId === null ? true : undefined,
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
    setsParam?.join(",") ?? "",
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
    // Two folders are two lists, the root is a third and the flattened cabinet is a fourth: each
    // keeps its own cached pages and its own scroll position (`queryKeyString` below is what
    // resets it), rather than one list quietly showing another drawer's page while the new one
    // is still in flight.
    //
    // One segment with three shapes, and the two words cannot collide with a folder id because
    // `String(n)` is digits. **Flatten is read before the folder is**, which is the half worth
    // writing down: flattened, neither `folderId` nor `rootOnly` reaches the wire, so "flattened
    // while standing in the Binder" and "flattened at the root" are the *same request* and must
    // not become two cache entries for one answer.
    //
    // In `filterKey` rather than beside the sort, because it is a statement about *which rows* —
    // so the header's aggregates are re-run for the level on screen, which is the whole point of
    // a header that describes what is under it.
    flatten ? "flat" : folderId === null ? "root" : String(folderId),
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
    toggleColor: (key: ColorKey) => setColors((picked) => toggleColor(picked, key)),
    sets,
    toggleSet: (code: string) => setSets((picked) => toggleIn(picked, code)),
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
     * `true` ignores `folderId` and shows every copy regardless of filing — no folder cards, no
     * drill-down, and every row captioned with where it is filed instead. Also navigation, for
     * the reason `folderId` is: it says how much of the cabinet is on screen, not which copies
     * qualify.
     */
    flatten,
    /** Off shows the current folder; on shows the whole collection. */
    toggleFlatten: () => setFlatten((current) => !current),
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
    /** How many kinds of filter are on — the number on the Reset all badge. */
    activeCount: activeFilterCount({
      text,
      format,
      colors,
      sets,
      manaValues,
      manaX,
      rarities,
      priceMin,
      priceMax,
      finishes,
      conditions,
      needsReview,
    }),
    /** Clear every filter at once, including the search box. The sort is not a filter and
     *  stays: it is how the reader reads, not what they are looking at. `folderId` and `flatten`
     *  stay for the same reason — where they are standing, and whether they are ignoring the
     *  filing, are navigation rather than something they narrowed, so a Reset all must not march
     *  them back out of the drawer they opened or drop them out of Flatten. */
    resetAll: () => {
      setText("");
      setFormat("");
      setColors([]);
      setSets([]);
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
     * Identity of the current list, for anything that has to react to "this is a different
     * list now" — the scroll reset, above all. Derived from the query key itself rather
     * than rebuilt from the same fields, so the two cannot drift.
     */
    queryKeyString: JSON.stringify(listKey),
  };
}

/** The whole of what the view and its filter bar consume, named so the two agree. */
export type Collection = ReturnType<typeof useCollection>;
