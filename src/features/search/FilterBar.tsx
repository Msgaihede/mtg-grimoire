import { useId, useMemo, useState, type ReactNode } from "react";
import { ArrowUp } from "lucide-react";
import { motion } from "motion/react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import {
  ActiveFilterChip,
  FILTER_CONTROL,
  FILTER_FIELD,
  FILTER_FOCUS,
  FILTER_LABEL,
  filterChipState,
  FiltersButton,
  LayoutToggle,
  ManaChip,
  ManaValueChips,
  RarityChip,
  ResetAll,
  ToggleChip,
} from "@/components/FilterChips";
import { PriceRange } from "@/components/PriceRange";
import { useTooltip } from "@/components/tooltip/useTooltip";
import type { FacetResponse, SearchSortKey } from "@/lib/ipc";
import { MANA_KEYS, MANA_LABEL } from "@/lib/mana";
import { TRANSITION } from "@/lib/motion";
import { sortOptions } from "@/lib/options";
import { formatPrice } from "@/lib/prices";
import type { SortDir } from "@/lib/sort";
import { useAppStore } from "@/lib/store";
import { clearFieldOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { colorDisabled, countDisabled, facetTitle, optionDisabled } from "./facets";
import { SetCombobox } from "./SetCombobox";
import { TagQueryRow, type TagQuerySurface } from "./TagQueryRow";
import {
  ANY_CARD,
  SEARCH_SORT_OPTIONS,
  type ColorKey,
  type FormatFilterOption,
} from "./useCardSearch";

/**
 * The orders the picker offers, in the one order an option list in this app is drawn in:
 * alphabetically by the words on screen (`lib/options.ts`).
 *
 * Sorted once at module scope rather than inside a memo, unlike `formatOptions` below. Nothing
 * about a sort is faceted — an order that would hand back the same rows rearranged is still an
 * order worth offering — so there is no state here for the ordering to depend on.
 * `SEARCH_SORT_OPTIONS` is declared in the order the orders were reasoned about, which is the
 * author's notes rather than anything a reader can see.
 *
 * **`Best match` is pinned first and outside the sort**, because it is not a column to order by:
 * it is the search's own ranking, and on a browse — with nothing to be relevant to — the name
 * order that stands in for it. A reader reaching for the way back reaches for it blind, so it
 * stays at the top whatever the alphabet does to the rows below.
 *
 * **`Best match`, and never `Default order` again** (issue #213). That name said what the row
 * *was* in the state machine — the empty sort spec — instead of what it does, so a reader
 * browsing the alphabetical opening wall read it as the name of alphabetical order and reported
 * the label as wrong. It is not: with text in the box this row is FTS5's `bm25` with the name
 * column weighted ten times the type line and oracle text, and a search for `human` opens on
 * `Human Frailty` rather than on `A Girl and Her Dogs`. `Name` is the row that really is
 * alphabetical, and it sits two below this one — which is the whole of the fix: name each row for
 * the order it produces, and let the reader pick between them.
 *
 * The one state the name overshoots is the empty box, where there is no query to be relevant to
 * and the search falls back to name order (`search.rs`'s `ORDER_NAME`). Kept anyway: a row whose
 * label changed as the reader typed would be a control moving under them, and `Name` is right
 * there for anyone who wants alphabetical said out loud.
 */
export const SEARCH_SORT_ROWS: readonly { value: SearchSortKey | ""; label: string }[] = [
  { value: "", label: "Best match" },
  ...sortOptions(SEARCH_SORT_OPTIONS, (s) => s.label),
];

/**
 * Which captioned cells the tray draws, in the order it draws them.
 *
 * **Named rather than derived from what the surface can answer**, so a filter a surface has the
 * state for but does not mean to offer is an absent name here rather than a cell that appears
 * because a field happened to be wired. Each surface's list is written down where that surface is
 * mounted, which is the same rule the row itself has always followed: this file owns the layout,
 * the caller owns *which* filters it offers.
 */
export type TrayCell = "set" | "format" | "owned" | "decks" | "rarity" | "price" | "printings";

/** What the card search offers, which is every cell there is. The default, so the two surfaces
 *  that draw the whole tray say nothing. */
export const SEARCH_TRAY: readonly TrayCell[] = [
  "set",
  "format",
  "owned",
  "rarity",
  "price",
  "printings",
];

/**
 * What this row's own controls are **called**, and the `id` stem their labels bind through.
 *
 * **Two surfaces asking two different questions, so the box cannot carry one name.** The card
 * search's is over every printing Scryfall has published and the deck editor's Collection tab is
 * over the reader's own binder — "Search cards" standing over the second would be the control
 * lying about which list it narrows, and a `getByLabelText` could not tell the two apart on the
 * one screen that draws both.
 *
 * **The stem is what keeps two mounted rows from sharing an `id`.** A `<label for>` binds to the
 * *first* element with that id in the document, so two bars with one stem would put both labels on
 * one box and leave the other unnamed. Only one of these two is ever mounted at a time today — the
 * panel's tabs are two components and the search page is a different route — so this is a fence
 * rather than a fix, which is the right time to build one.
 *
 * The **sort** picker is deliberately not in here. `Sort results` has to be unambiguous *wherever*
 * this row is mounted, which is why it is not the bare `Sort` the deck's own toolbar draws — and
 * it says what it orders rather than what it is over, so it is right on both surfaces.
 */
export interface FilterLabels {
  /** Stem for every `id` this row hands out — `<stem>-text`, `-sort`, `-format`. */
  idStem: string;
  /** The search box's accessible name, and — with an ellipsis — its placeholder. */
  search: string;
}

/** The card search's, and the default. */
export const SEARCH_LABELS: FilterLabels = { idStem: "card-search", search: "Search cards" };

/**
 * Everything this row reads off the thing it is filtering — **a structural interface rather than
 * one hook's `ReturnType`**, which is what lets the deck editor's Collection tab draw the same
 * control over `collection_list`.
 *
 * It was `CardSearch` until 2026-08-25, and the argument for widening it is the one the app kept
 * losing: the two tabs of the deck editor's docked panel are two searches over two backends, and
 * a reader switching between them was meeting two different filter rows. The second was built out
 * of `@/components/FilterChips` the sanctioned way — which is still the right module boundary,
 * and is still how `CollectionFilterBar` is built — but *this* row and that one were the same
 * arrangement of the same controls written twice, and the two drifted the first time either
 * moved.
 *
 * **The optional half is the part each surface answers for itself**, and a cell is drawn only
 * when its own setter is here: a `tray` naming `owned` over a surface that cannot answer it draws
 * nothing rather than a control that does nothing. Everything above the line is required, because
 * everything above the line is on the bar at every width and on every surface.
 */
export interface FilterSurface<SortKey extends string = string> extends TagQuerySurface {
  text: string;
  setText: (text: string) => void;
  format: string;
  setFormat: (format: string) => void;
  /** The rows the format picker offers — the *surface's* own list and never the shared
   *  `FORMATS`, because it can carry a key that array does not: see `formatsWithDefault`, and
   *  the `<select>` trap it exists to prevent. */
  formats: readonly FormatFilterOption[];
  colors: readonly ColorKey[];
  toggleColor: (key: ColorKey) => void;
  sets: readonly string[];
  toggleSet: (code: string) => void;
  rarities: readonly string[];
  toggleRarity: (rarity: string) => void;
  manaValues: readonly number[];
  toggleManaValue: (value: number) => void;
  manaX: boolean;
  toggleManaX: () => void;
  priceMin: number | undefined;
  priceMax: number | undefined;
  setPriceRange: (min: number | undefined, max: number | undefined) => void;
  /** How many printings each option would leave, or `undefined` when that is not known — which
   *  is what a cold index, a failed query, the first render **and a surface with no facet command
   *  at all** all arrive as. `facets.ts` reads it as "we don't know" and leaves the row live. */
  facets: FacetResponse | undefined;
  /** Where the money is quoted from. The price cell's caption is this currency, which is what
   *  keeps `Price (USD)` from standing over a band in euros. */
  marketplace: { currency: "usd" | "eur" };
  activeCount: number;
  resetAll: () => void;
  sortSelection: SortKey;
  setSortKey: (key: SortKey) => void;
  /**
   * Which way the list runs, or nothing when it runs in an order that has no direction.
   *
   * **The surface's own answer rather than `sort[0].dir` read from here**, because the two
   * surfaces disagree about what an empty sort spec *is*: the search's is `Best match`, which is
   * a ranking and has no direction, and the collection's is name order, which has one. Derived
   * here, one of them would be drawn with a dead arrow.
   */
  sortDir: SortDir | undefined;
  flipSortDir: () => void;

  /** The Owned/Missing pair. Absent on a surface where every row is a copy the reader has. */
  owned?: boolean | undefined;
  setOwned?: (next: boolean | undefined) => void;
  /** The one-row-per-card switch. Absent where the rows *are* the reader's printings and folding
   *  them would hide which piece of cardboard is being moved. */
  allPrintings?: boolean;
  toggleAllPrintings?: () => void;
  /** `Not in a deck`. Absent on a surface with no deck to be in. */
  allocation?: "all" | "unallocated";
  setAllocation?: (next: "all" | "unallocated") => void;
}

/**
 * The rarities the tray offers, in the order a card is printed at them.
 *
 * **Not alphabetical, and this is `sortOptions`' second kind of exemption**: the order *is* the
 * information. Common through mythic is a scale, the same way Near Mint through Damaged is on
 * the collection's condition chips, and sorting it would put mythic between common and rare.
 *
 * Scryfall's own lower-case words, which is what `cards.rarity` stores and what the backend's
 * `IN` compares against — SQLite's `=` on text is case-sensitive, so a capitalised value here
 * would match nothing and read as an empty corpus. `CardIndex::RARITY_KEYS` is the same four in
 * the same order; the two lists are hand-mirrored like the rest of `ipc.ts`' contract.
 *
 * Four of Scryfall's six. `special` and `bonus` are real values with no chip and no bitset — a
 * printing at one of them is matched by no rarity filter, which is the same answer it gets from
 * a filter that names none.
 */
const RARITIES = ["common", "uncommon", "rare", "mythic"] as const;

/**
 * What the direction button says, spent twice — as its accessible name and as its `title`.
 *
 * It names the state **and** the press, because an arrow is the whole of what is drawn on that
 * button, and an arrow pointing up is read as "this is ascending" by one reader and "press to go
 * up" by the next. There is no visible text at all, so WCAG 2.5.3's "the name contains the
 * label" has nothing here to bind to.
 *
 * The out-of-reach reading names its reason instead of claiming a direction. At `Best match` the
 * list is ranked by relevance — and on a browse, with no query to rank against, by name — which
 * is neither ascending nor descending by any column the reader picked, and a button announcing
 * "ascending" over it would be describing a sort that is not there. **A `getByRole` on the exact
 * enabled string therefore fails on that row and reads as "the button is missing"**; match this
 * name on a prefix.
 *
 * It names the *row* and not "no order picked", which is what it said while that row was called
 * `Default order`. `Best match` is a row a reader deliberately picks, so "no order picked" would
 * be the button contradicting the select beside it.
 */
function sortDirectionName(dir: SortDir | undefined): string {
  if (!dir) return "Sort direction — Best match has no direction";
  return dir === "asc"
    ? "Sort direction: ascending — press for descending"
    : "Sort direction: descending — press for ascending";
}

/** A word with its first letter raised — the rarities and the colours are stored lower-case. */
function sentence(word: string): string {
  return word.replace(/^./, (c) => c.toUpperCase());
}

/**
 * Every filter this search is currently narrowed by, one chip per *kind*.
 *
 * **Kinds, and the same kinds `activeFilterCount` counts.** Three colours are one chip reading
 * `Colour: Blue, Red, Green` rather than three, because the number on Reset all and the number of
 * chips under the bar have to be the same number — a reader who sees `Reset all 3` over six chips
 * has been told two different things about one search.
 *
 * **The search box is deliberately not in here.** Every other filter can be off screen — inside a
 * shut tray, or scrolled out of a narrow column — and that is the whole reason this row exists.
 * The text box is on the bar at every width with the words still in it, so a chip repeating them
 * would be the one statement that says nothing the reader cannot already see.
 *
 * Each chip clears its whole kind, which is what makes it the inverse of the count: pressing one
 * takes exactly one off the badge.
 */
function activeChips<SortKey extends string>(
  search: FilterSurface<SortKey>,
  currency: "usd" | "eur",
): { label: string; remove: () => void }[] {
  const chips: { label: string; remove: () => void }[] = [];

  if (search.colors.length > 0) {
    chips.push({
      // `MANA_LABEL` rather than the letters: `Colour: W, U` is the payload, and the payload is
      // not what a reader picked — they pressed a white symbol and a blue one.
      label: `Colour: ${MANA_KEYS.filter((k) => search.colors.includes(k))
        .map((k) => MANA_LABEL[k])
        .join(", ")}`,
      remove: () => search.colors.forEach((c) => search.toggleColor(c)),
    });
  }

  if (search.manaValues.length > 0 || search.manaX) {
    // One chip for both, because they are one OR group and one entry in the count — see
    // `ManaValueChips`, where X rides at the end of the numerals for the same reason.
    const values = [...search.manaValues]
      .sort((a, b) => a - b)
      .map((v) => (v >= 8 ? "8+" : String(v)));
    if (search.manaX) values.push("X");
    chips.push({
      label: `Mana value: ${values.join(", ")}`,
      remove: () => {
        search.manaValues.forEach((v) => search.toggleManaValue(v));
        if (search.manaX) search.toggleManaX();
      },
    });
  }

  if (search.sets.length > 0) {
    chips.push({
      // Upper-cased, which is how a set code is printed on the card and how the picker's own rows
      // draw it. The list is short by construction — the picker caps at 64 and a reader picks two
      // or three — so it is spelled out rather than counted.
      label: `Set: ${[...search.sets].sort().map((c) => c.toUpperCase()).join(", ")}`,
      remove: () => search.sets.forEach((c) => search.toggleSet(c)),
    });
  }

  if (search.format.length > 0) {
    const label =
      search.format === ANY_CARD
        ? "Any card"
        : (search.formats.find((f) => f.value === search.format)?.label ?? search.format);
    // `Showing:` and not `Format:` for the widening row, because `Any card` is not a format — it
    // is the corpus this search is drawn from, and a chip reading `Format: Any card` would state
    // a format filter that is not on.
    chips.push({
      label: search.format === ANY_CARD ? `Showing: ${label}` : `Format: ${label}`,
      remove: () => search.setFormat(""),
    });
  }

  if (search.rarities.length > 0) {
    chips.push({
      label: `Rarity: ${RARITIES.filter((r) => search.rarities.includes(r))
        .map(sentence)
        .join(", ")}`,
      remove: () => search.rarities.forEach((r) => search.toggleRarity(r)),
    });
  }

  // The setter and not the value, because `owned`'s own third state *is* `undefined`: a surface
  // that cannot ask this question is told apart from one that is not currently asking it by which
  // of the two fields is here at all.
  const { setOwned } = search;
  if (setOwned && search.owned !== undefined) {
    // The word the chip in the tray carries, so the statement and the control that made it use
    // one vocabulary.
    chips.push({
      label: search.owned ? "Owned" : "Missing",
      remove: () => setOwned(undefined),
    });
  }

  if (search.priceMin !== undefined || search.priceMax !== undefined) {
    const low = search.priceMin === undefined ? null : formatPrice(search.priceMin, currency);
    const high = search.priceMax === undefined ? null : formatPrice(search.priceMax, currency);
    // Three sentences rather than one with an em dash and a hole in it: `Price: – $40` is a range
    // missing an end, where `Price: up to $40` is the filter said in words.
    const label =
      low !== null && high !== null
        ? `Price: ${low} – ${high}`
        : low !== null
          ? `Price: from ${low}`
          : `Price: up to ${high}`;
    chips.push({ label, remove: () => search.setPriceRange(undefined, undefined) });
  }

  return chips;
}

/**
 * Every filter the search view offers — four controls on the bar, the rest in a tray, and the
 * search itself stated in words underneath.
 *
 * **The shape is the feature.** The row used to be every control this view has, wrapped: at a
 * standard window that was two ragged lines of twelve controls, and the reader's own filters were
 * a gold border here and a lit chip there, spread across all of it. Four things are on the bar at
 * every width — the box you type in, the colours, the mana values, and the order the results come
 * in — because those are the four a reader reaches for without looking. Everything else is behind
 * one button, and what is *on* is stated as chips under a rule, where a search can be read in a
 * glance and undone one filter at a time.
 *
 * **It lays out by its own width and not the window's**, which is what `@container` is here for.
 * The same component is the search page's bar across a maximised window and the deck editor's
 * docked panel at 384px — draggable down to 206 — so a media query would be answering a question
 * about the wrong box. The four breakpoints are 640, 900 and 1500, and each is the width at which
 * a line's own contents stop fitting rather than a device.
 *
 * The colour chips are the app's one deliberate splash of colour and the reason the rest of the
 * chrome stays grey: a real mana symbol on its authentic printed fill is recognisable at 36px to
 * anyone who has held a card, in a way that a letter in a coloured circle is not. Everything else
 * here is quiet on purpose — outlined, mono, grey — so that the one thing the eye lands on is
 * which colours are switched on.
 *
 * The controls themselves live in `@/components/FilterChips`, which the collection view builds
 * its own row out of. This file owns the layout and *which* filters the search offers.
 *
 * Not every control on it is a filter. The sort picker, the printings mode and the layout pair
 * each say how the results are *shown* rather than which ones there are — so none of them is
 * counted by the Reset all badge or cleared by pressing it, and the sort in particular is one
 * piece of state shared with the table's headers rather than something this row owns.
 */
export function FilterBar<SortKey extends string>({
  search,
  sortRows = SEARCH_SORT_ROWS as readonly { value: SortKey; label: string }[],
  tray = SEARCH_TRAY,
  labels = SEARCH_LABELS,
  layoutToggle = true,
  layoutFor = "search",
}: {
  search: FilterSurface<SortKey>;
  /** What this surface calls its search box, and the `id` stem its labels bind through — see
   *  {@link FilterLabels}. Defaults to {@link SEARCH_LABELS}. */
  labels?: FilterLabels;
  /**
   * The rows the order picker offers, **pinned row included** — see {@link SEARCH_SORT_ROWS},
   * which is the default and carries the reasoning for the one that is pinned.
   *
   * A prop rather than a constant because the two surfaces order by different things: the card
   * search ranks by relevance and offers a `Best match` row that is the *empty* spec, and a
   * collection has no ranking to fall back to and every row of its picker is a real column. One
   * array covering both would have to hold a row one of them cannot act on.
   */
  sortRows?: readonly { value: SortKey; label: string }[];
  /**
   * Which captioned cells the tray draws — see {@link TrayCell}. Defaults to
   * {@link SEARCH_TRAY}, so the two surfaces that offer every filter say nothing.
   */
  tray?: readonly TrayCell[];
  /**
   * Whether the grid-or-table pair rides the row.
   *
   * Off in the deck editor's docked panel, which is a wall of art and has no table to switch
   * to: the toggle there would move the *search view's* stored preference and change nothing
   * the reader can see, which is a control that lies. Everything else on the row is a
   * statement about which cards to show and means the same thing in both places.
   */
  layoutToggle?: boolean;
  /**
   * **Whose** stored layout preference that pair moves.
   *
   * The same hazard `layoutToggle={false}` answers for the deck panel, read from the other end:
   * a second page drawing this row would otherwise move the search view's preference, changing
   * nothing a reader can see here and silently re-laying-out a page they are not on. Each page
   * with a wall keeps its own field for the reason `store.ts` splits the other three.
   *
   * A **section name** rather than a `view`/`onChange` pair, so the binding is one prop that
   * cannot be passed half — and so the store read stays inside {@link ViewToggle}, where a
   * component that re-renders on a preference nothing above it reads costs the filter row
   * nothing.
   *
   * **A closed union widened by hand, where `ZoomSection` and `ViewId` are derived** — so a
   * third page with a wall of its own has to add its name here as well as to the store. That is
   * the intended cost rather than an oversight: the two are not the same list (a zoom section
   * exists for the printings modal, which draws no filter row) and deriving one from the other
   * would tie a page's *layout* preference to whether it happens to be zoomable. Two entries is
   * too few to be worth a mechanism; at four, derive it.
   */
  layoutFor?: "search" | "tags";
}) {
  /**
   * Whether the tray is open, and **this component's own state rather than the store's.**
   *
   * A stored preference would be shared by the two surfaces that draw this bar, which are on
   * screen together in the deck editor — opening the panel's tray would open the search page's
   * behind it. It is also the kind of state a reader re-decides every time they look: the tray is
   * one press away and its button says how much is behind it, so remembering the answer buys
   * nothing and costs a `app_meta` row and a migration.
   */
  const [trayOpen, setTrayOpen] = useState(false);
  const trayId = useId();
  /**
   * How many printings each option would leave, or `undefined` when that is not known.
   *
   * Every control below reads it through `facets.ts`, which is where the rule lives:
   * greyed means "turning this on would not change the result set", not-greyed means "we
   * don't know" — so `undefined` here leaves the whole row live, which is what a cold index,
   * a failed query and the first render all arrive as.
   */
  const facets = search.facets;
  /**
   * The formats in the order the dropdown draws them: **pickable first, greyed last, each
   * half alphabetical by the word on screen.**
   *
   * **The list is the search's own (`search.formats`) rather than the shared `FORMATS`, and it
   * can be longer than that array.** The hook answers with those keys plus its caller's default
   * format whenever that one is not among them — the deck editor's docked panel opens on the
   * format of the deck being edited, and a deck can be in a format this picker has never
   * offered. That extra key is not decoration: **a `<select>` whose `value` matches no
   * `<option>` does not draw blank — it silently reports the first one.** React never assigns
   * `select.value` for a controlled select; `react-dom` walks the options setting `selected`,
   * and on no match it selects the first row that is not disabled — which since the `Unplayable`
   * chip was merged in is the pinned `Any card`, the **widest** row this control has. So the
   * control would read "every card, art cards included" while the filter it names goes on
   * narrowing the results underneath, which is a control that lies about the list beside it —
   * and it lies further than it used to, because the row it now falls back to is not merely a
   * different filter but the opposite end of the one it is on. The options therefore have to
   * come from whoever owns the value, and a constant imported here could only ever be right for
   * the callers that never set one.
   *
   * The seeded key is a format like every other once it arrives: it sorts into the alphabet by
   * its label, greys by its own facet count, and is pinned by nothing. `Any card` and `Any
   * format` are the two rows that stay outside the sort, because they are the two rows that are
   * not formats.
   *
   * Alphabetical because a reader hunting for "Modern" hunts under M. `FORMATS`' own order is
   * roughly how the formats rank, which is knowledge this control never shows and which no two
   * players would write down the same way — so it stays a fact about the keys and stops being
   * a layout. The greyed half sinks rather than disappearing: a format nothing in this search
   * is legal in is still worth offering (it says the search has nothing there), and dropping it
   * would make the list jump under the cursor each time the facets land, which is the same
   * reason `SetCombobox` greys instead of filtering.
   *
   * Each option's disabled state is decided once and spent twice — as the grouping level and
   * as the attribute — because the two are the same question and `optionDisabled`'s "a
   * selected option is never greyed" arm is exactly where they must not disagree: the format
   * the reader picked stays in the pickable half however its own count reads, so the way out
   * of a dead end never sinks below the rows the reader cannot use.
   *
   * With no facets at all `optionDisabled` is false for every key, so both halves collapse
   * into one plain alphabetical list without a branch for it.
   *
   * **Belt and braces since the 2026-08-25 move to `<Dropdown>`, not the only defence any
   * more.** The shell no longer falls back to a wrong row on an unmatched value the way the old
   * `<select>` did — it draws its own placeholder dash instead (`DEFAULT_PLACEHOLDER`,
   * `Dropdown.tsx`) — but a dash reading "no format at all" while a seeded format goes on
   * narrowing the results underneath is still a control that lies about the list beside it, just
   * a quieter lie than `Any card`'s. The list still has to come from whoever owns the value.
   */
  const formatOptions = useMemo(
    () =>
      sortOptions(
        search.formats.map((f) => ({
          ...f,
          disabled: optionDisabled(facets?.formats, f.value, search.format === f.value),
        })),
        (f) => f.label,
        (f) => [f.disabled ? 1 : 0],
      ),
    [facets?.formats, search.format, search.formats],
  );
  // Which way the list runs, or nothing when it runs in an order that has no direction. **The
  // surface's own answer** — it was derived here from `sortSelection === ""` until 2026-08-25,
  // which is a rule about the card search's empty spec and not about a sort. See
  // {@link FilterSurface.sortDir}.
  const sortDir = search.sortDir;
  const tip = useTooltip();
  const currency = search.marketplace.currency;
  const chips = activeChips(search, currency);
  /**
   * **Every row comes from the prop, pinned one included** — see {@link SEARCH_SORT_ROWS}, which
   * is the default and carries the argument for the row that is pinned. It was written into this
   * markup until 2026-08-25, which made `Best match` a fact about the *control* rather than about
   * the search behind it; the collection has no ranking to fall back to and every row of its
   * picker is a real column, so a hard-coded first row would be a destination one of the two
   * surfaces cannot go to.
   *
   * No row is ever `disabled` here, unlike the collection page's `Custom…` — the two look alike
   * and are opposites. That one is a state the control can only be *put* into, from a header this
   * picker has no option for. Every row of this one is a real destination.
   */
  const sortDropdownOptions: readonly DropdownOption[] = sortRows.map((s) => ({
    value: s.value,
    label: s.label,
  }));

  return (
    // **A named container, and the name is what keeps it from being claimed by another.**
    // `@container` variants bind to the nearest ancestor container, so an unnamed one here would
    // be the box any future `@container` in a card tile or a panel resolved against. Everything
    // below reads `/fb` explicitly.
    <div className="@container/fb flex flex-col gap-2">
      {/*
        **One flex container for both lines, ordered rather than duplicated.**

        The obvious build is a `<div>` per breakpoint with `hidden` on the ones that do not
        apply — and it puts two mana-value groups and two sort pickers in the tree at once, which
        is two controls with one accessible name, two tab stops for one filter, and a
        `getByLabelText` that starts throwing "found multiple". So the items are written once and
        the arrangement is `order` plus a `basis-full` spacer that forces a line break. The order
        numbers below are the whole layout; each item carries its own.

        The gaps close as the box narrows — 12px, 10px, 8px — because at 640 the same gaps that
        gave a 1500px bar its air are what tip the second line into a third.
      */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 @min-[640px]/fb:gap-x-2.5 @min-[900px]/fb:gap-x-3">
        {/* The name is the surface's — see {@link FilterLabels}, and the two questions it keeps
            apart. */}
        <label htmlFor={`${labels.idStem}-text`} className="sr-only">
          {labels.search}
        </label>
        <input
          id={`${labels.idStem}-text`}
          type="search"
          value={search.text}
          onChange={(e) => search.setText(e.target.value)}
          // Escape empties the box while there is something in it to empty, and falls through
          // when there is not. Chromium clears an `<input type="search">` by itself but leaves
          // `defaultPrevented` false, so on a view where Escape also means "go back" the same
          // press would do both — and this row is the deck editor's docked panel as well as the
          // search page's. jsdom implements no native clear at all, so the handler is also the
          // only half of the behaviour a test can see. The rule is {@link clearFieldOnEscape}'s.
          onKeyDown={(e) => clearFieldOnEscape(e, search.text, () => search.setText(""))}
          // The accessible name with an ellipsis, so the two say the same thing — a placeholder
          // that differed from the label would be two names for one box.
          placeholder={`${labels.search}…`}
          // `FILTER_FIELD` and not `FILTER_CONTROL`: the row's chips dip 3% under the press and
          // a box the reader types into must not, or the native ✕ slides out from under the
          // pointer clearing it. Issue #179 — the reason is on the constant.
          //
          // **A whole line to itself below 640** (`basis-full`), which is the one control here
          // that earns it: it is the only one whose usefulness scales with its width, and in a
          // 206px panel a box sharing a line with six colour chips is four characters wide.
          // Above that it is `flex-1` again and capped, so a maximised window does not hand it
          // half the bar.
          className={cn(
            FILTER_FIELD,
            FILTER_FOCUS,
            "order-[1] min-w-0 basis-full border-border bg-surface px-3 placeholder:text-dim focus:border-accent",
            "@min-[640px]/fb:max-w-[min(34%,460px)] @min-[640px]/fb:flex-1 @min-[640px]/fb:basis-48",
          )}
        />

        {/* Wider than the other groups' `gap-1`: a pressed chip's ring reaches 4px past its
            edge, and at 4px apart two pressed chips look like one welded object.

            `flex-wrap` for the narrowest surface's sake — the panel's floor is 206px, where six
            chips at 246 do not fit a line and an unwrapped group would hang out of the panel
            and put a horizontal scrollbar across the whole deck builder. */}
        <div role="group" aria-label="Color identity" className="order-[2] flex flex-wrap gap-1.5">
          {MANA_KEYS.map((key) => (
            <ManaChip
              key={key}
              symbol={key}
              pressed={search.colors.includes(key)}
              // The one control on this row that does not ask "would this return nothing".
              // `colors` is subset semantics, so pressing a chip with another already on
              // *broadens* — the count is the size of the result set after the press, read
              // against `facets.total`. And that total is the facets' own: printings, exact,
              // and not the collapsed, capped number the results caption prints.
              disabled={colorDisabled(
                facets?.colors[key],
                facets?.total ?? 0,
                search.colors.includes(key),
              )}
              title={facetTitle(MANA_LABEL[key], facets?.colors[key])}
              onClick={() => search.toggleColor(key)}
            />
          ))}
        </div>

        {/* The empty flex item that pushes everything after it to the right end of its line. At
            1500 it separates the mana values from Filters; below that, the colours from Filters.
            Gone below 640, where the Filters button takes the rest of the colours' line itself. */}
        <div aria-hidden="true" className="order-[4] hidden flex-1 @min-[640px]/fb:block" />

        <FiltersButton
          open={trayOpen}
          count={search.activeCount}
          onToggle={() => setTrayOpen((open) => !open)}
          controls={trayId}
          // The word appears at 900 rather than at 640, because it is the widest thing in the
          // right-hand group and the second line has to hold the mana values at their full 396px
          // before it holds anything else.
          labelClass="hidden @min-[900px]/fb:inline"
          // Fills what the colours leave of its line below 640, where there is no spacer to push
          // it right and a 44px button floating beside six chips reads as a seventh chip.
          className="order-[5] flex-1 @min-[640px]/fb:flex-none"
        />

        {/* A hairline between the filters and the two controls that are not filters. Only at the
            widest, where the sort sits on this line and would otherwise read as one more thing
            the tray is about. */}
        <div
          aria-hidden="true"
          className="order-[6] hidden h-9 w-px bg-border @min-[1500px]/fb:block"
        />

        {/* The sort, from the other end of the state the table's headers already drive. Picking
            here *replaces* the sort with that one term; the headers refine and extend it. So the
            picker follows a header press and a header's arrow follows the picker — one piece of
            state with two controls on it.

            **Drawn in both layouts and on both surfaces, which is the whole of the feature.** The
            grid has no headers to press, and the deck editor's docked panel is a grid with no
            table to switch to at all — so `layoutToggle` is deliberately not the fence. That prop
            says "this surface has no second layout", which names exactly the surface with no other
            way to sort; fencing on it would take the control away from the one place it is the
            only one.

            **On the bar rather than in the tray, which is the one thing here that is not a
            filter and is on it anyway.** A list is always in some order, so a reader who wants a
            different one is not narrowing — they are reading — and a control behind a disclosure
            called Filters would be the wrong cupboard.

            The pair is boxed rather than left to the row's own gap, which would stand the arrow
            12px off the order it belongs to and let `flex-wrap` break the two onto separate lines
            — a direction with its order on the line above is a button about nothing. 4px apart,
            like the layout pair at the far end of the row.

            It costs the docked panel nothing at its 206px floor, for a different reason since the
            2026-08-25 move to `<Dropdown>`. The old `<select>` was as wide as its widest option
            — `Best match` and `Mana value`, both ten characters, the same count as the `Any
            format` in the tray — measured at 119px against the built stylesheet with the app's
            own fonts loaded (2026-08-24), a floor no narrow panel could shrink under whichever
            row was picked. A `<Dropdown>` trigger sizes to its own **picked** text instead, never
            to the widest row it could show, so it is narrower than that measurement for every
            order shorter than the widest and the docked panel has more headroom than it used to
            need rather than exactly as much. **Below 640 it still does not have to fit
            anything** — the trigger is `flex-1` on a line of its own, so neither sizing rule
            matters at the panel's floor, and the break at `order-[28]` above is what makes that
            line its own. */}
        <div className="order-[30] flex min-w-0 flex-1 items-center gap-1 @min-[640px]/fb:flex-none @min-[1500px]/fb:order-[7]">
          {/* **`Sort results`, and never shortened back to `Sort`.** The collection's twin is a bare
              `Sort` and this one may not copy it, because this row is drawn on two surfaces and one
              of them already has a `Sort`: the deck editor's toolbar sorts **the deck**, this sorts
              **the search results**, and with the docked panel open both lists are on screen at
              once. Two controls with one name is not a WCAG failure — it is a control that cannot
              be addressed unambiguously, by a screen reader walking the form, by anyone driving the
              app by voice, or by a `getByRole("button", { name: "Sort" })` that starts throwing
              "found multiple".

              The widening goes here rather than on the deck editor's label for the reason that
              decides every one of these: that one has only to be unambiguous where it is mounted,
              and this one has to be unambiguous *wherever* it is. `PrintingsFilterBar.tsx:380` made
              the same call and wrote down the same trap — a bare verb names an action and not the
              thing it acts on, which is why it draws `Sort printings by` and not `Sort by`. */}
          <label
            id={`${labels.idStem}-sort-label`}
            htmlFor={`${labels.idStem}-sort`}
            className="sr-only"
          >
            Sort results
          </label>
          <Dropdown
            id={`${labels.idStem}-sort`}
            labelledBy={`${labels.idStem}-sort-label`}
            value={search.sortSelection}
            onChange={(key) => search.setSortKey(key as SortKey)}
            options={sortDropdownOptions}
            // **Never gold** — no `active` passed, unlike the format picker in the tray. Accent
            // there means "this is not where the control opens", which is a state a filter can be
            // in and out of. A list is always in *some* order, so a sort cannot be inactive — and
            // a gold sort picker would be saying "a filter is on" about the one control on this
            // row that is not a filter, and that Reset all deliberately does not clear.
            className="min-w-0 flex-1 @min-[640px]/fb:flex-none"
          />

          {/* One arrow, turned over — never `ArrowDown` swapped in for `ArrowUp`. That is the rule
              `SortableHeader.tsx:51-55` states and this is the reason it states it: a different
              element in the same slot is unmounted and remounted, so the indicator *teleports*,
              and the whole of what the press means is that the order reversed. Half a turn is that
              fact, drawn. `initial={false}`, so a row that opens already descending draws its
              arrow turned rather than spinning on first paint — the header's rule, for the
              header's reason.

              `rotate` is a transform prop, so `MotionConfig reducedMotion="user"` reaches it and
              no `useReducedMotion` opt-out is owed here (`docs/reference/motion.md` — the trap
              there is the *non*-positional properties, and this animates none).

              **The real `disabled`, and the row's `aria-disabled` rule does not bind.** That rule
              is about a filter row greying *as the reader types*, where a control leaving the tab
              order would shrink the row out from under a keyboard caret. This one can only grey
              when the reader themselves puts the select back to `Best match`, and their caret
              is on that select when they do it — the button never vanishes from under the thing
              focusing it. */}
          {/* **Wrapped, for the same reason `AllPrintingsDialog`'s end-of-walk chevron is.**
              `aria-label` already carries the whole sentence, so the tooltip is `describes: false`
              — pure redundancy for a pointer, which is the state this button spends most of a
              default search in: `disabled={!sortDir}`. A `disabled` control fires no pointer
              events at all, so `{...tip()}` bound to the button directly would be silently inert
              in exactly the state a reader is likeliest to hover it, which is a real loss rather
              than a no-op (Chromium still draws a native `title` on a disabled control today). The
              wrapper adds no box beyond the button's own, so an enabled press and an enabled hover
              both work exactly as before. */}
          <span {...tip(sortDirectionName(sortDir), { describes: false })}>
            <button
              type="button"
              onClick={search.flipSortDir}
              disabled={!sortDir}
              aria-label={sortDirectionName(sortDir)}
              className={cn(
                FILTER_CONTROL,
                FILTER_FOCUS,
                "flex size-9 items-center justify-center",
                // Not `aria-pressed`, and never gold: descending is not a filter switched on, it is
                // the other half of a control that is always doing something. `filterChipState`'s
                // unpressed arm is what every other quiet control on this row wears, and its
                // `unavailable` arm is the row's one greying treatment rather than a second one
                // written next to it.
                filterChipState(false, !sortDir),
              )}
            >
              {/* `flex` on the span is load-bearing and not decoration: a bare `<span>` is a
                  non-replaced inline box, a transform does not apply to one at all, and the rotation
                  would silently do nothing. `SortableHeader` carries the same class for the same
                  reason. */}
              <motion.span
                aria-hidden="true"
                initial={false}
                animate={{ rotate: sortDir === "desc" ? 180 : 0 }}
                transition={TRANSITION.fast}
                className="flex"
              >
                <ArrowUp className="size-4" />
              </motion.span>
            </button>
          </span>
        </div>

        {/* The second hairline, before the layout pair — drawn wherever that pair is, because it
            is what says the two icons are about the drawing rather than about the cards. */}
        {layoutToggle && (
          <div
            aria-hidden="true"
            className="order-[8] hidden h-9 w-px bg-border @min-[640px]/fb:block"
          />
        )}

        {/* A view mode rather than a filter, so it sits past the divider with the sort rather than
            among the statements about which cards to show — and, like them, it is untouched by
            Reset all. */}
        {layoutToggle && <ViewToggle section={layoutFor} />}

        {/* **The line break.** A `basis-full` flex item consumes the rest of its line, so
            everything ordered after it starts a new one. Gone at 1500, where the whole bar is one
            line and the items after it fold back into their places between `order-[2]` and
            `order-[8]`. */}
        <div aria-hidden="true" className="order-[10] h-0 basis-full @min-[1500px]/fb:hidden" />

        {/* The mana values, and the one control whose *size* moves with the breakpoint. */}
        <div className="order-[20] flex min-w-0 @min-[1500px]/fb:order-[3]">
          <ManaValueChips
            // **32px below 640 and the family's 36 above it**, which buys exactly one line: ten
            // chips at `gap-1` are 396px at 36 and 356 at 32, and the deck panel's 384px default
            // leaves ~371 of content. `flex-wrap` inside the group is still what makes the
            // panel's 206px floor safe — this is a fit, never a fence.
            chipClass="size-8 @min-[640px]/fb:size-9"
            selected={search.manaValues}
            onToggle={search.toggleManaValue}
            disabled={(value) =>
              optionDisabled(facets?.manaValues, String(value), search.manaValues.includes(value))
            }
            // The chip hands its own label back, so "8 or more" is spelled in one place.
            title={(value, label) => facetTitle(label, facets?.manaValues[String(value)])}
            xSelected={search.manaX}
            onToggleX={search.toggleManaX}
            // `manaX` is a **field** of the facet response beside `manaValues` rather than a key
            // inside it, so this reads a bare count — and `countDisabled` is the same rule the
            // nine chips to its left grey by rather than a second one written next to it. Rust
            // counts it off the same `Skip::Mana` base, so X greys when and only when its
            // neighbours would: because nothing in this search has one.
            xDisabled={countDisabled(facets?.manaX, search.manaX)}
            xTitle={(label) => facetTitle(label, facets?.manaX)}
          />
        </div>

        {/* Pushes the sort to the right end of the second line. Hidden at 1500, where there is no
            second line and this item would land past the layout toggle. */}
        <div
          aria-hidden="true"
          className="order-[25] hidden flex-1 @min-[640px]/fb:block @min-[1500px]/fb:hidden"
        />

        {/* **The second break, and it is a fix rather than a tidy.** Below 640 the sort is
            `flex-1` so it can fill a line of its own; without this it instead shares the mana
            values' line wherever one is left over, and `flex-1` then makes it take *whatever is
            left* — which between about 360 and 560 of container is a handful of pixels. The div
            shrinks (it carries `min-w-0`); the 36px direction button inside it cannot, so it
            spills out of the panel, and `DeckEditor`'s page section computes `overflow-x` to
            `auto` and draws a horizontal scrollbar across the whole deck builder. Measured at a
            369px container before this existed: the sort was allotted **5px** and overflowed by
            **53**. The panel is draggable from 206, so that band is reachable by a drag.

            Above 640 it is gone and the sort is `flex-none`, which is what makes the second line
            safe there without a break: an item that cannot be crushed *wraps* instead. */}
        <div
          aria-hidden="true"
          className="order-[28] h-0 basis-full @min-[640px]/fb:hidden"
        />
      </div>

      {trayOpen && (
        <FilterTray
          id={trayId}
          search={search}
          cells={tray}
          labels={labels}
          formatOptions={formatOptions}
        />
      )}

      {/*
        **The search, in words — and the row is drawn whether or not there is anything in it.**

        Reset all lives here now, and its own rule is why the row is unconditional: it is always
        drawn and greyed at zero, because a control that appears mid-press moves everything beside
        it. What changed is *which* things it would move. On the bar it took its width out of a
        `flex-1` search box and slid nine colour chips left under the finger that had just pressed
        one; under a rule below every control, an appearing chip moves only the wall of cards, and
        a wall that has just been re-queried is moving anyway.
      */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {chips.length > 0 && (
          // Only when there is something to caption. `Filtering by` over an empty row is a
          // sentence with nothing after it.
          <span className={cn(FILTER_LABEL, "shrink-0")}>Filtering by</span>
        )}
        {chips.map((chip) => (
          <ActiveFilterChip key={chip.label} label={chip.label} onRemove={chip.remove} />
        ))}
        {/* A whole line of its own below 640 and the right end of this one above it. `grid`
            rather than `block` so the button stretches, and the arbitrary variant is what centres
            its label once it has — `ResetAll` is `inline-flex` and would otherwise leave its two
            words against the left edge of a 200px button.

            **First when it is stacked, last when it is not**, which is the design's own call and
            has a reason worth keeping: below 640 the chips wrap onto two and three lines as the
            reader narrows, and a full-width button under them moves every time one does. Above
            640 it is at the end of the line, where `ml-auto` holds it against the right edge and
            the chips grow leftwards away from it. Either way it does not move under the press. */}
        <div className="order-first grid basis-full [&>button]:justify-center @min-[640px]/fb:order-none @min-[640px]/fb:ml-auto @min-[640px]/fb:block @min-[640px]/fb:basis-auto">
          <ResetAll count={search.activeCount} onReset={search.resetAll} />
        </div>
      </div>

      {/* The chips a typed `o:ramp` produces, and the note an unknown tag name gets. Under the
          stated filters rather than among them: these are the *query's* own terms, which the box
          above still holds the text of, and a reader looking for why a name did not resolve is
          looking under the box they typed it into. Renders nothing at all until there is
          something to say. */}
      <TagQueryRow search={search} />
    </div>
  );
}

/**
 * Everything the bar does not have room for, in a grid that halves and halves again.
 *
 * Three columns, two, then one — 900 and 640, the same two thresholds the bar itself uses, so the
 * tray reflows on the same presses the bar does rather than at a width of its own.
 *
 * **A plain conditional and no animation.** A height transition is not a positional property, so
 * `MotionConfig reducedMotion="user"` does not reach it and it would owe a `useReducedMotion`
 * opt-out of its own (`docs/reference/motion.md`); and the tray is a disclosure a reader opened
 * deliberately, looking straight at it, which is the one case where arriving instantly reads as
 * responsive rather than as a jump.
 */
function FilterTray<SortKey extends string>({
  id,
  search,
  cells,
  labels,
  formatOptions,
}: {
  id: string;
  search: FilterSurface<SortKey>;
  labels: FilterLabels;
  /** Which cells to draw, in the order to draw them — {@link TrayCell}. */
  cells: readonly TrayCell[];
  formatOptions: { value: string; label: string; disabled: boolean }[];
}) {
  const facets = search.facets;
  /**
   * Every cell this tray knows how to draw, keyed by its name — **built, then picked from**,
   * rather than a chain of conditionals in the grid.
   *
   * Two things fall out of it that matter. The **caller's** order is the drawn order, because
   * `cells.map` walks the prop rather than the record; and a cell whose surface cannot answer it
   * is `null` here, so a `tray` naming `owned` over a collection draws nothing rather than a pair
   * of buttons that do not work. Both of those are checks the type system cannot make — a cell
   * list is a string array and the fields it needs are optional — so they are made here, once,
   * where the failure is a missing box rather than a dead control.
   */
  /**
   * **Two pinned rows above the sorted list, widest first — and they are what used to be a
   * select and an `Unplayable` chip.** Neither is a format: one is "no format filter at all" and
   * the other "no format filter, and no format required either", so both belong where a reader
   * reaches for them blind — first — whatever the alphabet and the facets do to the formats
   * below.
   *
   * They read as a ladder rather than as an alphabet: every card, every card that is legal
   * *somewhere*, then one named format. `Any format` is the default and the middle rung, which
   * is the shape a reader can predict without being told.
   *
   * Neither carries a `title`. Unlike a native `<option>` — which Windows never draws one for,
   * whatever the markup says — a `DropdownOption.title` here *would* show as a real hover
   * tooltip through `Row`'s `useTooltip` binding; it stays off because neither pinned row needs a
   * sentence beyond its own label, not because the platform would swallow it.
   */
  const formatDropdownOptions: readonly DropdownOption[] = [
    { value: ANY_CARD, label: "Any card" },
    { value: "", label: "Any format" },
    // The one place a real `disabled` was right on the old markup — `<option disabled>` is
    // native, and a listbox option is not a tab stop there is anything to lose. `DropdownOption`'s
    // own `disabled` is the shell's `aria-disabled` now, which is the same rule for the same
    // reason: a row here is never in the tab order either way, so there is nothing to strand.
    ...formatOptions.map((f) => ({ value: f.value, label: f.label, disabled: f.disabled })),
  ];
  const drawn: Record<TrayCell, ReactNode> = {
    set: (
      <TrayField key="set" label="Set">
          {/* `align="start"`: the picker sits at the left edge of a tray that is itself as wide
              as the bar, so a 288px listbox pinned to the trigger's right edge would open back
              across the field rather than out from it. The row-shaped callers pass neither and
              get `"end"` — see the prop. */}
          <SetCombobox
            selected={search.sets}
            onToggle={search.toggleSet}
            counts={facets?.sets}
            align="start"
            fill
          />
      </TrayField>
    ),

    format: (
      <TrayField
        key="format"
        label="Format"
        htmlFor={`${labels.idStem}-format`}
        labelId={`${labels.idStem}-format-label`}
      >
        <Dropdown
          id={`${labels.idStem}-format`}
          labelledBy={`${labels.idStem}-format-label`}
          value={search.format}
          onChange={search.setFormat}
          options={formatDropdownOptions}
          fill
          searchable
          // Gold means "this is not where the control opens", which is a wider claim than "a
          // filter is on" — `Any card` is a *widening* and lights the same way, because the
          // reader needs to see that the wall in front of them has art cards and tokens in it.
          // `Any format` is the default and the only value that reads as untouched.
          //
          // It matters more in a tray than it did on the bar: a shut tray is a filter the reader
          // cannot see, so the gold is what the Filters badge is counting on their behalf.
          active={search.format !== ""}
        />
      </TrayField>
    ),

    /* The only filter here that is not a statement about the card: everything else describes
            cardboard, and this describes the reader's relationship to it.

            **Two buttons rather than the one cycling chip the bar used to carry, and the tray is
            what made that the better control.** A chip in a row has room for one word, so it
            cycled off → Owned → Missing → off and the word on it was what said which of the two
            questions was being asked — which meant the state the reader was *not* in was invisible
            until they pressed through to it. With a caption above and a whole cell to fill, both
            words fit; pressing the one that is already on turns it off, so the third step of the
            cycle is still a single press and no longer sits behind the other answer.

            **Never greyed**, whatever the counts say. The tooltip counts what each button's word
            names, which is one rule reading correctly in both directions — unpressed, it is what
            pressing would give; pressed, it is what the reader is already looking at. */
    owned: search.setOwned ? (
      <TrayField key="owned" label="Owned">
        <div className="flex gap-1.5">
          <ToggleChip
            label="Owned"
            pressed={search.owned === true}
            title={facetTitle("Owned", facets?.owned.owned)}
            onClick={() => search.setOwned?.(true)}
            className="flex-1"
          />
          <ToggleChip
            label="Missing"
            pressed={search.owned === false}
            title={facetTitle("Missing", facets?.owned.missing)}
            onClick={() => search.setOwned?.(false)}
            className="flex-1"
          />
        </div>
      </TrayField>
    ) : null,

    /* **The cell the deck editor's Collection tab exists for**, and the one control in this tray
       no other surface has.

       Pressed — the default — the list is the copies no deck is holding: the root, a binder the
       reader made, and `Recently removed`, which are the three places a card is still on the
       desk. Unpressed shows the spoken-for copies too, and pressing Add on one of those is what
       that tab's confirmation is for.

       **One chip rather than the Owned pair beside it**, because this is one axis with two ends
       rather than two different questions, and `aria-pressed` is how this app says that. The
       `hint` folds into the accessible name, so the visible words are contained in it (WCAG
       2.5.3).

       **Counted by nothing and cleared by nothing.** It is pressed by default, so a badge that
       counted it would open every deck reading `Reset all 1` for a state the reader has not
       touched — and Reset all leaves it pressed for the same reason: "the copies no deck is
       holding" is what that tab *is*, not a filter laid over it. `useCollectionSearch`'s
       `activeCount` is where that decision is written down. */
    decks: search.setAllocation ? (
      <TrayField key="decks" label="Decks">
        <ToggleChip
          label="Not in a deck"
          hint="only the copies no deck is holding"
          pressed={search.allocation === "unallocated"}
          onClick={() =>
            search.setAllocation?.(search.allocation === "unallocated" ? "all" : "unallocated")
          }
          className="w-full"
        />
      </TrayField>
    ) : null,

    /* Two by two below 640 and one line above it. Four gems and four words is 340px at its
            widest, which fits a third of the tray on the search page and does not fit one column
            of a 206px panel — and a chip that cannot shrink hangs out of the panel. */
    rarity: (
      <TrayField key="rarity" label="Rarity">
          <div className="grid grid-cols-2 gap-1.5 @min-[640px]/fb:flex">
            {RARITIES.map((rarity) => (
              <RarityChip
                key={rarity}
                rarity={rarity}
                pressed={search.rarities.includes(rarity)}
                // `optionDisabled`'s "a selected option is never greyed" arm, like the formats:
                // the rarity the reader picked stays pressable however its own count reads, so
                // the way out of a dead end is never the thing that greys.
                disabled={optionDisabled(
                  facets?.rarities,
                  rarity,
                  search.rarities.includes(rarity),
                )}
                title={facetTitle(sentence(rarity), facets?.rarities[rarity])}
                onClick={() => search.toggleRarity(rarity)}
              />
            ))}
        </div>
      </TrayField>
    ),

    /* The marketplace's own money in the caption, never a bare `$`. The number a reader types
            here is compared against the same expression the Price column shows, so a band in
            euros over Cardmarket prices and a band in dollars over TCGplayer's are two different
            filters and the label is the only thing that says which one is on screen.

       **Which expression that is, is the surface's own business.** The card search bands the
       *printing's* fallback chain and the collection bands the copy's own finish, because each
       is what the Price beside it shows — `collection::scope` carries the contrast. This cell
       only has to name the currency both of them are in. */
    price: (
      <TrayField
        key="price"
        label={`Price (${search.marketplace.currency.toUpperCase()})`}
      >
        <PriceRange
          min={search.priceMin}
          max={search.priceMax}
          currency={search.marketplace.currency}
          onChange={search.setPriceRange}
        />
      </TrayField>
    ),

    /* A view mode rather than a filter — it says which *rows* the wall draws, one per card or
            one per printing — so it is untouched by Reset all and absent from the badge. In the
            tray rather than on the bar because it is the rarest press on this whole surface: the
            search answers "which cards exist", and this is the way through to "which printings",
            which is otherwise the card pane's question. */
    printings: search.toggleAllPrintings ? (
      <TrayField key="printings" label="Printings">
        {/* **One label, never flipped to `One per card` when it is off.** This is a plain
            two-state toggle and `aria-pressed` already carries the state, so a label that
            changed with it would say the same thing twice — and say it as a double negative,
            since an unpressed `One per card` means "not one per card". The Owned pair beside it
            flips nothing either: it answers the same problem with two buttons, because *its*
            two states are two different questions rather than one question's on and off. */}
        <ToggleChip
          label="All printings"
          pressed={search.allPrintings ?? false}
          onClick={() => search.toggleAllPrintings?.()}
          className="w-full"
        />
      </TrayField>
    ) : null,
  };

  return (
    <div id={id} className="rounded-lg border border-border bg-surface px-4 py-3.5">
      <div className="grid grid-cols-1 gap-x-6 gap-y-3.5 @min-[640px]/fb:grid-cols-2 @min-[900px]/fb:grid-cols-3">
        {cells.map((cell) => drawn[cell])}
      </div>
    </div>
  );
}

/**
 * One captioned cell of the tray.
 *
 * `htmlFor` where the control is a single element and the caption can really be its `<label>`; a
 * plain `<span>` where the cell holds two buttons or a composite, because a `<label>` pointing at
 * a group is a label the browser wires to whichever control it finds first. Those cells' controls
 * carry their own names — `ToggleChip` and `RarityChip` build an `aria-label` apiece, `SetCombobox`
 * a `label` prop — so nothing is unnamed either way.
 *
 * **`labelId` is the other half of `htmlFor`, carried since the format cell's control became a
 * `<Dropdown>`.** A native `<label htmlFor>` reaches a `<button>`'s accessible name the same way
 * it reaches a `<select>`'s — `<button>` is labelable too — so `labelId` is not what makes the
 * connection; it is what states it outright rather than leaving it to an association a later
 * refactor could break, and the button's own content is the picked value, so a trigger left
 * unnamed either way would say the value and nothing about which field it is (see `SharedProps`
 * in `Dropdown.tsx`). `htmlFor` still keeps the pointer behaviour; `labelId` is what pins the
 * name.
 */
function TrayField({
  label,
  htmlFor,
  labelId,
  children,
}: {
  label: string;
  htmlFor?: string;
  /** id on the `<label>`, for a control whose `labelledBy` needs one to point at. Only meaningful
   *  alongside `htmlFor` — there is no `<label>` element to carry it otherwise. */
  labelId?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {htmlFor ? (
        <label id={labelId} htmlFor={htmlFor} className={FILTER_LABEL}>
          {label}
        </label>
      ) : (
        <span className={FILTER_LABEL}>{label}</span>
      )}
      {children}
    </div>
  );
}

/**
 * The layout pair, bound to one page's own preference — the collection and the wishlist keep
 * separate ones, because a search is for looking at cards and a collection for counting them.
 *
 * **Both branches are read every render, and that is the hooks rule rather than waste.** A
 * `useAppStore` call inside a conditional is a hook order that changes with a prop; zustand's
 * selector subscribes to the field it returns, so the cost of the pair is one extra subscription
 * to a string that moves when a reader presses this very control.
 */
function ViewToggle({ section }: { section: "search" | "tags" }) {
  const searchView = useAppStore((s) => s.searchView);
  const tagsView = useAppStore((s) => s.tagsView);
  const setSearchView = useAppStore((s) => s.setSearchView);
  const setTagsView = useAppStore((s) => s.setTagsView);
  const tags = section === "tags";
  return (
    // **Last of everything in the stacked layout, and beside the sort above it.** At 640 and up
    // the pair rides the first line past the divider, which is where the design puts it; below
    // that there is no first line to ride — the colours already share theirs with Filters — so
    // an `order-[9]` would strand the toggle on a line of its own between the colours and the
    // mana values. Ordered past the sort instead, it shares that line, which is the other control
    // on this bar that is about how the results are *shown* rather than which ones there are.
    <div className="order-[40] flex @min-[640px]/fb:order-[9]">
      <LayoutToggle
        view={tags ? tagsView : searchView}
        onChange={tags ? setTagsView : setSearchView}
      />
    </div>
  );
}
