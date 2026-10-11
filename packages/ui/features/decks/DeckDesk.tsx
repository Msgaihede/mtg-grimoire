import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import {
  FILTER_CONTROL,
  FILTER_FOCUS,
  filterChipState,
  ToggleChip,
} from "@/components/FilterChips";
import type { MenuItem } from "@/components/menu/types";
import { usePublishCardWalk } from "@/features/card/cardWalk";
import { FOCUS } from "@/lib/focus";
import type { DeckCard, DeckVariant } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { sortOptions } from "@/lib/options";
import { useCardSelection } from "@/lib/useCardSelection";
import { clearFieldOnEscape } from "@/lib/useDismissOnEscape";
import { useScrollPerView } from "@/lib/useScrollPerView";
import { cn } from "@/lib/utils";
import type { DeckCardActions, DeckCardGroupDrag, DeckCardMenuHandlers } from "./cardControl";
import { DeckHeaderBar, type DeckHeaderBarProps } from "./DeckHeaderBar";
import { deckSlotOrder, deckWalkStops, type WalkTokenPile } from "./deckWalk";
import { deckCardSlot, type DeckWrite, type DragPayload } from "./dnd";
import {
  buildGroups,
  DEFAULT_GROUP_BY,
  GROUP_BY_OPTIONS,
  type EmptyGroupRules,
  type GroupBy,
  theoryGroupable,
} from "./grouping";
import { DEFAULT_SORT_BY, SORT_OPTIONS, type SortBy } from "./sorting";
import type { TheoryPlan } from "./theoryMatch";
import type { Deck } from "./useDeck";
import { needleMatches, useDeckCardQuery } from "./useDeckCardQuery";
import type { ValidationIssue } from "./validation/types";
import { GridView } from "./views/GridView";
import { StackView } from "./views/StackView";
import { TableView } from "./views/TableView";
import { TextView } from "./views/TextView";
import type { TokenPile } from "./views/TokenPile";

/*
 * **The desk** — the part of the deck editor that changes with every keystroke in its filter box,
 * and the part that changes with nothing else the reader does (issue #557).
 *
 * It owns the four answers about *how the deck is looked at right now*: the view, the grouping, the
 * sort, and the filter (the text box and the label chips). Everything derived from them lives here
 * too — the rows on screen, the groups, the order a Shift-click measures along, the walk the
 * printings modal steps through, the `actions` and `viewProps` every view is handed — and the
 * controls that set them: the header's third line (the toolbar) and the undocked bar's filter and
 * Display menu.
 *
 * ## Why it is a component and not a block of the editor
 *
 * **Because state re-renders the component it lives in, and nothing above it.** While these four
 * lived in `DeckEditor`, one letter typed in the filter re-rendered the editor whole: the header,
 * the ledger, the docked search wall, the stats, tokens, notes and to-do bands, every overlay, and
 * every pile on the desk. Here, a keystroke re-renders this component and what it draws — the bar,
 * the toolbar and the view — and the view's piles are memoised on their rows (`views/sameDrawn.ts`),
 * so a pile the letter took nothing from is not drawn again either. `DeckDesk.test.tsx` measures it.
 *
 * **What the editor hands in is held still there**, because a prop that changes every render of
 * the editor would be the same cost arriving by another road: the writes, the menus, the deck's
 * own derived lookups (`violations`, `theoryPlan`, `noted`, the token pile) are all memoised or
 * stable callbacks. The four pieces of the page this draws around but does not own — the header's
 * first two lines, the toolbar's quick add and undo pair, the banners, and the docked search panel
 * — arrive as **slots**: elements the editor built, which React does not redraw when only this
 * component has changed.
 *
 * ## The layout it returns
 *
 * A fragment, so every box is still a direct child of the editor's `<section>` in exactly the order
 * it always was — the bar, the header's lines, the toolbar, the banners, then the desk row — and the
 * page's sticky boxes, its `gap-3` and its scroller see no new ancestor.
 */

/**
 * Two of the toolbar's three option lists, as the toolbar draws them: alphabetically by label.
 * The third is {@link VIEW_PICKER}, which sits beside the array it sorts.
 *
 * Sorted here rather than trusted from `grouping.ts` and `sorting.ts`, whose arrays are named
 * in domain order and happen to read alphabetically today — which is exactly how an ordering
 * drifts the day somebody appends a fourth grouping or a fifth sort. Module level, so the sort
 * is paid once per session rather than once per render of the largest component in the app.
 */
const GROUP_BY_PICKER = sortOptions(GROUP_BY_OPTIONS, (o) => o.label);
/** The picker on a list with no plan to match against — see `theoryGroupable`. */
const GROUP_BY_PICKER_NO_THEORY = GROUP_BY_PICKER.filter((o) => o.value !== "theory");
const SORT_BY_PICKER = sortOptions(SORT_OPTIONS, (o) => o.label);

