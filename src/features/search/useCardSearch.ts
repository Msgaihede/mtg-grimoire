import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { ipc, type SearchResponse, type SearchSortKey } from "@/lib/ipc";
import { MANA_KEYS, type ManaKey } from "@/lib/mana";
import { applySort, type SortDir, type SortSpec } from "@/lib/sort";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { useCardFacets, type FacetRequest } from "./useCardFacets";

/** Rows per request. The backend clamps at 200; 50 is one screenful plus slack. */
export const PAGE_SIZE = 50;

/** How long the search box stays quiet before a keystroke becomes a query. */
export const DEBOUNCE_MS = 300;

/**
 * The `legalities` keys the format picker offers, in the order those keys rank — which is a
 * fact about the formats and **not** the order anybody sees.
 *
 * Every picker draws this through `sortOptions` (`@/lib/options`): alphabetically by `label`,
 * with the formats this search has nothing legal in sunk to the bottom. So reordering the
 * array below moves nothing on screen and only costs the keys their one written order — a
 * picker drawn wrong is a bug in that picker's `sortOptions` call, never in this list.
 */
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
 * One row of the format filter — the `legalities` key the backend filters by, and the word the
 * picker draws it as. Named for the *filter* rather than for a format, because
 * `useFormatSpecs.ts` already exports a `FormatOption` of `{ key, name }` for the deck's own
 * picker and the two are not the same shape.
 */
export interface FormatFilterOption {
  value: string;
  label: string;
}

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
  /** The X chip — "also the cards with `{X}` in their printed cost". The other half of the
   *  same question `manaValues` asks, which is why the two are counted as one kind below. */
  manaX: boolean;
  /** `false` is a filter too — "the cards I do *not* have" — so this is compared against
   *  `undefined` rather than tested for truthiness. */
  owned: boolean | undefined;
  /** One card, by its oracle id — "View all printings", handed over from another view. Empty
   *  is no filter, exactly as `format`'s empty string is. */
  oracleId: string;
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
    // One term, not two: the X chip rides *inside* the mana-value group and is OR'd with the
    // numerals, so "3 and X" is one thing that is on for the same reason three colours are.
    // It has to be in here at all, though — an X-only search with no term for it would count
    // zero, hide Reset all, and leave a reader who filtered into nothing with no way out.
    f.manaValues.length > 0 || f.manaX,
    f.owned !== undefined,
    // The narrowest filter this view has, and the one the reader did not set here — so it is
    // the one Reset all most has to admit to. A badge reading `0` over a wall holding one
    // card's printings would be the button lying about what pressing it does.
    f.oracleId.length > 0,
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

// `sortCurrency` is gone, and so is the `currency` parameter it fed. It existed to send the
// selected currency **only** when a money column was deciding the order, because everything
// else about a price was decided on this side off the twin fields every row carried. Rust now
// answers one price per row for the marketplace it was asked about, so the marketplace decides
// the source *and* the money *and* the order together, and it travels on every price-bearing
// query rather than on the ones that happen to be sorted by money. Two things could not
// disagree any more, so there is nothing left to keep in step.

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
 *
 * The one option is a **default** for the format filter, and default is the whole of what it
 * is: the reader can always move it, including to a format the deck they are building is not
 * legal in, and `Any format` never leaves the list. `SearchPage` passes nothing and gets
 * exactly the hook it always had.
 */
