import { useEffect, useId, useState, type ReactNode, type Ref } from "react";
import { ArrowUp, Check, Plus, Search } from "lucide-react";
import { motion } from "motion/react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import {
  ColorExactChip,
  FILTER_CONTROL,
  FILTER_FIELD,
  FILTER_FOCUS,
  FILTER_LABEL,
  filterChipState,
  FiltersButton,
  JoinedChoices,
  LayoutToggle,
  ManaChip,
  ManaValueChips,
  RarityChip,
  ResetAll,
  StackPrintingsToggle,
  ToggleChip,
} from "@/components/FilterChips";
import { PriceRange } from "@/components/PriceRange";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { BORDERS, BORDER_LABEL, type Border } from "@/lib/border";
import { CONDITIONS, CONDITION_NOT_SET, type Condition } from "@/lib/conditions";
import { FINISHES, FINISH_LABEL, type Finish } from "@/lib/finish";
import type { FacetResponse } from "@/lib/ipc";
import { MANA_KEYS, MANA_LABEL } from "@/lib/mana";
import { TRANSITION } from "@/lib/motion";
import type { SortDir } from "@/lib/sort";
import { DOCKED_SHADOW } from "@/lib/dockedBar";
import { LAYER } from "@/lib/layers";
import { useAppStore, type ListSection } from "@/lib/store";
import { clearFieldOnEscape } from "@/lib/useDismissOnEscape";
import { useElementWidth } from "@/lib/useElementWidth";
import { UNIVERSES, UNIVERSE_CHIP_LABEL, UNIVERSE_LABEL, type Universe } from "@/lib/universe";
import { cn } from "@/lib/utils";
import { colorDisabled, countDisabled, facetTitle, optionDisabled } from "./facets";
import {
  conditionChip,
  formatPickerRows,
  pickedFormat,
  RARITIES,
  SEARCH_SORT_ROWS,
  sentence,
  sortDirectionName,
  TOKENS_AND_EXTRAS,
  TOKENS_AND_EXTRAS_HINT,
  useFormatOptions,
} from "./filterOptions";
import { BREAKS_FOLDER_RULES, SEARCH_TRAY, type TrayCell } from "./filterOptions";
import { SetCombobox } from "./SetCombobox";
import { TagQueryRow, type TagQuerySurface } from "./TagQueryRow";
import { StatedFiltersLine } from "./StatedFiltersLine";
import {
  ANY_CARD,
  CARD_TYPES,
  cycleTriState,
  type ColorKey,
  type FormatFilterOption,
} from "./useCardSearch";

// The store-free half, moved out on 2026-10-03 so the phone face can read it — see
// `filterOptions.ts`. Re-exported so that no caller of this file had to change.
export { SEARCH_SORT_ROWS, sortDirectionName, useFormatOptions } from "./filterOptions";
export { StatedFiltersLine } from "./StatedFiltersLine";

// `TrayCell` and `SEARCH_TRAY` live in `filterOptions.ts` since 2026-10-03, beside the rest of the
// tray's vocabulary, so the light app's phone sheet can read the same lists without reaching this
// file (which reads the store). Re-exported here so every caller keeps its import.
export { SEARCH_TRAY, type TrayCell };

/**
 * The printings switch's name, on the bar and in the quick bar alike — one control, so one name,
 * and a `getByRole` or a voice command finds it wherever the width put it. `Stack printings` since
 * the Filter bar board (2026-11), with its meaning turned over: pressed — the default — stacks a
 * card's printings into one tile. It was `Show all printings`, pressed for the other reading.
 */
export { STACK_PRINTINGS } from "@/components/FilterChips";

/**
 * **Which of the Filter bar board's layouts the bar's own width calls for** (2026-11).
 *
 * One line at every band but the narrowest, each band dropping what the line cannot hold:
 *
 * - `widest` (≥ 1400): every word on its control — Filters, Stack printings, Reset — with the
 *   hairlines either side of the sort, and the Grid/List pair.
 * - `roomy` (1100–1399): the same controls, icons named by tooltip.
 * - `normal` (980–1099): the Grid/List pair leaves the bar for the Filters popup's View cell.
 * - `tight` (800–979): the sort leaves too, into the same cell, and the mana values tighten.
 * - `panel` (< 800, the deck editor's 384px column): four lines — the search box, the colours
 *   spread across theirs, the mana values stretched across theirs, then Filters, the sort,
 *   Stack printings and Reset.
 *
 * The board labels Widest ≥ 1500 but draws that row 1432px wide, and labels Normal 860–1099 and
 * Tight < 860; the edges here are where the board's own
 * controls, at the app's sizes, really fit one line with the search box at its 112px floor
 * (summed from the board's widths, 2026-11-15) — a band that opened at 860 would overflow by ~90.
 *
 * **Read from script, not a container query**, because what moves between bands is *where a
 * control is*, not only its size: the sort and the Grid/List pair are drawn once — on the bar or
 * in the popup — never twice with one hidden, which would be two controls with one accessible
 * name. The width is the row less the page title (`lead`), so a title never pushes the line
 * over. `0` is unmeasured — jsdom, or a box not laid out yet — and lands on `widest`, the band
 * with every control on the bar: a browser's `ResizeObserver` reports the real width before the
 * first paint, so `0` is never what a reader sees, and a suite gets the whole bar to press.
 */
export type BarBand = "panel" | "tight" | "normal" | "roomy" | "widest";

export function barBand(width: number): BarBand {
  if (width === 0 || width >= 1400) return "widest";
  if (width >= 1100) return "roomy";
  if (width >= 980) return "normal";
  if (width >= 800) return "tight";
  return "panel";
}

/** Whether a band draws the sort on the bar (else in the popup's View cell). */
export function sortOnBar(band: BarBand): boolean {
  return band !== "tight";
}