/**
 * The shortest the desk row may be squeezed to — `DECK_FLOOR`'s rule turned on its side, because
 * the stats band is the first thing this editor has ever stacked *below* the deck rather than
 * beside it.
 *
 * **It is a floor and no longer also a ceiling, and it moved off the desk row to say so**
 * (2026-08-14). The row used to be exactly as tall as whatever the page could spare, never less
 * than this and never more, and the deck's view scrolled inside it — the
 * scrollbar-in-the-deck-builder this floor's own arithmetic was written around. The views grow
 * now, so this says only how short the deck may get: four nearly empty piles still draw a desk
 * one card tall, rather than a strip of headings with the price line under it.
 *
 * **It is on the view and not on the row, and that is the whole of the bug it fixed.** The row
 * is `flex-1` — `flex: 1 1 0%` — inside the page, and a flex item's automatic minimum size is
 * what stops it being squeezed below its content. `min-h-96` *replaces* that `auto`: with a
 * number there the row has no content-based minimum left, so it takes the free space, floors at
 * 384, and lets a taller deck spill out of it. Measured in the shipped window on a 132-card,
 * 17-pile deck at 1280×800, with the class still on the row: the deck drew **2 783px** of piles
 * in a desk box of **384**. It *looked* right — the piles paint, and the page counted them, so
 * the editor scrolled to 2 996 — and two things behind it were wrong. The price strip and the
 * stats band were laid out from the foot of the 384, i.e. over the deck rather than under it;
 * and `position: sticky` is clamped to its containing block, so the search panel could follow
 * the reader for 384px and was then dragged off the top of the window with the box it was in.
 * On the view the number is a `min-height` on a stretched flex item, which floors it without
 * capping it — the row is then as tall as the view, and the row's own `auto` minimum is back.
 *
 * **All four views take it, unconditionally, since 2026-09-08 — the table was the last exception
 * and it is gone.** `Table` was drawn as a scroller of exactly the desk's height for as long as
 * `VirtualTable` could only *be* a scrollport: it mounts the rows in view and holds a spacer open
 * for the rest, so a virtualiser given no height rendered every row of the deck. It opts into
 * growing now (`VirtualTable`'s `grow`) and does render every row, which is the trade this list's
 * size affords — a deck is a few hundred rows, and the 100k-row walls the virtualiser was built
 * for are the search's, the collection's and the wishlist's, none of them touched by this. So the
 * reader's own complaint is answered at the source: the table has no scrollbar of its own and
 * draws at its full height, like the three walls beside it in the same picker.
 *
 * **What that ended is a merge order, and the rule behind it is worth keeping.** This class used
 * to be written *before* the table branch's `min-h-0` in the same `cn` call, on purpose: the two
 * are one tailwind-merge group, the later wins, and the virtualised table had to keep the
 * squeezable box it had always had — a floor under a scrollport being a floor under a scrollbar.
 * With the branch gone the floor is passed alone and merges against nothing, but the rule is the
 * one any future conditional class here would have to obey: a `min-h-*` and a `min-h-0` in one
 * `cn` are not two facts, they are one, and the last one written is the answer.
 *
 * Everything below is the measurement 384 came from and the reasoning for the page scroller,
 * both of which stand.
 *
 * **384px, and it is a measurement rather than a taste**: a stack group holding one card is
 * exactly that tall in the shipped window — 6px of column padding, a 43px group heading, the
 * 319px card, `stackHeight`'s 8px tail and 6px more padding. One whole card is the floor because
 * a deck view that cannot draw one has stopped being a deck view. Measured at 1280×800 with a
 * content-height band and no floor at all, the row came out at **246px**: the commander was cut
 * through the middle of its art, every column grew a scrollbar, and the docked panel's results
 * spilled out from under it.
 *
 * **So the editor scrolls, and that is the trade this whole arrangement is.** Three things want
 * the column's height — the deck, the price strip and the band — and at 1280×800 they come to
 * **886px** in a **702px** editor (710 when the editor was first measured, less the 8px the
 * ribbon gained on 2026-08-14). The pair was re-measured later that day, in the shipped window
 * on a 14-card Commander deck: **886** with the ribbon's `py-1.5` and 36px chrome, **866** with
 * both backed out in the page, so the two together cost **20px** — 12 of padding and 4 on each
 * of the two rows, the header's second line included, because at 1280 that line *is* the
 * controls. **The deck's own share did not move**: both numbers are far past 702, so the floor
 * below governs the deck and the 20px comes off the tail of the stats band, which was already
 * one scroll down. (847 is the figure that stood here before that pass, taken on an earlier
 * sitting and not on this deck — the pair above is the like-for-like one.) Rather than cut one
 * of them, the section is
 * `overflow-y-auto`: the deck holds at least 384, the band draws whole, and whatever does not
 * fit is one scroll away. At 1920×1080 a deck that fits does not scroll at all and takes the
 * surplus (**519px**); a deck that does not fit is now what pushes the band down the page, where
 * before it was the band pushing the deck into a letterbox of its own. A band
 * that shrank instead was measured at **92px** with 229px of charts inside it, which is a
 * scrollbar over a chart nobody can read — the thing `DeckStats` refuses when it wraps rather
 * than truncates.
 *
 * Written out whole rather than built from the number — Tailwind scans source text for class
 * names, and one assembled at runtime emits no rule at all.
 */
const DECK_HEIGHT_FLOOR = "min-h-96";

/** Stable identity for "no label chip is pressed", so the memo below does not re-run on every
 *  render. The other half of that filter — the ledger's `Game Changers` chip — is a boolean and
 *  needs no such identity. */
const NO_LABELS: readonly number[] = [];

/** How a deck is drawn, and what the switch calls each one. */
type DeckView = "stacks" | "table" | "text" | "grid";
const VIEWS: readonly { id: DeckView; label: string }[] = [
  { id: "stacks", label: "Stacks" },
  { id: "table", label: "Table" },
  { id: "text", label: "Text" },
  { id: "grid", label: "Grid" },
];

/**
 * The view every deck opens on — and, *because* it is that, the row {@link VIEW_PICKER} pins
 * above the alphabet. One constant serves both, so the pinned row cannot come to name a view a
 * deck does not actually open on: change this and the picker's first row follows it, which is
 * the whole argument for the pin stated as code rather than kept in two places.
 */
const DEFAULT_VIEW: DeckView = "stacks";

/**
 * The view switch as the toolbar draws it — a `Dropdown`, like the two pickers beside it.
 * It was a four-button segmented group until 2026-08-15, then a `<select>` like its two
 * neighbours, then (2026-08-26) all three moved onto `components/Dropdown` — see
 * {@link VIEW_OPTIONS}, which is this array reshaped for that component's `options`.
 *
 * **Three controls answering three questions about one list, in one grammar.** `View` says how a
 * card is drawn, `Group by` says what the headings are and `Sort` says the order inside one;
 * drawing the first as a four-button segmented group and the other two as selects made the
 * odd one out the one a reader reaches for most, and spent a quarter of the toolbar's width on
 * three answers nobody had asked for. A dropdown costs one press to open and shows the picked
 * view when it is shut, which is what the pressed button was doing at four times the width.
 *
 * **`Stacks` is pinned above the alphabet and the other three are sorted under it**, so the list
 * reads `Stacks · Grid · Table · Text` (2026-09-08, the reader's ask). That is the app's third
 * option-list shape rather than a third exemption from the sort: `packages/ui/CLAUDE.md` names the rows
 * that stay outside it — `Any card`, `Any format`, `Custom…`, `Auto (by what it does)`,
 * `Top level` — and this is one of them. {@link DEFAULT_VIEW} is what every deck opens on, the
 * other three are the alternates *to* it, and the stacked desk is the signature interaction of
 * the whole builder, so it is the row a reader learns the **position** of rather than hunts for
 * by word. Everything the pin does not name still goes through
 * `sortOptions`, which is what keeps a fifth view alphabetical with nobody having to think about
 * it — and the pin is spelled as a filter over {@link VIEWS} rather than as a reordering of that
 * array, so the label is never written twice and `DeckView`'s own order is untouched.
 *
 * **What this replaces is a straight `sortOptions(VIEWS, …)`**, whose doc argued at length that
 * the array is written in the order the views were built, reads as a decision nobody made, and
 * fits neither exemption this app grants (an order that *is* the information, like a grade scale;
 * an order the reader arranged themselves, like their own categories). Every word of that is
 * still true and none of it was what settled this — a pinned row is not an exemption, so the
 * alphabet still governs the rest of the list and there is no order here claiming to carry
 * information. Computed at module level for {@link GROUP_BY_PICKER}'s reason.
 */
