import { useId, useState, type ReactNode, type Ref } from "react";
import { ArrowUp } from "lucide-react";
import { motion } from "motion/react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import {
  ActiveFilterChip,
  ColorExactChip,
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
import { BORDERS, BORDER_LABEL, type Border } from "@/lib/border";
import { CONDITIONS, CONDITION_NOT_SET, type Condition } from "@/lib/conditions";
import { FINISHES, FINISH_LABEL, type Finish } from "@/lib/finish";
import type { FacetResponse } from "@/lib/ipc";
import { MANA_KEYS, MANA_LABEL } from "@/lib/mana";
import { TRANSITION } from "@/lib/motion";
import type { SortDir } from "@/lib/sort";
import { useAppStore, type ListSection } from "@/lib/store";
import { clearFieldOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { colorDisabled, countDisabled, facetTitle, optionDisabled } from "./facets";
import {
  activeChips,
  conditionChip,
  formatPickerRows,
  RARITIES,
  SEARCH_SORT_ROWS,
  sentence,
  sortDirectionName,
  useFormatOptions,
} from "./filterOptions";
import { SEARCH_TRAY, type TrayCell } from "./filterOptions";
import { SetCombobox } from "./SetCombobox";
import { TagQueryRow, type TagQuerySurface } from "./TagQueryRow";
import {
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
   * Whether the format picker offers `Any card`.
   *
   * **A capability and not a state**, which is the distinction that makes it worth a field. `Any
   * card` is not a format — it is the row that puts back the printings *no* format allows, and it
   * only means something on a surface whose default corpus leaves them out. **Two of the four
   * hooks answer about such a corpus, and they are the two that set it.** `useCardSearch`: every
   * row of its picker but this one rides `playableOnly` (see `formatParams`). And since token
   * stacks (2026-09-26, spec §3.6) the deck search's Collection tab, `useCollectionSearch`, which
   * spells its format through that same `formatParams` — so its `Any format` means *legal
   * somewhere*, the reader's own tokens and orphan copies are left out under it, and this row is
   * the only way back to them on a tab that opens on the deck's format. The collection page and
   * the wishlist (`useCollection`, `useWishlist`) are lists of cardboard the reader already owns or
   * wants, filtered by nothing of the kind — so on them the row would set `format` to a sentinel
   * their backend reads as a legalities key nothing matches, and answer an empty list.
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
 * one button, and what is *on* is stated as chips on a line under the bar — drawn only while
 * something is on — where a search can be read in a glance and undone one filter at a time.
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
 * each say how the results are *shown* rather than which ones there are — so none of them is counted by the Reset all badge or cleared by pressing it, and the sort
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
  const formatOptions = useFormatOptions(search);
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
   * **`disabled` rides on the row and never on this markup**, which is what lets one picker serve
   * three surfaces. No row of the *card search's* list is ever disabled — every one of them is a
   * real destination. The collection's `Custom…` is, and the two look alike while being opposites:
   * that one is a state the control can only be *put* into, from a column header this picker has
   * no option for. So the surface that has such a state says so on its own row, and the one that
   * does not says nothing.
   *
   * **The flag has to be carried through here or it is lost.** These options are the whole of what
   * the panel draws, so a mapper that took only `value` and `label` would silently make the
   * collection's `Custom…` pickable — a control that offers a destination it cannot reach. It read
   * that way for one commit while this file and `sortRows` were being merged.
   *
   * `aria-disabled` rather than `disabled` once it reaches a row: a `<Dropdown>` row is never in
   * the tab order at all — the walk is `aria-activedescendant` — so the house rule lands on the
   * same attribute a native `<option>` reached by being exempt from it.
   */
  const sortDropdownOptions: readonly DropdownOption[] = sortRows.map((s) => ({
    value: s.value,
    label: s.label,
    disabled: s.disabled,
  }));

  /**
   * **The bar's own row — one flex container for both lines, ordered rather than duplicated.**
   *
   * The obvious build is a `<div>` per breakpoint with `hidden` on the ones that do not
   * apply — and it puts two mana-value groups and two sort pickers in the tree at once, which
   * is two controls with one accessible name, two tab stops for one filter, and a
   * `getByLabelText` that starts throwing "found multiple". So the items are written once and
   * the arrangement is `order` plus a `basis-full` spacer that forces a line break. The order
   * numbers below are the whole layout; each item carries its own.
   *
   * The gaps close as the box narrows — 12px, 10px, 8px — because at 640 the same gaps that
   * gave a 1500px bar its air are what tip the second line into a third.
   */
  const row = (
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
        // pointer clearing it. Issue #179 — the reason is on the constant. It is also where the
        // finger's floor comes from: `FILTER_SHAPE`'s `coarse:min-h-[var(--target-min)]` is what
        // makes this box 44 tall under a coarse pointer without a number being written a second
        // time here.
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
            // The count is the size of the result set *after* the press, read against
            // `facets.total`. And that total is the facets' own: printings, exact, and not
            // the collapsed, capped number the results caption prints.
            //
            // **Which way a press moves is now the reader's choice**, which is why this stays
            // "after the press" rather than becoming a direction: loose, `colors` is subset
            // semantics and pressing a chip with another already on *broadens*; with `Exact`
            // on it *narrows*. `colorDisabled` needs no branch on the mode — the backend
            // counted under whichever one the request carried.
            disabled={colorDisabled(
              facets?.colors[key],
              facets?.total ?? 0,
              search.colors.includes(key),
            )}
            title={facetTitle(MANA_LABEL[key], facets?.colors[key])}
            onClick={() => search.toggleColor(key)}
          />
        ))}

        {/* **The reading these six chips get — loose or exact — closing the group they modify.**
            It was a chip here once before, until 2026-09-23, and left for the tray because it
            was drawn only while a colour was picked: a control that came and went under the
            reader's hand and reflowed the group on the first press. It is back **always drawn**,
            so neither cost returns, and a reader no longer opens a disclosure to learn what the
            chips beside it mean. Inside the group rather than beside it so it wraps with them at
            the deck panel's 206px floor instead of stranding on a line of its own.

            Not in `activeFilterCount` — it modifies the colour filter rather than being one —
            so the strip states it as a word inside the colour chip, `Colour: exactly White,
            Blue`, and that chip's × clears it with the colours. */}
        <ColorExactChip pressed={search.colorsStrict} onClick={search.toggleColorsStrict} />
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
            and this one has to be unambiguous *wherever* it is. `PrintingsFilterBar` made
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

      {/* The second hairline, and it precedes the grid-or-table pair, which is about the drawing
          rather than about which cards there are — so, like the sort, it is neither counted by
          the badge nor cleared by Reset all. */}
      {layoutToggle && (
        <div
          aria-hidden="true"
          className="order-[8] hidden h-9 w-px bg-border @min-[640px]/fb:block"
        />
      )}

      {/* **The pair's own group, kept as a wrapper so `order` can place it.** It is a view mode
          rather than a filter — how the rows are laid out — so it sits past the divider with the
          sort rather than among the statements about which cards to show. The wrapper was lifted
          out of {@link ViewToggle} while the Flatten switch shared it, and it stays because the
          `order-[40]` / `@min-[640px]/fb:order-[9]` reasoning below is the wrapper's, not the
          pair's.

          **`ml-auto` on `LayoutToggle`'s own group survives this and does nothing**, which was
          worth checking rather than assuming: an auto margin absorbs positive free space, and
          this wrapper is a flex item at `flex: 0 1 auto` whose base size is its contents — so
          there is none to absorb. Swept in headless Chromium over this row's real markup and the
          app's own compiled stylesheet, 206px to 1700px in 2px steps (2026-08-26):
          `margin-left` computed to `0px` at every width, the chip stood exactly the wrapper's
          8px from the pair at every width while Flatten shared the wrapper, the two never landed
          on different lines, and forcing the margin to zero changed no measurement. **jsdom
          applies no container query and loads no stylesheet**, so none of that is visible to the
          suite.

          **`order-[40]`, and not `order-[9]` unconditionally.** At 640 and up the group rides
          the first line past the divider, which is where the design puts it; below that there is
          no first line to ride — the colours already share theirs with Filters — so an
          `order-[9]` would strand it on a line of its own between the colours and the mana
          values. Ordered past the sort instead, it shares that line, which is the other control
          on this bar that is about how the results are *shown* rather than which ones there
          are. */}
      {layoutToggle && (
        <div className="order-[40] flex items-center gap-2 @min-[640px]/fb:order-[9]">
          <ViewToggle section={layoutFor} />
        </div>
      )}

      {/* **Reset all, at the far end of the bar — and drawn whether or not there is anything to
          reset**, greyed at zero. It moved up from a line of its own under the bar on 2026-09-27
          (the collection and wishlist header redesign, option A): that line was unconditional for
          this button's sake alone, so on every unfiltered page it was a 57px band holding one
          greyed control. Unconditional *here* keeps the rule it was drawn for — a control that
          appears mid-press moves everything beside it — because it never appears: it holds its
          width on the bar from the first paint, and the chips line below is what comes and goes.

          **Three places, one per band, and each is where a line had room — swept in Storybook
          against the real stylesheet on 2026-09-27, 230px to 2400px.** From 900 it ends the first
          line (`order-[9]`, after the view pair in the tree, so a surface without one ends the
          line with it too); at 1500, where the bar is one line, that costs the search box width
          and it still reads 269px at a 1501px container. Between 640 and 900 the first line has
          no room left — pinned there it wrapped onto a line of its own and pushed the sort onto
          a third — so it ends the second line instead, after the sort (`order-[35]`), which has
          room from a 685px container up; in the 640–670 sliver below that it takes a third line
          of its own, which is still shorter than the ruled row it replaced. Below 640 it follows
          the sort's own line (`order-[45]`), which is where the docked deck panel's narrow bar
          has room for it. The hairline is its own, so a surface without the view pair still
          separates it from the sort. */}
      <div className="order-[45] flex items-center gap-2 @min-[640px]/fb:order-[35] @min-[640px]/fb:gap-x-2.5 @min-[900px]/fb:order-[9] @min-[900px]/fb:gap-x-3">
        <div aria-hidden="true" className="hidden h-9 w-px bg-border @min-[640px]/fb:block" />
        <ResetAll count={search.activeCount} onReset={search.resetAll} />
      </div>

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
  );

  /**
   * **The search, in words — drawn only when there is something to say.**
   *
   * This row was unconditional until 2026-09-27, and the whole reason was Reset all, which lived
   * at its right end: always drawn and greyed at zero, because a control that appears mid-press
   * moves everything beside it. On every unfiltered page that made it a ruled band of 57px with
   * one greyed button in it. Reset all is on the bar now (see the note in `row`), still
   * unconditional there, so what is left here is the chips — and an appearing chip line moves
   * only the wall of cards, which has just been re-queried and is moving anyway. No rule over it
   * either: the rule separated a permanent row from the bar, and a row that is only there while
   * the reader is filtering is read as the bar's own second line.
   */
  const statedFilters = chips.length > 0 && (
    <div className="flex flex-wrap items-center gap-2">
      <span className={cn(FILTER_LABEL, "shrink-0")}>Filtering by</span>
      {chips.map((chip) => (
        <ActiveFilterChip key={chip.label} label={chip.label} onRemove={chip.remove} />
      ))}
    </div>
  );

  return (
    // **A named container, and the name is what keeps it from being claimed by another.**
    // `@container` variants bind to the nearest ancestor container, so an unnamed one here would
    // be the box any future `@container` in a card tile or a panel resolved against. Everything
    // below reads `/fb` explicitly.
    //
    // **Nothing that has to cover the window may be mounted inside it.** `container-type:
    // inline-size` applies **layout containment**, and a layout-contained box is the containing
    // block for every `fixed` descendant under it — so a `Dialog`, whose scrim is a bare
    // `fixed inset-0` with no correction of its own, opened from in here would stretch to this
    // bar rather than to the window. The dropdowns escape it the other way: `usePopupPlacement`
    // measures a zero-size frame precisely so it can subtract whatever containing block it landed
    // in. **jsdom applies no stylesheet and computes no containment**, so nothing in the suite
    // can see the failure; `packages/ui/CLAUDE.md` carries the rule.
    <div ref={rootRef} className="@container/fb flex flex-col gap-2">
      {row}

      {trayOpen && (
        <FilterTray
          id={trayId}
          search={search}
          cells={tray}
          labels={labels}
          formatOptions={formatOptions}
        />
      )}

      {statesFilters && statedFilters}

      {/* The chips a typed `otag:ramp` produces, and the note an unknown tag name gets. Under the
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
  // The pinned `Any card` and `Any format`, then the formats — `formatPickerRows`, which the
  // phone's filters sheet reads too.
  const formatDropdownOptions = formatPickerRows(search, formatOptions);
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
          hint="Only copies not used in a deck"
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
              className="flex-1"
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
        <div role="group" aria-label="Border" className="flex flex-wrap gap-1.5">
          {BORDERS.map((b) => {
            const pressed = search.borders?.includes(b) ?? false;
            return (
              <ToggleChip
                key={b}
                label={BORDER_LABEL[b]}
                pressed={pressed}
                // The selected arm, like the types above: a border the reader picked stays
                // pressable however its own count reads, so the way out is never what greys.
                disabled={optionDisabled(facets?.borders, b, pressed)}
                title={facetTitle(BORDER_LABEL[b], facets?.borders?.[b])}
                onClick={() => search.toggleBorder?.(b)}
                className="flex-1"
              />
            );
          })}
        </div>
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
        <div role="group" aria-label="Finish" className="flex flex-wrap gap-1.5">
          {FINISHES.map((f) => {
            const pressed = search.finishes?.includes(f) ?? false;
            return (
              <ToggleChip
                key={f}
                label={FINISH_LABEL[f]}
                pressed={pressed}
                disabled={optionDisabled(facets?.finishes, f, pressed)}
                title={facetTitle(FINISH_LABEL[f], facets?.finishes?.[f])}
                onClick={() => search.toggleFinish?.(f)}
                className="flex-1"
              />
            );
          })}
        </div>
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
  const tagsView = useAppStore((s) => s.tagsView);
  const collectionView = useAppStore((s) => s.collectionView);
  const wishlistView = useAppStore((s) => s.wishlistView);
  const setSearchView = useAppStore((s) => s.setSearchView);
  const setTagsView = useAppStore((s) => s.setTagsView);
  const setCollectionView = useAppStore((s) => s.setCollectionView);
  const setWishlistView = useAppStore((s) => s.setWishlistView);
  const view = {
    search: searchView,
    tags: tagsView,
    collection: collectionView,
    wishlist: wishlistView,
  }[section];
  const onChange = {
    search: setSearchView,
    tags: setTagsView,
    collection: setCollectionView,
    wishlist: setWishlistView,
  }[section];
  return <LayoutToggle view={view} onChange={onChange} />;
}