/** Whether a band draws the Grid/List pair on the bar (else in the popup's View cell). */
export function layoutOnBar(band: BarBand): boolean {
  return band === "roomy" || band === "widest";
}

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
 * and is still how `PrintingsFilterBar` is built — but *this* row and that one were the same
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
  /**
   * Read {@link FilterSurface.colors} as an **exact** identity rather than a subset: `"RW"`
   * answers the RW cards alone, not mono-R, mono-W, or the colourless cards that fit in any
   * deck.
   *
   * **Required, and above the line, because every surface that has colours can answer it.**
   * `colors`/`toggleColor` are required for the same reason — the colour chips are on the bar
   * at every width and on every surface — and a flag that modifies them has exactly the same
   * reach. Nothing here is a capability one backend has and another does not.
   *
   * Degenerate for `"C"`, which already means colourless-only in both modes; and a `true` with no
   * colour picked filters nothing. That last one **used** to be why the chip was not drawn until
   * a colour was picked, and since 2026-09-23 it is a state the reader can simply be in: the
   * toggle is always drawn — a tray cell until 2026-09-28, the round chip closing the colour
   * group since — and each hook's `strictParam` is what keeps a flag with no letters behind it
   * off the wire.
   */
  colorsStrict: boolean;
  toggleColorsStrict: () => void;
  sets: readonly string[];
  toggleSet: (code: string) => void;
  rarities: readonly string[];
  toggleRarity: (rarity: string) => void;
  manaValues: readonly number[];
  toggleManaValue: (value: number) => void;
  manaX: boolean;
  toggleManaX: () => void;
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

  /**
   * The band the Price cell sets. **Absent on a surface whose backend has no price bound**, which
   * is what moved these three below the line: `WishlistQuery` carries no `priceMin`/`priceMax`,
   * so a wishlist that answered them would be drawing a control whose numbers reach nothing.
   */
  priceMin?: number | undefined;
  priceMax?: number | undefined;
  setPriceRange?: (min: number | undefined, max: number | undefined) => void;
  /**
   * Whether the Filters popup offers **Tokens & extras** — the Include cell, which replaced the
   * format picker's `Any card` row (the Filter bar board, 2026-11) and sets the same `format`
   * sentinel (`ANY_CARD`).
   *
   * **A capability and not a state.** The toggle puts back the printings *no* format allows, so it
   * only means something on a surface whose default corpus leaves them out. **Two of the four
   * hooks answer about such a corpus, and they are the two that set it.** `useCardSearch`: every
   * format rides `playableOnly` (see `formatParams`). And since token stacks (2026-09-26, spec
   * §3.6) the deck search's Collection tab, `useCollectionSearch`, which spells its format through
   * that same `formatParams` — so its `Any format` means *legal somewhere*, the reader's own
   * tokens and orphan copies are left out under it, and this toggle is the only way back to them.
   * The collection page and the wishlist (`useCollection`, `useWishlist`) filter by nothing of the
   * kind — on them the sentinel would read as a legalities key nothing matches, and answer an
   * empty list.
   *
   * Absent is therefore the safe default, and the one those two take.
   */
  anyCard?: boolean;
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
  /**
   * The card-type chips — `Artifact`/`Battle`/`Creature`/`Enchantment`/`Instant`/`Land`/
   * `Planeswalker`/`Sorcery`. ORed with each other, ANDed with every other filter.
   *
   * **Optional like every cell below this line**: a surface that cannot answer it draws no cell
   * rather than a control that does nothing.
   *
   * **"Does this card have this type", not "which bucket is it in".** Dryad Arbor
   * (`Land Creature — Forest Dryad`) is under both `Land` and `Creature`, which is what a
   * filter means and what `autoCategory.ts`' one-bucket rule deliberately does not.
   */
  types?: readonly string[];
  toggleType?: (type: string) => void;
  /**
   * The border chips — `regular`/`borderless`/`fullart` (`@/lib/border`). ORed with each other,
   * ANDed with every other filter: the type chips' shape one dimension along.
   *
   * **A fact about the printing, so every surface asks the same question**, copies included —
   * a copy is of one printing and has that printing's frame. They are not a partition: a
   * borderless full-art printing answers both of those chips, and `regular` is the printing that
   * is neither.
   */
  borders?: readonly Border[];
  toggleBorder?: (border: Border) => void;
  /**
   * Universes Beyond or Universes Within (`@/lib/universe`), or neither question. One value
   * rather than two chips, because the two partition the printings and both at once is no
   * filter. A **setter** for {@link FilterSurface.owned}'s reason: passing the value already set
   * clears it, which is the tray's second press, and the stated-filter chip's × passes
   * `undefined`. A printing fact on every surface, like the border.
   */
  universe?: Universe | undefined;
  setUniverse?: (next: Universe | undefined) => void;
  /**
   * The finish chips, and **the one pair here whose meaning is the surface's** — the price band's
   * shape. Over *printings* (the card search) it is whether the printing was **published** in
   * that finish, Scryfall's `is:foil`: a printing can be nonfoil only, foil only, both, or etched,
   * so a printing published in two finishes answers both chips. Over *copies* (the collection,
   * the deck editor's Collection tab) it is which finish that piece of cardboard **is**, and a
   * copy is exactly one. The hook decides which it sends; the tray draws one cell for both.
   *
   * Absent where neither question is offered — the wishlist, whose wish carries a *preferred*
   * finish, which is a third question again.
   */
  finishes?: readonly Finish[];
  toggleFinish?: (finish: Finish) => void;
  /** The grades a copy may be in. Absent on every surface whose rows are *printings*: a printing
   *  has no condition, only a piece of cardboard does. */
  conditions?: readonly Condition[];
  toggleCondition?: (condition: Condition) => void;
  /**
   * Rows the reconciler flagged, the rows it did not, or neither question.
   *
   * Three states like {@link FilterSurface.owned}, and — like it — a **setter** rather than the
   * cycling toggle each hook keeps for its own callers. The cycle belongs to the control that
   * draws it, because this row needs two different moves on one field: the chip in the tray walks
   * off → flagged → not flagged → off, and the × on the stated-filter chip has to *clear* the
   * whole kind in one press, which is what every other chip under that rule does. A toggle can
   * only offer the first of those, and pressing it twice to fake the second is a control that
   * depends on knowing which rung it is standing on.
   */
  needsReview?: boolean | undefined;
  setNeedsReview?: (next: boolean | undefined) => void;
  /** Only the copies that break their folder's rules (issue #1057) — a collection's question,
   *  which a folder's rules badge asks when pressed. Absent on every surface that cannot ask. */
  ruleBreaks?: boolean;
  setRuleBreaks?: (next: boolean) => void;
}