const VIEW_PICKER: readonly { id: DeckView; label: string }[] = [
  ...VIEWS.filter((v) => v.id === DEFAULT_VIEW),
  ...sortOptions(
    VIEWS.filter((v) => v.id !== DEFAULT_VIEW),
    (v) => v.label,
  ),
];

/**
 * {@link VIEW_PICKER}, reshaped for `<Dropdown>`'s `options` prop — `id` renamed to `value`,
 * the field every `DropdownOption` is keyed on, and nothing else moved. Two names for the same
 * list rather than one: `VIEWS`' own `id` field is `DeckView`-typed and read straight into
 * `setView`, and renaming it there would ripple into every other reader of `DeckView` far past
 * this toolbar.
 */
const VIEW_OPTIONS: readonly DropdownOption[] = VIEW_PICKER.map(({ id, label }) => ({
  value: id,
  label,
}));

/**
 * What the editor's restore put back for this deck — the grouping and the sort the deck row
 * remembers. **A fresh object per restore**, and this component adopts it during its own render
 * when the identity changes (React's "adjusting state when a prop changes"), which is the whole of
 * how the restore crosses the seam.
 *
 * Why it crosses at all rather than living here: the restore is honoured once per *deck and
 * reading of the theory switch*, and its marker moves the variant in the same breath — the editor's
 * comment over it has the two crashes that rule was paid for with. The variant is the editor's, so
 * the marker is too, and what it decides about the two pickers is handed down as this.
 */
export interface RestoredView {
  groupBy: GroupBy;
  sortBy: SortBy;
}

/** The undocked bar's props less the four this component answers. */
export type DeckBarProps = Omit<
  DeckHeaderBarProps,
  "displayName" | "displayMenu" | "filter" | "onFilter"
>;

export interface DeckDeskProps {
  deckId: number;
  /** The deck row, or `null` before `deck_get` answers — every box here is drawn only once it has. */
  row: Deck["deck"];
  variant: DeckVariant;
  theoryEnabled: boolean;
  /** See {@link RestoredView}. */
  restoredView: RestoredView | null;
  /** `deck.rememberView.mutate` — the grouping and the sort survive the deck being closed. */
  rememberView: Deck["rememberView"]["mutate"];
  /** `deck.update.mutate` — the `Split X` chip's write. */
  updateDeck: Deck["update"]["mutate"];
  cards: Deck["cards"];
  labels: Deck["labels"];
  categories: Deck["categories"];
  separateX: boolean;
  /** The ledger's `Game Changers` chip, as the filter reads it — the editor's `gcFilter`. */
  gcFilter: boolean;
  emptyGroupRules: EmptyGroupRules;
  theoryPlan: TheoryPlan | undefined;
  marketplace: Marketplace;
  violations: Map<string, ValidationIssue[]> | undefined;
  noted: ReadonlySet<string>;
  tracks: boolean;
  openCard: (card: DeckCard) => void;
  landed: ReadonlyMap<number, number>;
  selectedSlot: string | null;
  tokenPile: TokenPile | undefined;
  /** The token pile as the printings modal's walk counts it, or nothing before the row lands. */
  walkTokens: WalkTokenPile | undefined;
  hiddenStacks: ReadonlySet<number>;
  showStack: (categoryId: number) => void;
  setQuantity: (card: DeckCard, quantity: number) => void;
  applyDrops: (writes: DeckWrite[]) => void;
  /** One deck card's right-click; `flips` is whether the view on screen draws the card's picture,
   *  which is when its menu offers "Flip card" (issue #844). */
  deckCardMenuFor: (card: DeckCard, flips: boolean) => DeckCardMenuHandlers;
  /** One pile's right-click; `stacks` is whether the Stacks view is the one drawn, which is the
   *  only view `Hide` / `Unhide` is offered in. */
  categoryMenuFor: (categoryId: number, stacks: boolean) => DeckCardMenuHandlers | undefined;
  renameCategoryField: (categoryId: number) => ReactNode;
  moveCategory: (categoryId: number, targetId: number) => void;
  /** The picked set, read at the moment a drag asks — see the editor's `pickedRef`. */
  pickedRef: RefObject<readonly DeckCard[]>;
  /** The desk row — the editor measures it, this component draws it. */
  deskRef: RefObject<HTMLDivElement | null>;
  barClearance: number;
  tightHeader: boolean;
  /** The toolbar line's callback ref — the editor's `useUndocked` watches it. */
  setToolbarLine: (line: HTMLDivElement | null) => void;
  /** The undocked bar's own props, or `null` before the row lands. */
  bar: DeckBarProps | null;
  /** The header's first two lines — the ribbon and the ledger. */
  header: ReactNode;
  /** The toolbar's first two groups — the quick add and the undo pair. */
  tools: ReactNode;
  /** The banners and the load / read-failure / gone lines between the toolbar and the desk. */
  notices: ReactNode;
  /** The docked search panel's dock — the desk row's second child. */
  dock: ReactNode;
}