export function useCardSearch(
  options: {
    /**
     * The format the filter opens on, or `null`/absent for "Any format" — the caller's own
     * answer, which the deck editor derives from the open deck.
     *
     * The **caller's**, because only the caller knows whether the key it is holding is one the
     * database can answer: a key with no `legalities` behind it comes back as no rows at all,
     * which is indistinguishable on screen from a search that genuinely matched nothing, and
     * telling those keys apart takes the `format_specs` row the caller already has in hand. A
     * hook cannot make that judgement about a key it was handed, so it does not try; it seeds
     * what it is given, and the caller is the fence. `DeckEditor`'s `searchFormatDefault` is
     * where that fence is written down.
     */
    defaultFormat?: FormatFilterOption | null;
  } = {},
) {
  // Read once, and as a string rather than as the object: every caller builds that object
  // inline, so it is a new identity on every render and nothing may depend on it.
  const defaultFormatValue = options.defaultFormat?.value ?? "";
  // Which marketplace's prices this list is quoting. It is an input to the query rather than
  // a formatting choice: the backend prices the page with it, so it is in the key below and a
  // switch re-asks.
  const { marketplace } = useMarketplace();
  /**
   * "View all printings", waiting on the store — **read here, above the state it seeds, and
   * consumed further down.**
   *
   * Subscribed (`useAppStore(selector)`) rather than read through `getState()`, because one of
   * the ten surfaces that offers this is the search results themselves: a right-click there
   * changes no view and unmounts nothing, so a bare read would sit on an intent that nothing
   * ever re-rendered to notice. The other nine navigate, which mounts this panel fresh.
   *
   * The deck editor's docked panel calls this hook too and would be a second consumer, but
   * `requestAllPrintings` moves `activeView` in the same write — and that switch renders in an
   * ancestor of the editor, deleting it in the same pass.
   */
  const pendingCardSearch = useAppStore((s) => s.pendingCardSearch);
  const [text, setText] = useState("");
  // Seeded from the caller's default rather than from `""`, so the first request the panel
  // makes is already the filtered one — an empty seed corrected afterwards would send the
  // unfiltered search first and answer it, which is a wall of illegal cards and a second round
  // trip to replace it.
  //
  // A card the reader arrived here to look at beats that default, and beats it **in the seed**
  // rather than a render later: "show me every printing of this" cannot be answered through a
  // format filter, which would hide the printings from the sets this deck's format has never
  // been legal in. `appliedDefaultFormat` below still seeds to the default itself, so the guard
  // sees nothing changed and never puts it back — the same way `resetAll` sticks.
  const [format, setFormat] = useState(pendingCardSearch !== null ? "" : defaultFormatValue);
  /**
   * The default this filter is currently *sitting on*, so a changed default can be told from a
   * reader who happens to have picked the same key.
   *
   * React's adjust-state-during-render pattern, and deliberately **not** a `useEffect`. An
   * effect runs after the paint, so the panel would draw one frame of the previous deck's
   * filter and — worse — fire a whole request for it, which against a 116 k-row corpus is a
   * visible wall of the wrong cards. Setting state during render re-runs this component before
   * anything is committed, so the old filter never reaches the DOM or the query.
   *
   * It is also what applies a default that **arrives late**: `useFormatSpecs` is a query, so on
   * the first deck opened in a session this panel mounts before the seed has answered and the
   * default is `null` for a render or two. The seed above cannot catch that one; this does.
   *
   * Compared against the *applied* default rather than against `format`, which is what makes
   * `resetAll` stick: reset clears `format` and touches nothing here, so the default comes back
   * only when the **deck's** format changes, never a beat after the reader cleared it.
   */
  const [appliedDefaultFormat, setAppliedDefaultFormat] = useState(defaultFormatValue);
  if (defaultFormatValue !== appliedDefaultFormat) {
    setAppliedDefaultFormat(defaultFormatValue);
    setFormat(defaultFormatValue);
  }
  const [colors, setColors] = useState<readonly ColorKey[]>([]);
  const [sets, setSets] = useState<readonly string[]>([]);
  const [manaValues, setManaValues] = useState<readonly number[]>([]);
  // The other half of the mana-value question, and **additive rather than exclusive**:
  // Scryfall's `cmc` already counts `{X}` as zero, so `{X}{B}{B}{B}` answers the `3` chip and
  // this one both, and a reader who presses both finds it once. Its own state and not a
  // sentinel inside `manaValues`, because it is not a mana value.
  const [manaX, setManaX] = useState(false);
  const [owned, setOwned] = useState<boolean | undefined>(undefined);
  /**
   * One card, by its oracle id — every printing of it and nothing else.
   *
   * **The one filter on this row the reader did not set on this row.** It arrives from a card's
   * own menu, pressed in any of ten surfaces (see `pendingCardSearch` on the store), so the chip
   * that draws it is the only account the reader gets of why the wall is one card wide. A filter
   * like every other for the two things that matter: `activeFilterCount` counts it and
   * `resetAll` clears it.
   *
   * The **oracle** id rather than a printing id, because the question is "what is this card",
   * which is exactly the identity `cards.oracle_id` carries across every set it was printed in.
   *
   * **Seeded from the waiting intent, exactly as `format` is seeded from its default, and for a
   * reason the render-phase guard below cannot cover.** Nine of the ten surfaces navigate here,
   * so this panel *mounts* holding the intent — and a state adjusted during render does not
   * reach the mount request: React Query builds its observer inside a `useState` initialiser
   * from the first pass's options and subscribes with those, so the second pass corrects the
   * hook and not the fetch already on its way. Measured here: with the seed removed and only
   * the guard below in place, request zero goes out with no card on it at all — the unfiltered
   * 116 k-row browse, answered and then replaced, which is the whole thing this is meant to
   * avoid. The guard is what catches the tenth surface, where nothing mounts.
   */
  const [oracleId, setOracleId] = useState(pendingCardSearch?.oracleId ?? "");
  /**
   * The card's name, carried alongside the id purely so the chip can caption itself.
   *
   * Handed over by the surface that pressed the menu item — which had the card in hand — rather
   * than fetched: a filter that had to round-trip to `card_detail` to learn what to call itself
   * would draw blank, or wrong, for the length of that fetch.
   */
  const [oracleName, setOracleName] = useState(pendingCardSearch?.name ?? "");
  // Not a filter, and deliberately outside `resetAll`: clearing what you are looking at
  // should not also throw away the order you chose to read it in.
  const [sort, setSort] = useState<SortSpec<SearchSortKey>>([]);
  // A **view mode**, and outside `resetAll` for the same reason the sort is: clearing what
  // you are looking at should not also change *how* you are looking at it.
  //
  // Off is one row per card — 37 553 cards rather than 107 337 printings — because "which
  // cards exist" is the question a search box is asked, and "which printings exist" is the
  // question the card detail pane answers.
  //
  // On when a card was handed over, and seeded rather than switched on afterwards for the
  // reason `oracleId` is: "View all printings" is a request for exactly the other question, and
  // a mount that collapsed first would answer it with the single row the reader is opening up.
  const [allPrintings, setAllPrintings] = useState(pendingCardSearch !== null);
  // The other half of "which cards exist" — and, like `allPrintings`, a statement about the
  // shape of the corpus rather than a refinement of it, so it sits outside `resetAll` and
  // outside `activeFilterCount` beside it.
  //
  // Off is the default and off means *hidden*: a card legal in no format at all is an art
  // card, a token, an emblem or a piece of memorabilia, and a search for `lightning bolt`
  // that answers with three of them above the card is a search answering the wrong question.
  // `paperOnly` has hidden the digital printings on exactly this reasoning since the command
  // existed; this is the same rule for the printings no format allows.
  //
  // And on with a card in hand, seeded beside its neighbour: the art series and the promos are
  // printings of the card too, and they are most of what a reader opens this to look at.
  const [unplayable, setUnplayable] = useState(pendingCardSearch !== null);
  const [debouncedText, setDebouncedText] = useState("");

  /**
   * Take the waiting card, whether this panel mounted holding it or was handed it just now.
   *
   * **Applied during render and deliberately not in a `useEffect`** — React's
   * adjust-state-during-render pattern, the same one `appliedDefaultFormat` above uses and for
   * the same reason. An effect runs after the paint, so this panel would draw one frame of the
   * reader's previous filters and fire a whole request for them, which against a 116 k-row
   * corpus is a visible wall of the wrong cards followed by a second round trip to replace it.
   * Setting state during render re-runs this component before anything is committed, so the old
   * filters never reach the DOM.
   *
   * This is the **already-mounted** half — a right-click in the search results themselves,
   * where no view changes and nothing remounts. The mount half is the seeds above, which the
   * `useState` calls have already spent by the time this runs, so every setter here is a no-op
   * on that path and the branch costs one comparison.
   *
   * Clearing the filters is the whole of what "show me this card" means: a Modern filter would
   * hide the Vintage-only printings, playable-only would hide the art series, and collapsing
   * would answer with the one row the reader is trying to open up. `debouncedText` is cleared
   * beside `text` because it is 300 ms behind it — clearing only the box would leave the old
   * word ANDed with the card for a third of a second, which is a wall of nothing.
   *
   * **Consumed here rather than left for an effect**, so that a filter the reader has since
   * cleared cannot be re-applied by the next thing that re-renders this hook.
   */
  if (pendingCardSearch !== null) {
    useAppStore.getState().consumePendingCardSearch();
    setOracleId(pendingCardSearch.oracleId);
    setOracleName(pendingCardSearch.name);
    setText("");
    setDebouncedText("");
    setFormat("");
    setColors([]);
    setSets([]);
    setManaValues([]);
    setManaX(false);
    setOwned(undefined);
    setAllPrintings(true);
    setUnplayable(true);
  }

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
    // **A segment of its own, and the whole feature turns on it being here.** X is a second
    // axis over the same chips, so a key that carried only the numerals would answer "3, and
    // also X" out of the cached pages of plain "3" — instantly, from local SQLite, with no
    // spinner and nothing to notice. Spelled rather than stringified, like its neighbours.
    manaX ? "x" : "",
    // **A segment of its own**, like the X chip above and for the same kind of reason: this is
    // one card's printings against the whole corpus, and the two are different *rows*. A key
    // that carried only the visible filters would answer "every printing of Lightning Bolt" out
    // of the cached pages of the unfiltered browse the reader was looking at a moment ago —
    // instantly, from local SQLite, with no spinner and nothing to notice. The id is already a
    // string, so it is its own spelling; empty is the same "no filter" the payload sends as
    // `undefined`.
    oracleId,
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
    // Different *rows* again, for the same reason `allPrintings` is spelled rather than
    // stringified: the two modes are two answers and neither may be served from the other's
    // cached pages.
    unplayable ? "unplayable" : "playable",
    // **On every search, not only a price-ordered one.** The marketplace decides what the
    // Price column *contains* now, not merely how it is ordered — Card Kingdom's numbers come
    // out of a different table from TCGplayer's — so two marketplaces are two answers to the
    // same filters, and neither may be served from the other's cached pages.
    marketplace.id,
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
        // Absent rather than `false`, which is the backend's own default: an off chip is not
        // a filter, and sending one would make the payload lie about intent the way an empty
        // `text` would. `true` *widens* — it adds the `{X}` cards to whatever the numerals
        // matched — so it is only ever a statement, never a narrowing nobody asked for.
        manaX: manaX || undefined,
        // Sent only when it is set, so an untouched filter row produces exactly the payload
        // it always did. `false` is meaningful here and `undefined` is not sent at all.
        owned,
        // Dropped when empty, like `text` and `format` above: a blank id is not a filter, and
        // sending one would make the payload lie about intent.
        oracleId: oracleId || undefined,
        // Absent rather than `[]` when nothing is sorted, so an untouched table produces
        // exactly the payload it always did.
        sort: sort.length > 0 ? sort : undefined,
        // Always sent, unlike the filters above: it is not a refinement that can be left off,
        // it is which prices the page is quoting. The backend's default is `tcgplayer` and
        // this is often exactly that — sending it anyway keeps the payload and the query key
        // saying the same thing.
        marketplace: marketplace.id,
        // Absent rather than `false` when all printings are asked for: uncollapsed is the
        // backend's own default, and sending it would make the payload lie about intent —
        // the same rule `paperOnly` follows below.
        collapse: allPrintings ? undefined : true,
        // `paperOnly` is deliberately absent — omitted means true, which is the default
        // this view wants. Sending `true` explicitly would be the same request with more
        // ways to get it wrong.
        //
        // `playableOnly` is the opposite and is sent for exactly that reason: **its** default
        // is false, because every other caller of `search_cards` omits it and none of them
        // wants an art card dropped out of a list. So this view has to say so, and says it by
        // absence in the other direction — pressed means "show them", which is no filter.
        playableOnly: unplayable ? undefined : true,
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
   *
   * **`oracleId` is the one filter deliberately left out, and it is not a drift.** The counts
   * come from the in-memory index (`index/facets.rs`), which has no oracle axis to filter on —
   * sending it would mint a second facet key for an answer identical to the one without it. So
   * while the wall is narrowed to one card the counts describe the corpus that card was picked
   * out of, which **over**-counts, and over-counting only ever leaves a control live:
   * "not greyed" is this row's word for "we don't know" (`facets.ts`). Under-counting is the
   * direction that would grey a chip the reader could have used, and nothing here can produce it.
   */
  const facetReq: FacetRequest = {
    text: debouncedText || undefined,
    format: format || undefined,
    colors: colorsParam,
    sets: setsParam,
    manaValues: manaParam,
    // Spelled exactly as the page's payload spells it — `|| undefined` and not `manaX` —
    // because React Query hashes this object with its `undefined` values dropped: a bare
    // `false` would mint a second key for the search an untouched row has always had.
    manaX: manaX || undefined,
    owned,
    // A filter the facet counts must carry, unlike `collapse`: it decides which printings
    // exist for this search, so a count taken without it would offer a set or a mana value
    // that only art cards satisfy. Spelled exactly as the page's payload spells it.
    playableOnly: unplayable ? undefined : true,
  };
  const facets = useCardFacets(facetReq);

  const defaultFormatLabel = options.defaultFormat?.label;
  /**
   * The rows the format picker offers, which is {@link FORMATS} plus — when it is not already
   * one of them — the default itself.
   *
   * It has to be able to carry a key `FORMATS` does not list because the deck picker offers
   * every enabled `format_specs` row against this list's seven: a Brawl or an Oathbreaker deck
   * would otherwise open on a filter whose value no option holds, and a `<select>` given a
   * value none of its `<option>`s carry does not show it — it silently reports the first one,
   * so the panel would say `Any format` over a filtered wall of cards.
   *
   * **Depends on the two string fields and never on the object.** Every caller builds
   * `defaultFormat` inline, so the object is a fresh identity each render and a dependency on
   * it would rebuild this array — and therefore the picker's own memo below it — on every
   * keystroke in the search box. The option is rebuilt from the two strings for the same
   * reason, rather than closed over.
   */
  const formats = useMemo<readonly FormatFilterOption[]>(() => {
    // The **value** decides, because the value is what `format` above was seeded from: a row
    // fenced out for want of a label would leave the filter set to a key the picker cannot
    // draw, which is precisely the case this memo exists to prevent. A row is still a value
    // *and* a word, so a default carrying no word falls back to its key rather than putting a
    // blank line in the picker. Nothing reaches that fallback today — the one caller that sets
    // a default reads `spec.displayName` — and the two lines must not be able to disagree.
    if (!defaultFormatValue) return FORMATS;
    if (FORMATS.some((f) => f.value === defaultFormatValue)) return FORMATS;
    return [
      ...FORMATS,
      { value: defaultFormatValue, label: defaultFormatLabel || defaultFormatValue },
    ];
  }, [defaultFormatValue, defaultFormatLabel]);

  // **"Not the default", which is very nearly but not quite "the reader set it".** The name
  // says the intent and the comparison is what the state can answer: a format equal to the
  // default reads as unset however it got there. So a reader who presses Reset all on a
  // Commander deck's panel and then picks Commander back off the select counts as having asked
  // nothing, and an empty answer would be captioned "waiting for the sync" rather than "your
  // search missed". Telling those two apart would take remembering the press, which buys a
  // caption in a case that also needs the database to be empty.
  const formatIsReaderSet = format !== "" && format !== defaultFormatValue;

  return {
    text,
    setText,
    format,
    setFormat,
    /**
     * The rows the format picker draws, in the order the *keys* rank — which is a fact about
     * the formats and not the order anybody sees. Every picker sorts this through `sortOptions`
     * exactly as it sorted {@link FORMATS}, which is what it is when no default was passed.
     */
    formats,
    colors,
    toggleColor: (key: ColorKey) => setColors((picked) => toggleColor(picked, key)),
    sets,
    toggleSet: (code: string) => setSets((picked) => toggleIn(picked, code)),
    manaValues,
    toggleManaValue: (value: number) => setManaValues((picked) => toggleIn(picked, value)),
    /**
     * Also match the cards whose printed cost contains `{X}`.
     *
     * **Additive, never exclusive.** It is OR'd with the numeral chips exactly as they are
     * OR'd with each other, so pressing `3` and `X` asks for "costs 3, or has an X" and finds
     * `{X}{B}{B}{B}` once rather than twice. A filter for the purposes of `activeFilterCount`
     * and `resetAll`, and counted with `manaValues` as the one question the group asks.
     */
    manaX,
    toggleManaX: () => setManaX((on) => !on),
    /**
     * `true` narrows to printings the collection has an entry for, `false` to those it does
     * not, `undefined` asks nothing. **An entry, not a copy**: a row emptied to zero passes
     * `true` while its badge reads `×0` (see `SearchRequest.owned`).
     */
    owned,
    /** Off → owned → missing → off. The search asks "what have I already got" first. */
    toggleOwned: () => setOwned((current) => cycleTriState(current, true)),
    /**
     * The card this wall is narrowed to, or `""` — see the state above. A filter: counted by
     * {@link activeFilterCount} and cleared by `resetAll`.
     */
    oracleId,
    /**
     * The card's name, for the chip that draws the filter. Empty whenever {@link oracleId} is,
     * because the two are written together and cleared together — a name with no id is a
     * caption for a filter that is not on.
     */
    oracleName,
    /**
     * Set or clear the card filter. The only caller is the chip's own press, which clears it;
     * the only writer of a card is the intent above, which sets the name in the same render.
     *
     * Clearing takes the name with it rather than leaving it behind for the next card to
     * inherit — a wrapper rather than the bare setter, so "the name describes the id" is true
     * by construction instead of by every call site remembering to say so.
     */
    setOracleId: (id: string) => {
      setOracleId(id);
      if (id === "") setOracleName("");
    },
    /**
     * Show every printing rather than one row per card.
     *
     * `false` — one row per card — is the default. A view mode and not a filter, so it is
     * absent from {@link activeFilterCount} and survives `resetAll`.
     */
    allPrintings,
    toggleAllPrintings: () => setAllPrintings((on) => !on),
    /**
     * Show the printings no format allows — art series, tokens, emblems, memorabilia.
     *
     * `false` is the default, and it means they are **hidden**. Like {@link allPrintings}
     * this is a statement about which corpus the search runs over rather than a refinement
     * of the answer, so it is absent from {@link activeFilterCount} and survives `resetAll`:
     * clearing what you are looking for should not also change what there is to look through.
     */
    unplayable,
    toggleUnplayable: () => setUnplayable((on) => !on),
    /**
     * How many kinds of filter are on — the number on the Reset all badge.
     *
     * **Counts a default format, and the asymmetry with `unfiltered` below is deliberate.**
     * The two answer different questions about the same state. `unfiltered` asks *did the
     * reader ask anything of the database*, and a default nobody chose is not the reader
     * asking. This number captions **Reset all** and asks *how much would pressing this
     * change* — and a format filter that is on really is one thing it would clear. So a
     * Commander deck's panel opens reading `Reset all 1`, and pressing it goes to `Any
     * format`, which is the honest escape hatch rather than a badge lying about what the
     * button does.
     */
    activeCount: activeFilterCount({
      text,
      format,
      colors,
      sets,
      manaValues,
      manaX,
      owned,
      oracleId,
    }),
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
    /**
     * Clear every filter at once, including the search box.
     *
     * `format` goes to `""` and **not back to the deck's**: Reset all means "no filters", and a
     * button that put a filter back would be the one control on this row that cannot clear what
     * it captions. The clear also sticks — the re-seed guard above compares against
     * `appliedDefaultFormat`, which this does not touch, so the default returns when the deck's
     * format changes and never a render later on its own.
     */
    resetAll: () => {
      setText("");
      setFormat("");
      setColors([]);
      setSets([]);
      setManaValues([]);
      setManaX(false);
      setOwned(undefined);
      // The card goes with the rest, and the name goes with the card: it is a filter, however
      // it arrived, and the reader who presses this is asking for their search back. The
      // intent was consumed on arrival, so there is nothing left to re-apply it a render later.
      setOracleId("");
      setOracleName("");
    },
    /**
     * The marketplace every price on this view is quoted from — its label for the as-of
     * sentence and its currency for the formatter. The *numbers* were decided by the query
     * this is part of the key of.
     *
     * Handed on rather than read again in the view: one source means a header that names
     * TCGplayer over cells the backend priced at Card Kingdom cannot happen.
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
     *
     * A format the *caller* defaulted is not the reader asking, which is why this reads
     * `formatIsReaderSet` rather than `format`: a deck editor's panel over a database that has
     * not synced yet would otherwise caption its empty wall "try another word", and there is no
     * other word — there are no cards. That test is "the format differs from the default", with
     * the one consequence written at its definition above. With no default the two expressions
     * are identical, which is why `SearchPage` cannot notice the difference.
     */
    unfiltered:
      !debouncedText &&
      !formatIsReaderSet &&
      // A card the reader picked out of a menu is the reader asking, as plainly as a typed
      // word: an empty answer to it means this card is not in the database, not that nothing is.
      !oracleId &&
      !colorsParam &&
      !setsParam &&
      !manaParam &&
      !manaX &&
      owned === undefined,
  };
}

/** The whole of what `FilterBar` consumes — named so the component and its test agree. */
export type CardSearch = ReturnType<typeof useCardSearch>;