/**
 * Every filter the search view offers — four controls on the bar, the rest behind Filters in a
 * popup, and the search itself stated in words underneath (the Filter bar board, 2026-11).
 *
 * **The shape is the feature.** The row used to be every control this view has, wrapped: at a
 * standard window that was two ragged lines of twelve controls, and the reader's own filters were
 * a gold border here and a lit chip there, spread across all of it. Four things are on the bar at
 * every width — the box you type in, the colours, the mana values, and the order the results come
 * in — because those are the four a reader reaches for without looking. Everything else is behind
 * one button, and what is *on* is stated as chips on a line under the bar — drawn only while
 * something is on — where a search can be read in a glance and undone one filter at a time.
 *
 * **It lays out by its own width and not the window's.** The same component is the search page's
 * bar across a maximised window and the deck editor's docked panel at 384px — draggable down to
 * 206 — so a media query would be answering a question about the wrong box. The bands are
 * {@link barBand}'s, read from the box's measured width; the popup's columns are container
 * queries on `/fb`.
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
 * each say how the results are *shown* rather than which ones there are — so neither pill counts
 * them and Reset leaves them, and the sort
 * in particular is one piece of state shared with the table's headers rather than something this
 * row owns.
 */
export function FilterBar<SortKey extends string>({
  search,
  sortRows = SEARCH_SORT_ROWS as readonly { value: SortKey; label: string }[],
  tray = SEARCH_TRAY,
  labels = SEARCH_LABELS,
  layoutToggle = true,
  layoutFor = "search",
  statesFilters = true,
  rootRef,
  lead,
}: {
  search: FilterSurface<SortKey>;
  /**
   * The bar's root element — the `@container/fb` box — for a page that watches it scroll away.
   *
   * **The whole block — row, tray, stated filters, tag row — is what the quick bar stands in for,
   * so its bottom edge is the trigger.** A ref on the first line alone would dock the quick bar
   * while the tray or the stated filters under it were still on screen, and the reader would see
   * two filter rows at once. A prop rather than `forwardRef` because React 19 passes `ref` as a
   * prop anyway, and a name that says *which* element is less to guess at than a bare `ref` on a
   * component with four boxes inside it.
   */
  rootRef?: Ref<HTMLDivElement>;
  /**
   * The row's first item, before the search box — the Search page's title (`PageTitle`), so the
   * page is named without a row of its own. **Inside the row, not beside the bar**: the band is
   * the row less this title ({@link barBand}), so the search box, the row's one flexible item,
   * gives up the width; in the four-line panel band the title takes a line of its own above.
   */
  lead?: ReactNode;
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
  sortRows?: readonly { value: SortKey; label: string; disabled?: boolean }[];
  /**
   * Which captioned cells the tray draws — see {@link TrayCell}. Defaults to
   * {@link SEARCH_TRAY}, so the surfaces that offer the card search's filters say nothing.
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
   * **{@link ListSection}, and it is derived now where it was two names written out by hand.**
   * The note that stood here said the union was worth spelling twice at two entries and worth
   * deriving at four — this is four. It is deliberately not `ZoomSection` and not `ViewId`: a zoom
   * section exists for the printings modal, which draws no filter row, and Decks and Settings draw
   * no wall to lay out. So the store owns one list of *lists with a layout*, and this prop is that
   * list rather than a third opinion beside it.
   */
  layoutFor?: ListSection;
  /**
   * Whether the bar draws its own line of stated filters under itself.
   *
   * `false` on a page that states them somewhere of its own with {@link StatedFiltersLine} — the
   * collection and the wishlist, which put the chips in their path row beside the shelf toolbar
   * so that filtering costs the wall no height (2026-09-27, the header redesign). Never a second
   * copy: the line below is not drawn when this is off. Defaults to `true`, so the search page,
   * the Tags page and the docked panels keep the line under the bar.
   */
  statesFilters?: boolean;
}) {
  /**
   * Whether the Filters popup is open, and **this component's own state rather than the store's.**
   *
   * A stored preference would be shared by the two surfaces that draw this bar, which are on
   * screen together in the deck editor — opening the panel's popup would open the search page's
   * behind it. It is also the kind of state a reader re-decides every time they look.
   */
  const [trayOpen, setTrayOpen] = useState(false);
  const trayId = useId();
  /** The row and its popup, in state for the outside-press effect's dependency list. */
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  /**
   * The row and the page title, measured apart: the band is the row **less the title** — the
   * room the controls have — and it is taken from two boxes whose widths do not depend on the
   * band. Measuring the controls' own box instead would oscillate at the panel edge, where the
   * title moves onto a line of its own and hands the controls its width back.
   */
  const [rowRef, rowWidth] = useElementWidth<HTMLDivElement>();
  const [leadRef, leadWidth] = useElementWidth<HTMLDivElement>();
  const band = barBand(
    rowWidth === 0 ? 0 : Math.max(1, rowWidth - (lead !== undefined ? leadWidth + 12 : 0)),
  );
  const panel = band === "panel";
  const widest = band === "widest";
  const sortUp = sortOnBar(band);
  const layoutUp = layoutToggle && layoutOnBar(band);
  const formatOptions = useFormatOptions(search);
  const facets = search.facets;
  const sortDropdownOptions: readonly DropdownOption[] = sortRows.map((s) => ({
    value: s.value,
    label: s.label,
    disabled: s.disabled,
  }));

  /**
   * **A press outside the bar closes its popup** — the board's rule, and the quick bar's code:
   * capture phase on `document`, so a control that stops propagation cannot keep the popup open
   * under a press aimed elsewhere. "Outside" is outside the frame the popup hangs in, and nothing
   * in the popup portals (`SetCombobox`, `Dropdown` and `PriceRange` all anchor inside their own
   * roots), so a press on an open set picker's row is a press inside.
   */
  useEffect(() => {
    if (!trayOpen || frame === null) return;
    const onDown = (e: PointerEvent) => {
      if (!frame.contains(e.target as Node)) setTrayOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [trayOpen, frame]);

  const sort = (
    <SortControl
      idStem={labels.idStem}
      value={search.sortSelection}
      options={sortDropdownOptions}
      onChange={(key) => search.setSortKey(key as SortKey)}
      dir={search.sortDir}
      onFlip={search.flipSortDir}
      // A fixed trigger width, so picking a longer order never moves the bar (the board's "a
      // button never changes width when used"); the panel's line gives it the rest instead.
      triggerClass={panel ? "min-w-0 flex-1" : widest || band === "roomy" ? "w-30" : "w-28"}
      className={panel ? "min-w-0 flex-1" : undefined}
    />
  );
  const layout = <ViewToggle section={layoutFor} />;

  /** The popup's last cell: whichever of the sort and the Grid/List pair left the bar. */
  const viewCell =
    !sortUp || (layoutToggle && !layoutUp) ? (
      <TrayField key="view" label="View">
        <div className="flex min-w-0 items-center gap-2">
          {!sortUp && sort}
          {layoutToggle && !layoutUp && layout}
        </div>
      </TrayField>
    ) : null;

  const searchField = (
    <div
      className={cn(
        "relative flex items-center",
        panel ? "w-full" : "w-70 min-w-28 shrink",
      )}
    >
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-2.5 my-auto size-3.5 text-dim"
      />
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
        // Escape empties the box while there is something in it to empty, and falls through when
        // there is not — {@link clearFieldOnEscape}'s rule, which jsdom (no native clear) can see.
        onKeyDown={(e) => clearFieldOnEscape(e, search.text, () => search.setText(""))}
        // The accessible name with an ellipsis, so the two say the same thing.
        placeholder={`${labels.search}…`}
        // `FILTER_FIELD`, not `FILTER_CONTROL`: a box the reader types into must not dip under
        // the press (issue #179).
        className={cn(
          FILTER_FIELD,
          FILTER_FOCUS,
          "h-8 w-full min-w-0 border-border bg-surface pr-2.5 pl-8 placeholder:text-dim focus:border-accent",
        )}
      />
    </div>
  );

  /** The colour chips — 26px on the line, 34px and spread across their own line in the panel. */
  const pip = panel ? "size-[34px]" : "size-[26px] text-sm ring-offset-1";
  const colours = (
    <div
      role="group"
      aria-label="Color identity"
      className={cn("flex shrink-0 items-center", panel ? "w-full justify-between" : "gap-1")}
    >
      {MANA_KEYS.map((key) => (
        <ManaChip
          key={key}
          symbol={key}
          className={pip}
          pressed={search.colors.includes(key)}
          // The count is the result set *after* the press, read against `facets.total` — the
          // one control here that does not ask "would this return nothing".
          disabled={colorDisabled(
            facets?.colors[key],
            facets?.total ?? 0,
            search.colors.includes(key),
          )}
          title={facetTitle(MANA_LABEL[key], facets?.colors[key])}
          onClick={() => search.toggleColor(key)}
        />
      ))}
      {/* The reading these chips get — loose or exact — closing the group it modifies. Not
          counted; the colour chip on the stated line says it. */}
      <ColorExactChip
        className={cn(pip, !panel && "ml-0.5")}
        pressed={search.colorsStrict}
        onClick={search.toggleColorsStrict}
      />
    </div>
  );

  const manaValues = (
    <ManaValueChips
      className={
        panel ? "w-full flex-nowrap" : band === "tight" ? "shrink-0 flex-nowrap gap-0.5" : "shrink-0 flex-nowrap gap-[3px]"
      }
      chipClass={
        panel
          ? "h-7 w-auto min-w-0 flex-1 px-0 text-[0.6875rem]"
          : band === "tight"
            ? "size-6 text-[0.6875rem]"
            : "size-[26px] text-[0.6875rem]"
      }
      selected={search.manaValues}
      onToggle={search.toggleManaValue}
      disabled={(value) =>
        optionDisabled(facets?.manaValues, String(value), search.manaValues.includes(value))
      }
      title={(value, label) => facetTitle(label, facets?.manaValues[String(value)])}
      xSelected={search.manaX}
      onToggleX={search.toggleManaX}
      // `manaX` is a field beside `manaValues`, counted off the same base — so X greys when and
      // only when its neighbours would.
      xDisabled={countDisabled(facets?.manaX, search.manaX)}
      xTitle={(label) => facetTitle(label, facets?.manaX)}
    />
  );

  const filters = (
    <FiltersButton
      open={trayOpen}
      count={search.activeCount}
      onToggle={() => setTrayOpen((open) => !open)}
      controls={trayId}
      labelClass={widest ? undefined : "hidden"}
      className="h-8 px-2.5"
    />
  );
  const stack = search.toggleAllPrintings ? (
    <StackPrintingsToggle
      // Inverted on purpose: the hooks keep `allPrintings`, the control says what is on screen.
      stacked={!(search.allPrintings ?? false)}
      onToggle={() => search.toggleAllPrintings?.()}
      labelClass={widest ? undefined : "hidden"}
      className="h-8"
    />
  ) : null;
  const reset = (
    <ResetAll
      count={search.activeCount}
      onReset={search.resetAll}
      labelClass={widest ? undefined : "hidden"}
      className="h-8"
    />
  );
  const divider = <span aria-hidden="true" className="h-8 w-px shrink-0 bg-border" />;

  /**
   * **The bar's own row, one arrangement per band** — each control written once and placed by
   * {@link barBand}, so no band draws a control twice. The board's order: search, colours, mana
   * values, then — pushed right — Filters, the sort, Stack printings, Grid/List and Reset.
   */
  const controls = panel ? (
    <div className="flex min-w-0 flex-1 flex-col gap-2.5">
      {searchField}
      {colours}
      {manaValues}
      <div className="flex min-w-0 items-center gap-2">
        {filters}
        {sort}
        {stack}
        {reset}
      </div>
    </div>
  ) : (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {searchField}
      {colours}
      <div className={cn("shrink-0", widest && "ml-1.5")}>{manaValues}</div>
      <span aria-hidden="true" className="min-w-0 flex-1" />
      {filters}
      {sortUp && (
        <>
          {widest && divider}
          {sort}
          {widest && divider}
        </>
      )}
      {stack}
      {layoutUp && layout}
      {reset}
    </div>
  );

  return (
    // **A named container, and nothing that has to cover the window may be mounted inside it.**
    // `container-type: inline-size` makes this box the containing block for every `fixed`
    // descendant — the dropdowns' frames account for it (`usePopupPlacement`), a `Dialog` would
    // not. The popup's grid reads `/fb` for its columns.
    <div ref={rootRef} className="@container/fb flex flex-col gap-2">
      <div
        ref={setFrame}
        className="relative"
        // **Escape closes the popup and hands the caret to Filters — bubbling on purpose.** An
        // open set picker or dropdown inside it is a capture-phase `"inner"` layer: it closes
        // first and consumes the key, so this sees `defaultPrevented` and leaves the popup open.
        // One press per layer. With the popup shut the press is not this bar's at all.
        onKeyDown={(e) => {
          if (e.key !== "Escape" || !trayOpen || e.defaultPrevented) return;
          e.preventDefault();
          setTrayOpen(false);
          frame?.querySelector<HTMLButtonElement>(`[aria-controls="${trayId}"]`)?.focus();
        }}
      >
        {/* Four lines in the panel band put the page title on a line of its own above them,
            rather than centred beside a stack it no longer reads as the head of. */}
        <div
          ref={rowRef}
          className={cn("flex min-w-0 gap-3", panel ? "flex-col" : "items-center")}
        >
          {lead !== undefined && (
            <div ref={leadRef} className="flex h-9 shrink-0 items-center self-start">
              {lead}
            </div>
          )}
          {controls}
        </div>

        {/* **The popup drops from the bar over the results** (the board), rather than pushing
            them down as the tray did: what is on is stated under the bar once it closes. */}
        {trayOpen && (
          <div className={cn("absolute inset-x-0 top-full mt-1.5", LAYER.popup, DOCKED_SHADOW)}>
            <FilterTray
              id={trayId}
              search={search}
              cells={tray}
              labels={labels}
              formatOptions={formatOptions}
              view={viewCell}
            />
          </div>
        )}
      </div>

      {statesFilters && <StatedFiltersLine search={search} />}

      {/* The chips a typed `otag:ramp` produces, and the note an unknown tag name gets — the
          query's own terms, under the box they were typed into. Renders nothing until then. */}
      <TagQueryRow search={search} />
    </div>
  );
}

/**
 * **The sort as one joined control** — the order picker and its direction arrow in one frame,
 * split by a hairline (the Filter bar board, 2026-11). Joined so `flex-wrap` can never break the
 * arrow from the order it turns over, and so the pair reads as one thing.
 *
 * `Sort results`, never a bare `Sort`: this row is drawn beside the deck editor's own `Sort`, and
 * two controls with one name cannot be addressed by a screen reader, a voice command or a test.
 *
 * Never gold: a list is always in *some* order, so a sort cannot be "on", and Reset leaves it.
 * One arrow turned over rather than two icons swapped, so the press reads as the order reversing
 * (`SortableHeader`'s rule). The arrow is `disabled` only on `Best match`, which has no direction;
 * it is wrapped so its tooltip still answers a hover in that state.
 */
export function SortControl({
  idStem,
  value,
  options,
  onChange,
  dir,
  onFlip,
  triggerClass,
  className,
}: {
  idStem: string;
  value: string;
  options: readonly DropdownOption[];
  onChange: (value: string) => void;
  dir: SortDir | undefined;
  onFlip: () => void;
  /** The trigger's box — a fixed width on a line, `flex-1` where it fills one. */
  triggerClass?: string;
  className?: string;
}) {
  const tip = useTooltip();
  return (
    <div className={cn("flex shrink-0 items-stretch", className)}>
      <label id={`${idStem}-sort-label`} htmlFor={`${idStem}-sort`} className="sr-only">
        Sort results
      </label>
      <div className={cn("min-w-0", triggerClass)}>
        <Dropdown
          id={`${idStem}-sort`}
          labelledBy={`${idStem}-sort-label`}
          value={value}
          onChange={onChange}
          options={options}
          fill
          className="h-8 rounded-r-none"
        />
      </div>
      <span className="flex" {...tip(sortDirectionName(dir), { describes: false })}>
        <button
          type="button"
          onClick={onFlip}
          disabled={!dir}
          aria-label={sortDirectionName(dir)}
          className={cn(
            FILTER_CONTROL,
            FILTER_FOCUS,
            "-ml-px flex size-8 items-center justify-center rounded-l-none",
            filterChipState(false, !dir),
          )}
        >
          {/* `flex` on the span is load-bearing: a transform does not apply to an inline box. */}
          <motion.span
            aria-hidden="true"
            initial={false}
            animate={{ rotate: dir === "desc" ? 180 : 0 }}
            transition={TRANSITION.fast}
            className="flex"
          >
            <ArrowUp className="size-4" />
          </motion.span>
        </button>
      </span>
    </div>
  );
}

/**
 * Everything the bar does not have room for — the Filters popup's grid, in the board's order: Set,
 * Format, Universe, Type, Rarity, Price, Finish, Border, Owned, then Include, and the View cell
 * when the bar's width moved the sort or the Grid/List pair into it.
 *
 * **A plain conditional and no animation.** A height transition is not a positional property, so
 * `MotionConfig reducedMotion="user"` does not reach it and it would owe a `useReducedMotion`
 * opt-out of its own (`docs/reference/motion.md`); and the tray is a disclosure a reader opened
 * deliberately, looking straight at it, which is the one case where arriving instantly reads as
 * responsive rather than as a jump.
 *
 * **Exported for the filter quick bar**, which opens this same tray under its docked strip rather
 * than drawing a second one. `formatOptions` stays a prop rather than being computed in here, so
 * each host builds it with {@link useFormatOptions} at its own top level — the tray mounts and
 * unmounts with its disclosure, and a hook inside it would re-sort on every open.
 */
export function FilterTray<SortKey extends string>({
  id,
  search,
  cells,
  labels,
  formatOptions,
  view,
}: {
  id: string;
  search: FilterSurface<SortKey>;
  labels: FilterLabels;
  /** The View cell — the sort and the Grid/List pair when the bar's width put them here. Drawn
   *  last, after Include; not a filter, so neither pill counts it. */
  view?: ReactNode;
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
  // The pinned `Any format`, then the formats — `formatPickerRows`, which the phone's filters
  // sheet reads too.
  const formatDropdownOptions = formatPickerRows(formatOptions);
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
          // Tokens & extras is the format sentinel and has no row here: the picker reads `Any
          // format` under it, and picking `Any format` again leaves the toggle on.
          value={pickedFormat(search.format)}
          onChange={(next) => {
            if (next !== pickedFormat(search.format)) search.setFormat(next);
          }}
          options={formatDropdownOptions}
          fill
          searchable
          // Gold means "this is not where the control opens". `Any format` is the default and
          // the only value that reads as untouched; Tokens & extras lights its own toggle.
          active={pickedFormat(search.format) !== ""}
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
        {/* Two answers in one joined control; pressing the one that is on turns it off. Never
            greyed — each title counts what its word names, read either way. */}
        <JoinedChoices
          label="Owned"
          choices={[
            {
              value: "owned",
              label: "Owned",
              pressed: search.owned === true,
              title: facetTitle("Owned", facets?.owned.owned),
              onClick: () => search.setOwned?.(true),
            },
            {
              value: "missing",
              label: "Missing",
              pressed: search.owned === false,
              title: facetTitle("Missing", facets?.owned.missing),
              onClick: () => search.setOwned?.(false),
            },
          ]}
        />
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
          hint="Only copies not used in a deck"
          pressed={search.allocation === "unallocated"}
          onClick={() =>
            search.setAllocation?.(search.allocation === "unallocated" ? "all" : "unallocated")
          }
          className="w-full"
        />
      </TrayField>
    ) : null,

    /* Two by two below the widest bar and one line at it (the board). Four gems and four words
       is ~340px, which a third of a 1100px popup does not hold, and a chip that cannot shrink
       hangs out of its cell. */
    rarity: (
      <TrayField key="rarity" label="Rarity">
          <div className="grid grid-cols-2 gap-1.5 @min-[1500px]/fb:flex">
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

    /* Eight chips, OR within — the rarity cell's greying rule one dimension along, and a card
       with two types is under both of them, because this filter asks *does this card have this
       type* rather than which bucket it is in. Dryad Arbor is the card the rule is written for:
       `autoCategory.ts` files it under Land alone, and a reader pressing Creature who could not
       find it has been told a falsehood.

       `CARD_TYPES` is the **reading order** — Creature first, Land last, which is how every
       decklist reads — and deliberately not `cardtypes.rs`' alphabetical bit order. A matching
       order and a display order are two constants for `autoCategory.ts`' own reason: one constant
       cannot be both, and folding them together breaks whichever job loses.

       **A wrapping flow at every width, which is the condition cell's arrangement and not the
       rarity cell's.** Four rarities fit a line; eight types do not fit one column of a 206px
       panel, where the cell's content box is ~161px against `Planeswalker`'s own ~112px of
       min-content. A grid of two columns there would give each chip ~78px, and a grid item
       cannot shrink below its min-content any more than a flex item can — so the cell would hang
       out of the panel and put a horizontal scrollbar across the whole deck builder
       (`packages/ui/CLAUDE.md`'s narrowest-surface rule). `flex-wrap` makes this group's min-content one
       chip, so it breaks onto as many lines as it needs and is unchanged in the wide bars where
       it already fitted. jsdom applies no container query and lays nothing out, so none of this
       can go red in the suite. */
    type: search.toggleType ? (
      <TrayField key="type" label="Type">
        <div role="group" aria-label="Type" className="flex flex-wrap gap-1.5">
          {CARD_TYPES.map((t) => (
            <ToggleChip
              key={t}
              label={t}
              pressed={search.types?.includes(t) ?? false}
              // `optionDisabled`'s "a selected option is never greyed" arm, like the rarities
              // above: the type the reader picked stays pressable however its own count reads,
              // so the way out of a dead end is never the thing that greys.
              disabled={optionDisabled(facets?.types, t, search.types?.includes(t) ?? false)}
              title={facetTitle(t, facets?.types?.[t])}
              onClick={() => search.toggleType?.(t)}
              className="flex-none"
            />
          ))}
        </div>
      </TrayField>
    ) : null,

    /* Three chips, OR within — the type cell's shape and its greying rule. **Not a partition**: a
       borderless full-art printing answers both of the last two, and `Regular` is the printing
       that is neither (`@/lib/border` carries the corpus measurement). So the counts in the titles
       overlap like the types' do, and are not meant to sum to anything.

       **`BORDERS`' order and not the alphabet, which is `sortOptions`' order-is-the-information
       exemption**: the ordinary framed card first, then the two treatments that take the frame
       away. Sorted, `Borderless` would lead a row whose first question is nearly always "the
       normal one".

       A printing fact on every surface, so unlike Finish beside it this cell asks one question
       wherever it is drawn — a copy has its printing's frame. On the surfaces with no facet
       command `facets` is `undefined` and every chip stays live, `facets.ts`' fail-open arm.

       `flex-wrap` for the type cell's reason: at the docked panel's 206px floor three `flex-1`
       chips are wider than the ~161px cell, and a row that cannot break hangs out of the panel. */
    border: search.toggleBorder ? (
      <TrayField key="border" label="Border">
        {/* Three ORed choices joined — not a partition (a borderless full-art printing answers
            both of the last two), so each segment presses on its own. */}
        <JoinedChoices
          label="Border"
          choices={BORDERS.map((b) => {
            const pressed = search.borders?.includes(b) ?? false;
            return {
              value: b,
              label: BORDER_LABEL[b],
              pressed,
              disabled: optionDisabled(facets?.borders, b, pressed),
              title: facetTitle(BORDER_LABEL[b], facets?.borders?.[b]),
              onClick: () => search.toggleBorder?.(b),
            };
          })}
        />
      </TrayField>
    ) : null,

    /* Owned's two-button shape over one printing fact: Beyond is Scryfall's `universesbeyond`
       promo type and Within is every printing without it, so the pair is a partition and
       pressing the one that is on turns the filter off. Never greyed — there is no facet count
       for it, and `facets.ts`' fail-open rule is that a missing count leaves a control live. */
    universe: search.setUniverse ? (
      <TrayField key="universe" label="Universe">
        {/* A partition, so pressing the one that is on turns the filter off. No facet count. */}
        <JoinedChoices
          label="Universe"
          choices={UNIVERSES.map((u) => ({
            value: u,
            label: UNIVERSE_LABEL[u],
            pressed: search.universe === u,
            hint: UNIVERSE_CHIP_LABEL[u],
            onClick: () => search.setUniverse?.(u),
          }))}
        />
      </TrayField>
    ) : null,

    /* The marketplace's own money in the caption, never a bare `$`. The number a reader types
            here is compared against the same expression the Price column shows, so a band in
            euros over Cardmarket prices and a band in dollars over TCGplayer's are two different
            filters and the label is the only thing that says which one is on screen.

       **Which expression that is, is the surface's own business.** The card search bands the
       *printing's* fallback chain and the collection bands the copy's own finish, because each
       is what the Price beside it shows — `collection::scope` carries the contrast. This cell
       only has to name the currency both of them are in. */
    price: search.setPriceRange ? (
      <TrayField key="price" label={`Price (${search.marketplace.currency.toUpperCase()})`}>
        <PriceRange
          min={search.priceMin}
          max={search.priceMax}
          currency={search.marketplace.currency}
          onChange={search.setPriceRange}
        />
      </TrayField>
    ) : null,

    /* **One cell, two questions, and the surface decides which** — the price cell's shape. Over
       *printings* (the card search) it asks whether the printing was **published** in this
       finish, Scryfall's `is:foil`: a printing can be nonfoil only, foil only, both, or etched,
       so `Foil` narrows a wall of printings and one published in two finishes answers both chips.
       Over *copies* (the collection, the deck editor's Collection tab) it asks which finish this
       piece of cardboard **is**, and a copy is exactly one. The hook owns the difference —
       `printedFinishes` on the wire against the collection's `finishes` — so the markup is one.

       It was absent from the card search until issue #573, on the argument that "a printing
       exists in every finish it was published in". That read the copy's question and found the
       printing had no answer to it; the printing's own question has one.

       Greyed and titled from `facets.finishes` exactly as the type cell is. Only the card search
       has a facet command, and its counts are *published* finishes; every copy surface hands
       `facets` over as `undefined`, so there every chip stays live — `facets.ts`' "we don't know"
       arm, which fails open rather than greying a copy's question by a printing's count. */
    finish: search.toggleFinish ? (
      <TrayField key="finish" label="Finish">
        <JoinedChoices
          label="Finish"
          choices={FINISHES.map((f) => {
            const pressed = search.finishes?.includes(f) ?? false;
            return {
              value: f,
              label: FINISH_LABEL[f],
              pressed,
              disabled: optionDisabled(facets?.finishes, f, pressed),
              title: facetTitle(FINISH_LABEL[f], facets?.finishes?.[f]),
              onClick: () => search.toggleFinish?.(f),
            };
          })}
        />
      </TrayField>
    ) : null,

    /* The grades as they are printed on every listing the cards came from. Spelled out in the
       accessible name and the tooltip, because `DMG` is vocabulary — and six spelled-out grades
       are 400px of chrome, which is what put this cell in the tray rather than on the bar.
       `conditionChip` is what excuses the sixth from that treatment: `NONE` is printed on no
       listing, so it is drawn as its word and has no abbreviation left to expand.

       Three to a line below 640 and a flow above it, the rarity cell's arrangement for its
       reason: six chips do not fit one column of a narrow tray, and a chip that cannot shrink
       hangs out of it. Two things the sixth chip changed, and both are `packages/ui/CLAUDE.md`'s
       narrowest-surface rule rather than taste. **The flow above 640 wraps**, because the tray's
       cell is *narrowest* in its three-column band — a third of the bar at 900 is less than half
       of it at 640 — and six `flex-1` chips that cannot shrink below `DMG`'s own min-content
       overhang that cell, which in a `overflow-y-auto` page section is a horizontal scrollbar
       across the whole view. **And `Not set` takes the whole first row below 640**, where a third
       of a 206px panel is narrower than the two words are: a flex item cannot shrink below its
       min-content either, so the alternative is a label wrapping to two lines inside a fixed
       `h-9` box. `whitespace-nowrap` is what keeps it one line wherever it lands — it is the one
       label in this row with a space in it, so it is the only one that could break. jsdom applies
       no container query and lays nothing out, so none of this can go red in the suite. */
    condition: search.toggleCondition ? (
      <TrayField key="condition" label="Condition">
        <div
          role="group"
          aria-label="Condition"
          className="grid grid-cols-3 gap-1.5 @min-[640px]/fb:flex @min-[640px]/fb:flex-wrap"
        >
          {CONDITIONS.map((c) => {
            const { label, hint } = conditionChip(c);
            return (
              <ToggleChip
                key={c}
                label={label}
                hint={hint}
                pressed={search.conditions?.includes(c) ?? false}
                onClick={() => search.toggleCondition?.(c)}
                className={cn(
                  "@min-[640px]/fb:flex-1",
                  c === CONDITION_NOT_SET &&
                    "col-span-3 whitespace-nowrap @min-[640px]/fb:col-span-1",
                )}
              />
            );
          })}
        </div>
      </TrayField>
    ) : null,

    /* The other half of what the flagged band under a row says: the band tells you an entry needs
       looking at, and this is how you ask for only those. Off → flagged → not flagged → off, and
       **the word on the chip is what says which of the three is on** — an unpressed chip cannot
       mean "not flagged" and also be the same chip that means it when pressed. The flagged rows
       come first because that is the only reason anybody presses this; the complement is where
       the reader goes once they are dealt with. */
    needsReview: search.setNeedsReview ? (
      <TrayField key="needsReview" label="Needs review">
        <ToggleChip
          label={search.needsReview === false ? "Not flagged" : "Needs review"}
          pressed={search.needsReview !== undefined}
          onClick={() => search.setNeedsReview?.(cycleTriState(search.needsReview, true))}
          className="w-full"
        />
      </TrayField>
    ) : null,

    /* What a folder's rules badge turns on when pressed (issue #1057): the red-outlined copies
       alone, here so the reader can see it is on and press it off. */
    ruleBreaks: search.setRuleBreaks ? (
      <TrayField key="ruleBreaks" label="Folder rules">
        <ToggleChip
          label={BREAKS_FOLDER_RULES}
          pressed={search.ruleBreaks ?? false}
          onClick={() => search.setRuleBreaks?.(!(search.ruleBreaks ?? false))}
          className="w-full"
        />
      </TrayField>
    ) : null,

    include: search.anyCard ? (
      <TrayField key="include" label="Include">
        {/* **Tokens & extras** — the format picker's old `Any card` row as its own toggle, at the
            regular height and the end of the grid (the board). It is that row's sentinel, so
            turning it on puts the format back to `Any format` and picking a format turns it
            off: see {@link TOKENS_AND_EXTRAS} for why the two never stand on at once. */}
        <ToggleChip
          label={TOKENS_AND_EXTRAS}
          hint={TOKENS_AND_EXTRAS_HINT}
          pressed={search.format === ANY_CARD}
          icon={
            search.format === ANY_CARD ? (
              <Check aria-hidden="true" className="size-3.5" />
            ) : (
              <Plus aria-hidden="true" className="size-3.5" />
            )
          }
          onClick={() => search.setFormat(search.format === ANY_CARD ? "" : ANY_CARD)}
          className="self-start"
        />
      </TrayField>
    ) : null,
  };

  return (
    // **A regular grid, filled left to right in the caller's order, each row only as tall as its
    // own tallest filter** (`items-start`, auto rows — the board). Three columns from 980, the
    // bar's Normal band; two from 640; one below, where the cells scroll inside a frame that
    // keeps its four corners and fades out above the foot (the deck panel's popup). **The
    // scroller is never a container**: the format and set popups draw in a `fixed` frame whose
    // containing block is the bar's own `@container/fb`, outside this box, so it cannot clip
    // them.
    <div id={id} className="relative overflow-hidden rounded-lg border border-border bg-surface">
      <div className="max-h-[min(470px,60vh)] overflow-y-auto px-4 pt-3.5 pb-8 @min-[640px]/fb:max-h-none @min-[640px]/fb:overflow-visible @min-[640px]/fb:pb-3.5">
        <div className="grid grid-cols-1 items-start gap-x-6 gap-y-3.5 @min-[640px]/fb:grid-cols-2 @min-[980px]/fb:grid-cols-3">
          {cells.map((cell) => drawn[cell])}
          {view}
        </div>
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-b from-transparent to-surface @min-[640px]/fb:hidden"
      />
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
 * The layout pair, bound to one page's own preference — the four lists keep four, because they
 * are looked at for four different reasons and a reader who put their collection in a table was
 * not saying anything about their shopping list.
 *
 * **All eight selectors are read every render, and that is the hooks rule rather than waste.** A
 * `useAppStore` call inside a conditional is a hook order that changes with a prop; zustand's
 * selector subscribes to the field it returns, so the cost is three extra subscriptions to strings
 * that move only when a reader presses this very control on one of the other three pages — and
 * only one of the four pages is ever mounted at a time.
 *
 * The pair is picked out of records rather than by a chain of ternaries, so adding a fifth list is
 * a line in {@link LIST_SECTIONS} and a line in each record instead of a conditional that has to
 * stay in step with itself in two places.
 *
 * **The store read, and nothing else.** The box this used to draw around itself — the `order`
 * numbers that place it on the row — belongs to the wrapper around it, so it lives at that
 * wrapper's site in {@link FilterBar} with the reasoning that goes with it. What
 * is left here is the one thing a wrapper cannot do: turn a section name into the preference this
 * page's pair is bound to.
 */
function ViewToggle({ section }: { section: ListSection }) {
  const searchView = useAppStore((s) => s.searchView);
  const collectionView = useAppStore((s) => s.collectionView);
  const wishlistView = useAppStore((s) => s.wishlistView);
  const setSearchView = useAppStore((s) => s.setSearchView);
  const setCollectionView = useAppStore((s) => s.setCollectionView);
  const setWishlistView = useAppStore((s) => s.setWishlistView);
  const view = {
    search: searchView,
    collection: collectionView,
    wishlist: wishlistView,
  }[section];
  const onChange = {
    search: setSearchView,
    collection: setCollectionView,
    wishlist: setWishlistView,
  }[section];
  return <LayoutToggle view={view} onChange={onChange} />;
}