export function DeckDesk({
  deckId,
  row,
  variant,
  theoryEnabled,
  restoredView,
  rememberView,
  updateDeck,
  cards,
  labels,
  categories,
  separateX,
  gcFilter,
  emptyGroupRules,
  theoryPlan,
  marketplace,
  violations,
  noted,
  tracks,
  openCard,
  landed,
  selectedSlot,
  tokenPile,
  walkTokens,
  hiddenStacks,
  showStack,
  setQuantity,
  applyDrops,
  deckCardMenuFor,
  categoryMenuFor,
  renameCategoryField,
  moveCategory,
  pickedRef,
  deskRef,
  barClearance,
  tightHeader,
  setToolbarLine,
  bar,
  header,
  tools,
  notices,
  dock,
}: DeckDeskProps) {
  const [view, setView] = useState<DeckView>(DEFAULT_VIEW);
  // The two the deck row remembers, seeded from the same constants a stored word this build
  // cannot draw falls back to — so "never chosen" and "chosen and since dropped" are one state
  // rather than two. The restore below overwrites both the moment the row lands.
  const [groupBy, setGroupBy] = useState<GroupBy>(DEFAULT_GROUP_BY);
  const [sortBy, setSortBy] = useState<SortBy>(DEFAULT_SORT_BY);
  const [filter, setFilter] = useState("");
  /**
   * The box read as a search box reads it — Scryfall's syntax and the app's (issue #621): the
   * free text stays a substring of the name or type line, answered here per keystroke, and every
   * typed term (`t:`, `cmc>=`, `kw:`, `otag:`…) is answered by `deck_query_cards` through the
   * search's own SQL. `useDeckCardQuery` carries the split and its reasons.
   */
  const cardQuery = useDeckCardQuery(deckId, filter);
  const [labelIds, setLabelIds] = useState<readonly number[]>(NO_LABELS);

  /**
   * The editor's restore, adopted — see {@link RestoredView}. During render, for the reason the
   * editor's own restore is: a value adopted in an effect would draw one frame of the defaults
   * first, and this repo's lint refuses a `setState` in an effect anyway. Monotone — it writes only
   * when a *new* restore arrives, and the editor makes at most two per deck — so it cannot cycle.
   */
  const [adopted, setAdopted] = useState<RestoredView | null>(null);
  if (restoredView !== adopted) {
    setAdopted(restoredView);
    if (restoredView !== null) {
      if (restoredView.groupBy !== groupBy) setGroupBy(restoredView.groupBy);
      if (restoredView.sortBy !== sortBy) setSortBy(restoredView.sortBy);
    }
  }

  // `Matches theory` is offered only where there is a plan to match (issue #502). A remembered
  // `theory` elsewhere draws as the default and is **not** written back, so pressing `Actual`
  // again brings the grouping back with the tab.
  const canGroupByTheory = theoryGroupable(theoryEnabled, variant);
  const shownGroupBy: GroupBy =
    groupBy === "theory" && !canGroupByTheory ? DEFAULT_GROUP_BY : groupBy;

  /**
   * The three toolbar controls the deck remembers, each writing **only the field that moved**.
   *
   * The state is what the editor draws and the write is what makes it survive the deck being
   * closed — in that order, and nothing waits on the answer: `rememberView` does not invalidate
   * and fails silently, so a press lands exactly as fast as it did before anything was stored.
   * Sending one field rather than three is `DeckViewState`'s absent-means-leave-it rule used
   * for what it is for — pressing Sort cannot write back a grouping read out of a stale render.
   *
   * **`pickVariant` is the editor's** since the split (issue #557): the variant decides which list
   * `useDeck` reads, so it lives where the read does, and only the grouping and the sort — the two
   * that change nothing but how the rows on screen are arranged — are this component's.
   */
  const pickGroupBy = (next: GroupBy) => {
    setGroupBy(next);
    rememberView({ groupBy: next });
  };
  const pickSortBy = (next: SortBy) => {
    setSortBy(next);
    rememberView({ sortBy: next });
  };

  // **Each view keeps its own place on the page** (issue #567). All four scroll `AppShell`'s one
  // `main`, so without this a switch carried the departing view's `scrollTop` into the arriving
  // one — two thousand pixels down a Stacks desk was two thousand pixels down a Grid wall that
  // lays the deck out nothing like it. `parkScroll` records where the departing view was and must
  // run **before** `setView`, while the box still holds it; `useScrollPerView` has why.
  const parkScroll = useScrollPerView(deskRef, view);

  /**
   * The bar's Display: the toolbar's three pickers as one menu of three submenus, each a column
   * of radio rows (issue #577). **The same option lists the pickers draw** — {@link VIEW_PICKER},
   * the two group-by lists behind {@link canGroupByTheory}, {@link SORT_BY_PICKER} — and the same
   * three writes, `parkScroll` included, so a press here and a press in the toolbar cannot come
   * to mean different things. `Split X` stays the toolbar's alone: it is a modifier of one
   * grouping, drawn only beside it, and a menu row that appeared under one answer of a sibling
   * submenu would be a row nobody finds.
   *
   * Built at the press, as `menuClick` asks, so the checked rows are the state of that moment.
   */
  const groupByPicker = canGroupByTheory ? GROUP_BY_PICKER : GROUP_BY_PICKER_NO_THEORY;
  const displayMenu = (): MenuItem[] => [
    {
      kind: "submenu",
      id: "view",
      label: "View",
      items: VIEW_PICKER.map(({ id, label }) => ({
        kind: "radio",
        id: `view-${id}`,
        label,
        checked: view === id,
        onSelect: () => {
          parkScroll();
          setView(id);
        },
      })),
    },
    {
      kind: "submenu",
      id: "group-by",
      label: "Group by",
      items: groupByPicker.map(({ value, label }) => ({
        kind: "radio",
        id: `group-by-${value}`,
        label,
        checked: shownGroupBy === value,
        onSelect: () => pickGroupBy(value),
      })),
    },
    {
      kind: "submenu",
      id: "sort",
      label: "Sort",
      items: SORT_BY_PICKER.map(({ value, label }) => ({
        kind: "radio",
        id: `sort-${value}`,
        label,
        checked: sortBy === value,
        onSelect: () => pickSortBy(value),
      })),
    },
  ];
  /**
   * The Display button's name and tooltip: the three answers it is standing on, because the
   * button is a glyph and what it would change is otherwise only visible by opening it.
   */
  const displayName = `Display — ${[
    `View: ${VIEW_PICKER.find((v) => v.id === view)?.label ?? view}`,
    `Group by: ${groupByPicker.find((o) => o.value === shownGroupBy)?.label ?? shownGroupBy}`,
    `Sort: ${SORT_BY_PICKER.find((o) => o.value === sortBy)?.label ?? sortBy}`,
  ].join(", ")}`;

  const { needle, matching } = cardQuery;

  /**
   * The rows on screen: the deck, narrowed by the two filters the toolbar carries.
   *
   * Filtering happens **before** the grouping, so every count and price in a heading is a count
   * of what is under it — a group saying 60 over four visible rows is a heading that lies about
   * the only thing it is for.
   *
   * **The chips are an `OR` among themselves and an `AND` with the text box**, and the
   * game-changer chip joined the first of those rather than the second (2026-09-09, the reader's
   * call). An `AND` would be near useless: a game changer rarely wears a label, so ticking both
   * would empty the wall and read as the filter having broken.
   *
   * **That survived the chip moving back to the ledger (2026-09-10) and the argument for it
   * changed shape.** It used to be *one row of chips asks one question*, which was a fact about
   * the row they shared; the two controls are a header apart now, so what is left is the failure
   * itself — the pair of presses a reader is likeliest to make would answer with an empty desk.
   *
   * **Filtering used to decide which headings exist and no longer decides anything about it.**
   * `emptyGroupRules` carried a `narrowed` flag: while this filter was running, `grouping.ts`'
   * `drawsWhenEmpty` kept only the four seeded zones, because three letters in the box otherwise
   * answered with twenty headings over three rows. That wall was always made of piles the *app*
   * had created while filing cards, and those hide whenever they are empty now — filter or no
   * filter, since a pile this filter empties is an empty pile. So a filtered deck answers with
   * the reader's own deliberate piles and the fixed zones, which is what the narrowing was
   * reaching for, and **emptying a pile by hand and emptying it with the box are the same answer
   * again**. The shape of the deck still changes as they type — that is what a filter is — but
   * an empty pile of theirs stays on screen and stays a drop target while it does.
   *
   * **The text box is two filters since issue #621, ANDed**: its free text (`needleMatches`, the
   * substring test it always was) and its typed terms (`matching`, a set of printings Rust
   * answered, or `null` while no term narrows). See {@link useDeckCardQuery}.
   */
  const shown = useMemo(() => {
    // Whether *any* chip in that row is pressed, which is the one thing the OR needs to know:
    // no chip is no chip filter, exactly as an empty `labelIds` was on its own.
    const chips = labelIds.length > 0 || gcFilter;
    if (!needle && !chips && matching === null) return cards;
    return cards.filter(
      (card) =>
        (!chips ||
          (gcFilter && card.gameChanger === true) ||
          (card.labelId !== null && labelIds.includes(card.labelId))) &&
        needleMatches(card, needle) &&
        // The typed terms, answered per printing — so a foil and a regular copy of one card,
        // or one card in two piles, always stand or fall together.
        (matching === null || matching.has(card.cardId)),
    );
  }, [cards, needle, matching, labelIds, gcFilter]);

  const groups = useMemo(
    // No currency any more: the rows this groups arrived priced at the selected marketplace,
    // because that marketplace is in `useDeck`'s query key. A switch therefore changes
    // `deck.cards` itself and this recomputes over the new answer, rather than picking a
    // different field out of the old one.
    () =>
      buildGroups(shown, categories, shownGroupBy, sortBy, separateX, emptyGroupRules, theoryPlan),
    [shown, categories, shownGroupBy, sortBy, separateX, emptyGroupRules, theoryPlan],
  );

  /**
   * The deck's rows as a flat list of slots, in the order the desk draws them — what a
   * Shift-click measures a range along (issue #214).
   *
   * `deckSlotOrder` and not `deckWalk` beside it, though the two walk the same groups in the same
   * order: the walk drops orphaned rows because it steps *through printings*, and an orphan is
   * still a card the reader can see and pick. A range that silently skipped a row on screen is
   * the one failure this list cannot have.
   */
  const slotOrder = useMemo(() => deckSlotOrder(groups), [groups]);

  /**
   * The cards the reader has Ctrl- and Shift-clicked, scoped to **this deck**.
   *
   * A deck id in the scope because two decks are two surfaces: the slots are
   * `<category>:<card>:<finish>` and a category id is per-deck, so a set carried across a close
   * and an open would address piles of a deck that is no longer on screen.
   */
  const picked = useCardSelection(`deck:${deckId}`, slotOrder);

  /**
   * What a card's drag asks the selection — {@link DeckCardGroupDrag}, held still on purpose.
   *
   * Both live values it reads come off refs, which is what lets this object keep one identity for
   * the life of the editor: it lands in every card's `useDeckCardDrag` dependency list, and a
   * fresh one per render would tear four hundred drag registrations down each time the reader
   * Ctrl-clicked — a source unregistering mid-gesture is a drop that never arrives.
   *
   * `dragsAll` is asked first and has a side effect by design: a card picked up from *outside* the
   * set throws the set away, so a stray drag can never rearrange cards the reader had forgotten
   * were picked.
   */
  const dragsAllRef = useRef(picked.dragsAll);
  useEffect(() => {
    dragsAllRef.current = picked.dragsAll;
  }, [picked.dragsAll]);
  const groupDrag = useMemo<DeckCardGroupDrag>(
    () => ({
      rest: (slot) => {
        if (!dragsAllRef.current(slot)) return [];
        return pickedRef.current
          .filter((card) => deckCardSlot(card.categoryId, card.cardId, card.finish) !== slot)
          .map((card): DragPayload => ({
            kind: "deck-card",
            cardId: card.cardId,
            name: card.name,
            fromCategoryId: card.categoryId,
            finish: card.finish,
          }));
      },
    }),
    // The picked set's ref, handed in from the editor — stable for its life, and named only because
    // it arrives as a prop now rather than being declared beside this memo.
    [pickedRef],
  );

  /**
   * A press on a deck card, with the chords it was holding — the seam every view calls before it
   * opens the pane.
   *
   * It answers `true` for a chord, and the view then does nothing else. A plain click has already
   * collapsed the set to this one card by the time this returns `false`, which is what keeps the
   * ring and the pane agreeing without the views knowing either exists.
   *
   * **The pick is read through a ref since issue #557**, `dragsAllRef`'s arrangement one memo up.
   * `useCardSelection`'s `pick` closes over the order a Shift-click measures along, which is a new
   * array per keystroke in the filter — so a callback that named it directly was a new `actions` per
   * keystroke, and every pile on the desk was handed a changed prop for a letter that moved none of
   * them. A press reads the ref after the commit that drew the pile it lands on, so it always asks
   * the order on screen.
   */
  const pickRef = useRef(picked.pick);
  useEffect(() => {
    pickRef.current = picked.pick;
  }, [picked.pick]);
  const pickCard = useCallback(
    (card: DeckCard, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
      pickRef.current(deckCardSlot(card.categoryId, card.cardId, card.finish), event),
    [],
  );

  /**
   * One pile's right-click, for the view on screen — the editor's builder told whether that view is
   * Stacks, the one view a stack can be hidden in. A memo over `view`, so a switch of view hands
   * the piles a new menu and a filter keystroke does not.
   */
  const categoryMenu = useCallback(
    (categoryId: number) => categoryMenuFor(categoryId, view === "stacks"),
    [categoryMenuFor, view],
  );

  /**
   * One deck card's right-click, for the view on screen — the editor's builder told whether that
   * view draws the card's picture, which is when the menu offers "Flip card" (issue #844): Stacks
   * and Grid do, Table and Text draw none. A memo over `view` for `categoryMenu`'s reason.
   */
  const deckCardMenu = useCallback(
    (card: DeckCard) => deckCardMenuFor(card, view === "stacks" || view === "grid"),
    [deckCardMenuFor, view],
  );

  /**
   * What every view is handed, and the whole of what a card **and a pile** can be made to do.
   *
   * One object rather than six props, because it travels three components deep — the view, the
   * group, the card — and a bag that is passed on whole cannot be passed on incompletely. The
   * views spend it differently (a table gets columns, the other three get a bar over the card),
   * and every control inside it is `cardControl.tsx`'s.
   *
   * It carries two pile-level members beside the card's three, which is what `drop` always was:
   * the heading's own menu, and the rename field for the pile being renamed.
   *
   * **It is built here, below `groups`, rather than beside the writes it is made of** — moved for
   * issue #214, because three of its members are about the picked set and the set is measured
   * along the order `groups` decides. Nothing reads it before this point; `viewProps` below is
   * its only consumer.
   */
  const actions = useMemo<DeckCardActions>(
    () => ({
      setQuantity,
      drop: applyDrops,
      menu: deckCardMenu,
      categoryMenu,
      groupDrag,
      isPicked: picked.selected,
      pick: pickCard,
      renameCategory: (categoryId) =>
        categoryId === null ? null : renameCategoryField(categoryId),
      // **Only while the deck is grouped by category**, and absent is the whole of the off
      // switch — a view draws no grip without it. Under `manaValue` and `type` the headings on
      // the desk are buckets the app derived, so there is no order of the reader's on screen to
      // change; the piles that *are* real there are the switched-off ones `buildGroups` appends
      // and the command zones it heads the list with, and neither is in the flow — the first is
      // in the rail, the second in the box `splitRail` answers `command` for, whose piles are
      // drawn without a `flowWidth` and so register no grip whatever this prop says. That second
      // exemption is not this gate's doing and does not want to be: a zone pinned to the head of
      // every grouping has no position for a drag to change, under `category` least of all.
      moveCategory: shownGroupBy === "category" ? moveCategory : undefined,
    }),
    [
      setQuantity,
      applyDrops,
      deckCardMenu,
      categoryMenu,
      groupDrag,
      picked.selected,
      pickCard,
      renameCategoryField,
      shownGroupBy,
      moveCategory,
    ],
  );

  /**
   * The same deck as a **walk** — every drawn row, in the order the desk draws it — published to
   * the store so the printings modal's left/right keys can step through the deck behind it.
   *
   * It goes through the store because `AllPrintingsDialog` is mounted at `App` level, a sibling
   * of the shell, so there is no context between here and there; and it is published from here
   * rather than derived there because {@link groups} is the only place this order exists.
   * `groupBy` and `sortBy` are this component's `useState`, and the rows are `shown` — the deck
   * narrowed by the toolbar's text box and label chips. Nothing outside this file can reconstruct
   * any of that.
   *
   * **What it costs, since the input recomputes on every keystroke in that box.** `groups` is a
   * new array per letter typed, so this is a new array of ~100 lean objects per letter and a
   * `set` on the store. That is noise beside `buildGroups` itself, which runs on the same
   * keystroke over the same rows and does strictly more — a sort per pile and a price sum per
   * heading. The part worth being careful about is not the arithmetic but the **write**: a
   * zustand `set` re-runs every subscriber's selector, and the modal is the only thing in the
   * app that selects `cardWalk`. It is shut nearly always, and shut it draws nothing, so an
   * ordinary keystroke here costs one selector call and one `Object.is`. That stays true only
   * for as long as this field has one reader — a component that selected the walk to decide
   * something *else* would turn typing in a deck's filter into a re-render of a surface that has
   * nothing to do with the deck.
   *
   * Memoised so that a render which changed none of the inputs does not rewrite the store at
   * all: without it every unrelated re-render of this component — a hover on a stack, a mutation
   * settling — would publish an identical walk under a new identity and re-render the modal.
   */
  const deckWalk = useMemo(
    () =>
      deckWalkStops(
        groups,
        deckId,
        // The pile's tokens join the walk where the views draw them (issue #686) — see
        // `deckWalkStops`. Nothing until the deck row has answered, as the pile draws nothing.
        walkTokens,
      ),
    [groups, deckId, walkTokens],
  );

  // Published through the same hook the three card lists use, which is also where the two-effect
  // shape this needs — publish on change, clear once on unmount — is written down and argued.
  // `the deck` is what the modal's chevrons say they are stepping along.
  usePublishCardWalk("the deck", deckWalk);

  /**
   * What every view is handed — **memoised since issue #557**, where it used to be a fresh object on
   * every render of the editor. Every view is `React.memo`'d, and a bag rebuilt per render was a
   * changed prop per render, so any render of the editor redrew the view on screen whole. Each
   * member is now held still where it is made, so this changes when something a view draws does.
   */
  const viewProps = useMemo(
    () => ({
      groups,
      marketplace,
      violations,
      // The tokens and emblems as a pile of their own, or nothing — see {@link tokenPile}.
      tokenPile,
      // Which cards a note names, handed down whole beside `violations` and for its reason: one
      // answer about the deck that every card drawn is tested against, where a per-card lookup
      // would be a hundred answers to one question. **All four views**, so a card marked in Stacks
      // is marked in Table one toolbar press later.
      noted,
      theoryPlan,
      // Whether this deck has a binder behind it at all — {@link tracks}, handed down whole like
      // `violations` and `theoryPlan` beside it, because it is one fact about the deck that every
      // view spends differently. `TableView` drops its `Owned` column; the other three drop the red
      // shortage figure `deckCardShort` draws in a card's chin, which on a Virtual deck would be a
      // `0/1` on every card of the list — the same wall of marks all saying one untrue thing that
      // issue #354 reported of the theory list, reached from the other side. **All four**, so that
      // one toolbar press cannot change what the deck claims to own.
      tracksCollection: tracks,
      onSelect: openCard,
      actions,
      // The two marks a card can carry here, in the four views that draw them. `landed` is this
      // editor's alone: nothing outside it can add a card to the deck the reader is looking at.
      // `selectedSlot` is derived from the store just above (in `DeckEditor`, which hands it here).
      selectedSlot,
      landed,
      // No `className`, and the `min-h-0` that was here went with the desk's height (2026-08-14):
      // it said "this view may be squeezed below its content", which is the sentence that made the
      // deck builder scroll inside itself. `TableView` carried it on its own root for as long as
      // that root was a scrollport — where a virtualiser's belongs — and since 2026-09-08 it does
      // not: it passes `VirtualTable`'s `grow`, takes no height of its own and carries `min-w-0` in
      // that class's place. So the sentence is now true of all four views rather than three, and
      // none of them is handed a height by this object or asks for one.
    }),
    [
      groups,
      marketplace,
      violations,
      tokenPile,
      noted,
      theoryPlan,
      tracks,
      openCard,
      actions,
      selectedSlot,
      landed,
    ],
  );

  return (
    <>
      {/* The undocked bar (issue #577): drawn at the top of the page once the header's toolbar
          line has scrolled away, and gone again when it comes back. **Second child, for the
          quick zones' reason** — it is `sticky top-0` too, so it has to be a child of the page
          itself, and it costs no layout either (`h-0 -mb-3`). It hides for the length of a drag
          on its own monitor, which is why no `dragging` state is passed: the zones take the top
          then, and reading the drag here would re-render this editor on every `dragstart`.

          Every control in it is a second entrance to one of the header's, written once here and
          once there against the same state and the same writes — the variant, the undo stack,
          the three pickers, the filter text and the layers. Only Quick add keeps a draft of its
          own, because a half-typed name in a field that is off the page is a draft nobody sees. */}
      {bar && (
        <DeckHeaderBar
          {...bar}
          displayName={displayName}
          displayMenu={displayMenu}
          filter={filter}
          onFilter={setFilter}
        />
      )}

      {header}

      {row && (
        /**
         * The third of the header's lines: how the deck is drawn, and the two controls that
         * change it.
         *
         * **At {@link TIGHT_HEADER_PX} it reads as two sentences rather than one long run** —
         * the three pickers that decide how the deck is *drawn*, then the tools that *change*
         * it. `order` does the regrouping and a zero-height full-width child forces the break,
         * so **the DOM order is unchanged** — quick add, undo/redo, the pickers, the filter —
         * and a caret walking the row is unaffected by which line a control is painted on.
         * `order` is deliberately not a reordering anybody reads: it is one flex line becoming
         * two, and the groups within each are in the order they were written.
         */
        <div
          // What {@link undocked} watches: once this line has left the page, the bar stands in.
          ref={setToolbarLine}
          className={cn(
            "flex shrink-0 flex-wrap items-center gap-x-3 border-b border-border pb-3",
            tightHeader ? "gap-y-1.5" : "gap-y-2.5",
          )}
        >
          {tools}

          {/* **The own/need toggle stood here on 2026-08-23, moved to the search panel's card
              tab, and was deleted on 2026-08-25.** Both placements were arguments about where a
              control goes; what retired it is that the question it asked has a better answer.
              "I own this" from a wall of Scryfall printings was a silent write that filed
              collection rows for cards the reader had only searched for; the Collection tab
              searches the copies they actually hold, names the deck a spoken-for copy would come
              out of, and asks first. Every add from this editor now writes a `deck_cards` row
              and reads as missing until a copy is put behind it. */}

          {/* The first of the row's three pickers, and the one that says how a card is drawn.
              It is the same control as the two beside it on purpose — see {@link VIEW_PICKER}. */}
          <div className={cn("flex shrink-0 items-center gap-1.5", tightHeader && "order-1")}>
            <label id="deck-view-label" htmlFor="deck-view" className="text-[0.6875rem] text-dim">
              View
            </label>
            <Dropdown
              id="deck-view"
              labelledBy="deck-view-label"
              value={view}
              onChange={(value) => {
                parkScroll();
                setView(value as DeckView);
              }}
              options={VIEW_OPTIONS}
            />
          </div>

          <div className={cn("flex shrink-0 items-center gap-1.5", tightHeader && "order-1")}>
            <label
              id="deck-group-by-label"
              htmlFor="deck-group-by"
              className="text-[0.6875rem] text-dim"
            >
              Group by
            </label>
            <Dropdown
              id="deck-group-by"
              labelledBy="deck-group-by-label"
              value={shownGroupBy}
              onChange={(value) => pickGroupBy(value as GroupBy)}
              options={canGroupByTheory ? GROUP_BY_PICKER : GROUP_BY_PICKER_NO_THEORY}
            />

            {/* A modifier of the picker it stands beside, so it lives inside that cluster's
                `gap-1.5` rather than out in the toolbar's `gap-x-4` — and it is drawn **only**
                under Mana value, because there is nothing for it to say about a deck grouped by
                category or by type. A control that persists across a grouping it has no effect
                on is a control the reader has to remember the scope of.

                **Its state is the deck's, written through the same `update` the header's format
                select writes** — one `deck_update`, no `deck_cards` row touched, and a refusal
                lands in the banner above with every other write of this editor's, because the
                refusal rule lives on the mutation's single definition and never on a call site.

                The whole sentence is the chip's `title`, which `ToggleChip` also makes its
                accessible name: "Split X" alone is a control naming a thing rather than an
                action, and the name has to stand up read out of context — a screen reader gets
                no picker beside it. It begins with the visible label all the same (WCAG 2.5.3),
                so the chip is still addressable by what is written on it. */}
            {shownGroupBy === "manaValue" && (
              // `ToggleChip` (`components/FilterChips.tsx`) owns turning its `title` prop into
              // a `useTooltip()` binding internally — that file is outside this bucket, but the
              // prop's name and shape are unchanged, so this call needed no edit.
              <ToggleChip
                label="Split X"
                pressed={separateX}
                title="Split X — group X-cost cards separately instead of counting X as 0"
                onClick={() => updateDeck({ separateXGroup: !separateX })}
              />
            )}
          </div>

          <div className={cn("flex shrink-0 items-center gap-1.5", tightHeader && "order-1")}>
            <label
              id="deck-sort-by-label"
              htmlFor="deck-sort-by"
              className="text-[0.6875rem] text-dim"
            >
              Sort
            </label>
            <Dropdown
              id="deck-sort-by"
              labelledBy="deck-sort-by-label"
              value={sortBy}
              onChange={(value) => pickSortBy(value as SortBy)}
              options={SORT_BY_PICKER}
            />
          </div>

          {/* The break, and it is `aria-hidden` because it is a line ending rather than a
              control. `flex-basis: 100%` on a zero-height child fills the rest of the line it
              lands on, so everything after it starts a new one — `order-2` puts it between the
              pickers and the tools without moving either in the DOM. */}
          {tightHeader && <span aria-hidden="true" className="order-2 h-0 basis-full" />}

          {/* The deck's own labels, as filters. Nothing at all for a deck with none — an empty
              group with a name is a control that says there is something to press.

              **The row is the reader's own strings and only those** (2026-09-10). It carried the
              app's own `Game Changers` chip for a day, pinned in front of them so it would not
              drift about in an alphabet that is not its own — and a fixed chip in a row of
              arbitrary user labels is the odd one out however it is pinned. It went back to the
              ledger, where the count it belongs to has been since 2026-08-24; see
              {@link DeckLedger}. Two things about the gate went with it: the second arm
              (`|| hasGameChangers`), which drew this row for a deck with no labels at all, and
              the second half of its name.

              **A toolbar item of its own, and it was inside the filter's box until 2026-08-24.**
              That box grew a `max-w-[25rem]` ceiling in the same change — the field's, and a good
              one — and a row of arbitrary user strings crammed into 400px is not what the ceiling
              was for. */}
          {labels.length > 0 && (
            <div
              role="group"
              aria-label="Filter by label"
              className={cn("flex flex-wrap items-center gap-1.5", tightHeader && "order-3")}
            >
              {labels.map((label) => {
                const on = labelIds.includes(label.id);
                return (
                  <button
                    key={label.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setLabelIds((held) =>
                        held.includes(label.id)
                          ? held.filter((id) => id !== label.id)
                          : [...held, label.id],
                      )
                    }
                    className={cn(
                      FILTER_CONTROL,
                      FILTER_FOCUS,
                      // `FILTER_CONTROL`'s own 36px, which the `h-8` here used to override
                      // back down to the toolbar's old height. Only the type size is still
                      // overridden: a deck's labels are a row of arbitrary user strings, and
                      // 14px of them is a line that pushes the filter field off the end.
                      "px-2.5 text-xs",
                      filterChipState(on),
                    )}
                  >
                    {label.name}
                  </button>
                );
              })}
            </div>
          )}

          <div
            className={cn(
              // The design's own shape: the field takes the line's leftover between a floor and
              // a ceiling, rather than the fixed 176px it drew before. `ml-auto` is inert while
              // there is anything left to grow into and pins the box right once the ceiling
              // binds — a search box as wide as a maximised window is a box whose text sits
              // alone in the middle of the desk.
              "ml-auto flex min-w-40 max-w-[25rem] flex-1 items-center",
              tightHeader && "order-3",
            )}
          >
            <input
              type="search"
              aria-label="Filter this deck"
              placeholder="Filter this deck…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              // **A box with text in it owns one Escape, and an empty one owns none.** Without
              // this the press would empty the box *and* close the deck behind it: Chromium
              // clears an `<input type="search">` on Escape by itself and does **not** set
              // `defaultPrevented`, so the `"navigation"` rung above would take the same press.
              // jsdom implements no native clear, so only the second half of that is visible to
              // this suite — the reason is on {@link clearFieldOnEscape}.
              onKeyDown={(e) => clearFieldOnEscape(e, filter, () => setFilter(""))}
              className={cn(
                "h-9 min-w-0 flex-1 rounded-md border border-border bg-bg px-2.5 text-xs",
                FOCUS,
              )}
            />
          </div>
        </div>
      )}

      {notices}

      {row && (
        // The deck on the left and the way cards get into it on the right (spec §7). One flex
        // row, so both are the full height of the editor — and `min-w-0` on the deck side,
        // because a view that cannot shrink is the horizontal scrollbar the 1024px floor
        // forbids. This element is also what `DECK_FLOOR` is measured against: it is the width
        // the two of them actually have, after the sidebar, the page padding and the card pane
        // have taken theirs. What the deck *adds up to* is no longer in this row; it is the band
        // under it, which trades no width with either of these — and no height either, until the
        // window is too short for both, where {@link DECK_HEIGHT_FLOOR} says which gives way.
        <div
          ref={deskRef}
          // **No height on this box, for any view** (2026-09-08). `min-h-96` *here* holds a flex
          // item to the page's leftover height rather than to its content — see
          // {@link DECK_HEIGHT_FLOOR}, where that is written out — so it is a ceiling as much as
          // a floor, and the floor belongs one level in, on the view box, where it floors without
          // capping. It was carried here under `Table` alone, because that was the one view
          // asking to be held; the measurement that put it here is kept because it is what the
          // branch was worth — measured with the class left here for all four, the table drew its
          // own scrollbar *and* the page drew one, which is the two-scrollbar screen the whole
          // 2026-08-14 change is about. The table grows now like the other three (see the view
          // box below), so nothing is held, the branch is gone, and no class on this row is
          // view-dependent again.
          className="flex flex-1 gap-4"
        >
          {/**
           * The box the deck is drawn in, and **it is given no height** — which is the whole of
           * the 2026-08-14 change and the reason the paragraphs above read the way they do.
           *
           * It was `min-h-0 … overflow-auto`, a scroller of exactly the desk's height. That is
           * what put a scrollbar *inside* the deck builder the moment a deck had more piles than
           * the window was tall: a wall of cards in a letterbox, the editor's own scrollbar
           * beside it, and no way to tell from the screen which of the two a wheel was about to
           * move. `min-h-0` is what did it, not `overflow` — it is the line that tells the flex
           * row this box may be squeezed below its content, and with it gone the row is as tall
           * as the deck, the page is as tall as the row, and the page scroller is the one thing
           * in this editor that scrolls. Piles overflow **down**, and the container grows.
           *
           * **The table was the exception until 2026-09-08 and is not one now.** It kept the
           * arrangement this div used to carry for all four — `min-h-0 … overflow-auto`, the
           * squeezable box a scroller needs — because `VirtualTable` mounts the rows in view and
           * holds a spacer open for the rest, so a virtualiser given no height renders every row
           * of the deck. It opts into growing (`VirtualTable`'s `grow`) and does render every
           * row, which is what this list can afford: a deck is a few hundred rows, and the
           * 100k-row walls the virtualiser exists for are the search's, the collection's and the
           * wishlist's, every one of them untouched by this. So the branch is gone, the floor
           * below is unconditional, and all four views are drawn in one box with one rule — which
           * is also what the reader asked for, a table at its full height with no scrollbar on it.
           */}
          <div
            className={cn("min-w-0 flex-1", DECK_HEIGHT_FLOOR)}
            // Where the Table view's sticky column header stops (`VirtualTable`'s
            // `top-[var(--sticky-top,0px)]`): under the undocked bar while it is down, at the page's
            // top otherwise. Only a `grow` table reads the variable — one that is its own scroller
            // pins at its own top whatever it inherits — so this could sit anywhere; it sits on the
            // box that draws the one table it is about. A length string, never a bare number:
            // React adds no `px` to a custom property, and an unitless `top` is dropped silently.
            style={{ "--sticky-top": `${barClearance}px` } as CSSProperties}
          >
            {/* Neither `columnHeight` nor a measured height reaches a view any more. `StackView`
                packs nothing — every pile is a flex item that wraps on width — and `TextView`
                still packs, to a fixed readable target rather than to the desk, which is as tall
                as its own answer now. See that prop's own note. */}
            {view === "stacks" && (
              // The hidden stacks are this view's alone (issue #618): the other three draw every
              // card, so the two props ride here rather than in the shared `viewProps`.
              <StackView {...viewProps} hiddenStacks={hiddenStacks} onShowStack={showStack} />
            )}
            {view === "table" && <TableView {...viewProps} />}
            {view === "text" && <TextView {...viewProps} />}
            {view === "grid" && <GridView {...viewProps} />}
          </div>

          {dock}
        </div>
      )}
    </>
  );
}
