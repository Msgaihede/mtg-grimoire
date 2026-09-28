import { useState, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import {
  ArrowUpToLine,
  Ellipsis,
  Redo2,
  Scale,
  Search,
  SlidersHorizontal,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { FILTER_FOCUS } from "@/components/FilterChips";
import type { MenuItem } from "@/components/menu/types";
import { isTextField, useContextMenu, useMenuOpener } from "@/components/menu/useContextMenu";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { useDndDragging } from "@/lib/dndTarget";
import { FOCUS } from "@/lib/focus";
import type { CardSummary, DeckVariant } from "@/lib/ipc";
import { KEYBOARD_MODALITY_ATTR } from "@/lib/keyboardModality";
import { LAYER } from "@/lib/layers";
import { dockBar } from "@/lib/motion";
import { clearFieldOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { readDragData } from "./dnd";
import { PLAIN_PRESS } from "./headerControls";
import { QuickAdd } from "./QuickAdd";

/**
 * `AppShell`'s `main` padding — its `p-5` — which the docked bar reaches back across so that it
 * meets the scroller's own top and side edges (issue #646).
 *
 * The bar's box is the editor column's, and the column sits inside that padding, so a panel
 * drawn at the column's edges leaves 20px of deck showing down each side and above it. Reaching
 * out by exactly this much puts the panel on the scroller's padding box, which is where
 * `overflow` clips — so the panel ends at the scroller's edges and its shadow cannot bleed past
 * them. The same number comes back as the panel's inline padding, which puts the first and last
 * control over the column's own edges again, directly above the header controls they stand in
 * for. **Change it with `AppShell`'s `p-5` or not at all.**
 */
const SHELL_PAD_PX = 20;

/** The bar's height: 36 of control, `py-2` above and below it, and the hairline under it. */
const BAR_HEIGHT_PX = 53;

/** Room left under the bar before whatever sticks beneath it, so that reads as a neighbour. */
const BAR_GAP_PX = 8;

/**
 * How far down the page the undocked bar reaches, in px, **measured from the scroller's content
 * edge** — what a surface that sticks to the top of the same scroller has to start below so it is
 * not drawn under the bar.
 *
 * A sticky inset is measured from the content edge, and the bar's top is {@link SHELL_PAD_PX}
 * *above* that edge, flush with the scroller's own top. So its foot is `53 − 20 = 33` below the
 * content edge, and {@link BAR_GAP_PX} under that is **41**. It was 66 while the bar floated
 * `top-2` inside the padding — 8 + 50 + 8 — which is the 28px of deck that issue #646 reported
 * showing above it. `DeckEditor` offsets the docked search panel and the table view's sticky
 * header by this, and adds the scroller's measured padding to it for `scroll-padding-top`, which
 * is measured from the top edge instead. Only while the bar is shown — a clearance held open
 * under a bar that is not drawn is a strip of desk nobody can use.
 */
export const DECK_BAR_CLEARANCE_PX = BAR_HEIGHT_PX - SHELL_PAD_PX + BAR_GAP_PX;

/**
 * How much room the editor column gives the bar — `DeckEditor` picks the rung from the same
 * `deskWidth` its header's thresholds read, and this file decides what each rung draws.
 *
 * - **`tight`** is the header's `TIGHT_HEADER_PX`: icons, and both fields narrowed.
 * - **`normal`** is the app's own 1280px window: icons, fields at 240px.
 * - **`wide`** is the header's `WIDE_HEADER_PX` — the 1920px window's column. Every press carries
 *   its word beside its glyph and the fields widen to 320px, which is the room the icon-only bar
 *   left as an empty middle (issue #646).
 * - **`widest`** is {@link BAR_WIDEST_PX} — the 2560px window's column. The `⋯` opens out into
 *   the header's six verbs, each a worded button of its own, and the fields widen to 384px.
 */
export type BarWidth = "tight" | "normal" | "wide" | "widest";

/**
 * The editor column width at and above which the bar draws the header's verbs as buttons rather
 * than behind `⋯`.
 *
 * Measured in the shipped window (issue #646, a debug build, emulated 2560×1440): the `widest`
 * bar's controls came to **1 815px** with 288px fields, so **1 943** with the 384px ones it draws,
 * and the slack between the two halves wants its `min-w-2` beside them. 1 980 leaves that and a
 * little over. A 1920px window's column is 1657 (about 1 800 with the sidebar collapsed), so it
 * stays `wide`; a 2560px window's is 2297.
 */
export const BAR_WIDEST_PX = 1980;

/** The Quick add field's width at each rung — whole literals, because Tailwind scans for them. */
const QUICK_ADD_WIDTH: Record<BarWidth, string> = {
  tight: "w-44",
  normal: "w-60",
  wide: "w-80",
  widest: "w-96",
};

/** The filter's box at each rung. `w-37` is the one field that gives way first when tight. */
const FILTER_WIDTH: Record<BarWidth, string> = {
  tight: "w-37",
  normal: "w-60",
  wide: "w-80",
  widest: "w-96",
};

/** One of the two history presses, already worded — `auditText`'s sentence is the name. */
export interface BarPress {
  label: string;
  disabled: boolean;
  run: () => void;
}

/**
 * One of the header's deck-level verbs — Import, Export, Categories, Labels, History, Deck
 * settings — as the bar draws it: a row behind `⋯`, or a worded button at the widest rung.
 */
export interface BarAction {
  /** The accessible name and the menu row's label — the header button's own name. */
  label: string;
  /** The word the button prints beside its glyph. Contained in {@link label} (WCAG 2.5.3). */
  word: string;
  Icon: LucideIcon;
  /** Its layer is open: `aria-expanded` on the button. A menu row has no such state. */
  expanded: boolean;
  /** Open its layer, handed the element the caret goes back to when that layer shuts. */
  open: (trigger: HTMLElement) => void;
}

export interface DeckHeaderBarProps {
  /** The header's toolbar row has left the page scroller (`AppShell`'s `<main>`). */
  undocked: boolean;
  /** How much room the editor column gives the bar — see {@link BarWidth}. */
  width: BarWidth;
  /** Scroll the page back to its top, where the header docks again and this bar goes. */
  onTop: () => void;
  /** `QuickAdd`'s `targetName` — the pile an add lands in, or `null` under `AUTO_CATEGORY`. */
  quickAddTarget: string | null;
  /** `QuickAdd`'s `onAdd`: the same write the toolbar's field makes. */
  onQuickAdd: (card: CardSummary) => void;
  /**
   * The deck's two lists and the comparison between them, or `null` for a deck with no plan —
   * which draws neither the switch nor `Compare`, the header's own rule: a two-way switch over
   * a deck with one list is a control whose other half is empty by construction.
   */
  lists: {
    variant: DeckVariant;
    onPick: (variant: DeckVariant) => void;
    /** Handed its own button, so the host can give the caret back to it when the dialog shuts. */
    onCompare: (trigger: HTMLElement) => void;
    /** The theory difference is open — `aria-expanded` on `Compare`. */
    comparing: boolean;
  } | null;
  undo: BarPress;
  redo: BarPress;
  /** The Display button's whole name, e.g. `Display: Stacks, grouped by Category, sorted by Name`. */
  displayName: string;
  /** The rows the Display button opens — built on the press, never on render. */
  displayMenu: () => MenuItem[];
  /** The header's filter text: one piece of state, drawn in two fields. */
  filter: string;
  onFilter: (text: string) => void;
  /**
   * The header's deck-level verbs: `pair` is its joined Import/Export pair and `rest` the four
   * worded actions after it. Behind `⋯` below {@link BAR_WIDEST_PX}, a separator between the two
   * groups where the header draws a gap; drawn out as buttons at and above it.
   */
  actions: { pair: readonly BarAction[]; rest: readonly BarAction[] };
}

/**
 * Every icon-only press on the bar — the undo/redo pair's recipe in `DeckEditor`, character for
 * character, so a glyph here and the same glyph in the header are one control drawn twice.
 * `shrink-0` because a 36px square that gives way is a glyph clipped by its own box.
 */
const ICON_PRESS = cn(PLAIN_PRESS, FILTER_FOCUS, "grid w-9 shrink-0 place-items-center px-0");

/** A press with its word beside its glyph — the header's own worded `ACTIONS` recipe. */
const WORD_PRESS = cn(
  PLAIN_PRESS,
  FILTER_FOCUS,
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap",
);

/**
 * The docked bar's shadow, cast down over the deck only. The panel spans the scroller's padding
 * box, whose `overflow` clips everything outside it, so the sides and the top of any shadow are
 * cut off at the window's own edges and what is left is what falls on the cards: a tight contact
 * shadow for the edge and a deep soft one for the lift. Black at these alphas because the desk
 * under it is this app's dark felt and card art, and Tailwind's own `shadow-lg` (0.1) does not
 * read on either. Written out whole: an interpolated arbitrary value emits no rule.
 */
const DOCKED_SHADOW =
  "shadow-[0_1px_2px_rgb(0_0_0/0.55),0_10px_24px_-4px_rgb(0_0_0/0.75),0_24px_48px_-12px_rgb(0_0_0/0.55)]";

/**
 * Whether a caret arriving on this element should keep the bar drawn after the header docks.
 *
 * **In one of the two fields, always** — that is the case the hold exists for: a reader typing a
 * card name scrolls up to look at the deck, and a field that left the DOM under them would drop
 * the caret on `<body>` mid-word. **On a button, only when the keyboard put it there.** A mouse
 * press focuses a button as a side effect in Chromium on Windows, so holding on *any* caret would
 * keep the bar pinned over a docked header after nearly every press — over the header's own
 * actions row, until the reader happened to click somewhere else — for a caret the reader never
 * asked for and cannot see. A keyboard reader's caret is the one they steer by, so it holds.
 *
 * "The keyboard put it there" is `lib/keyboardModality`'s answer and not `:focus-visible`, for
 * the reason that module is written: it is decided when focus *moves*, which is exactly when this
 * is asked. Its attribute is written by a `window` capture listener, so it already describes this
 * move by the time React's `onFocus` hears it.
 */
function holdsBar(target: EventTarget | null): boolean {
  return isTextField(target) || document.documentElement.hasAttribute(KEYBOARD_MODALITY_ATTR);
}

/** A hairline between two groups of the bar. `aria-hidden`: a line is not a control. */
function Divider(): ReactElement {
  return <span aria-hidden="true" className="h-5 w-px shrink-0 bg-border" />;
}

/**
 * One press on the bar: its glyph, and — where the column has room — its word beside it.
 *
 * **The name never moves with the width**, so nothing a test or a screen reader addresses
 * changes as the window grows, and the word is always contained in it (WCAG 2.5.3). The tooltip
 * says the name, and is bound when the word is not drawn **or** when the name says more than the
 * word does — `Undo — Removed 2 × Lightning Bolt`, Display's three answers. That is the header's
 * rule (a hint that repeats the label printed beside it is noise) with the case it never met: a
 * header button's word *is* its name.
 */
function WordedPress({
  name,
  word,
  Icon,
  worded,
  className,
  ...button
}: {
  name: string;
  word: string;
  Icon: LucideIcon;
  worded: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label">): ReactElement {
  const tip = useTooltip();
  return (
    <button
      type="button"
      {...button}
      aria-label={name}
      {...(!worded || name !== word ? tip(name, { describes: false }) : {})}
      className={cn(worded ? WORD_PRESS : ICON_PRESS, className)}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {worded && word}
    </button>
  );
}

/**
 * The bar's own box: `PopupPanel`'s exit handling on the {@link dockBar} preset.
 *
 * Not `PopupPanel` itself, whose `popup` preset scales — see {@link dockBar} for why a box as
 * wide as the page must not. What it keeps from that component is the half a test leans on: on
 * the way out it leaves the accessibility tree and stops taking the pointer, so a bar fading away
 * already reads as gone rather than as a second, stale toolbar.
 */
function DockedPanel({ children }: { children: ReactNode }): ReactElement {
  const present = useIsPresent();
  return (
    <motion.div
      {...dockBar}
      aria-hidden={present ? undefined : true}
      // From the constants rather than as classes, so the clearance a neighbour is offset by and
      // the box it is offset from are one set of numbers — see {@link SHELL_PAD_PX}.
      style={{
        top: -SHELL_PAD_PX,
        left: -SHELL_PAD_PX,
        right: -SHELL_PAD_PX,
        height: BAR_HEIGHT_PX,
        paddingInline: SHELL_PAD_PX,
      }}
      className={cn(
        // Docked: square, flush to the ribbon above and to both edges of the scroller, with one
        // hairline under it where it meets the deck. Opaque, because a bar the cards can be seen
        // through is the complaint this box answers.
        "absolute border-b border-border bg-surface py-2",
        DOCKED_SHADOW,
        !present && "pointer-events-none",
      )}
    >
      {children}
    </motion.div>
  );
}

/**
 * The deck editor's header, folded into one line and docked across the top of the page while
 * the header itself is scrolled away (issue #577, docked since issue #646).
 *
 * The header is three lines — actions, `DeckLedger`, toolbar — and it scrolls with the page, so a
 * reader forty cards down a Stacks desk had to go back to the top to quick add, undo, or narrow
 * the deck. While the toolbar row is on screen nothing here is drawn and the header is exactly
 * what it was ("docked"); once that row has left the page scroller this bar appears across the
 * top of it ("undocked"), and scrolling back up docks the header and puts the bar away. It
 * carries the presses a reader makes *while working down the deck* — back to the top, quick add,
 * the two lists, undo and redo, how the deck is drawn, the filter, and the rest of the header's
 * verbs — and none of the header's readouts: the ledger is a thing read at the top.
 *
 * ## The box: QuickZones' trick, then flush to the scroller's edges
 *
 * An outer `sticky top-0 left-0 -mb-3 h-0` element with the panel `absolute` inside it, which is
 * {@link QuickZones}'s arrangement read verbatim — that file's doc has the whole argument and
 * the measurements behind it. Zero height, with the editor column's `gap-3` cancelled by the
 * negative margin, so appearing costs the deck no layout and the page does not jump by the bar's
 * height at the moment the reader is scrolling past it. `sticky` rather than `fixed`, so the bar
 * is the editor column's width with nothing measured. `left-0` for the page scroller's other
 * axis. The one thing that differs is the rung: `LAYER.popup` rather than `dragTray`, which is
 * above the table view's `LAYER.header` sticky column header and is the rung Quick add's own
 * listbox asks for as it drops out of the bar over the deck. The two bars cannot meet — see
 * `mounted` below.
 *
 * **The panel then reaches out across the scroller's padding**, {@link SHELL_PAD_PX} up and to
 * each side, so it is square against the ribbon above and both edges of the window. It floated
 * `top-2` inside the column until issue #646, which left 28px of cards scrolling past above it
 * and 20px down each side: a panel hovering over the deck rather than a toolbar attached to the
 * window. The shadow is what separates it from the deck now that nothing else does.
 *
 * ## The rungs
 *
 * One bar at every width and four amounts of it — {@link BarWidth}. Below `wide` every press is
 * its glyph; from `wide` each carries its word; at `widest` the `⋯` opens out into the header's
 * own verbs. The controls, their order and their names are the same on every rung.
 *
 * ## Mounted only while it is shown, and held while the caret is in it
 *
 * `undocked` alone would unmount the bar the instant the reader scrolled up past the header with
 * the caret still in its quick add — and a focused element that leaves the DOM drops the caret on
 * `<body>`, one Tab from the top of the window. So the bar also stays while the caret is in one
 * of its fields or on a control the keyboard brought it to ({@link holdsBar} says why a *clicked*
 * button does not count), and while a menu opened from one of its buttons is up — the menu takes
 * the caret and hands it back to its opener on close, which must still be there to take it. Once
 * the caret leaves, the bar goes with it. `Back to the top` is the one press that lets go of it
 * outright, since docking the header is what it is for.
 *
 * **It yields to a drag**: the moment a card is in the air it is gone, whatever held it, because
 * {@link QuickZones} is drawn across the same strip for exactly that length of time and a drop
 * target the pointer is being carried to must not have a toolbar painted over it. The monitor is
 * this component's own `useDndDragging`, for QuickZones' argument: it re-renders the bar on
 * `dragstart` and leaves `DeckEditor` untouched.
 *
 * ## Twin names
 *
 * Every control here is named exactly as its twin in the header is — `Filter this deck`, `Deck
 * list`, `Compare`, the undo sentence — because it *is* that control, drawn where the reader is.
 * The cost is that while undocked each name is in the tree twice, the header's copy scrolled out
 * of view; a test or a live probe scopes to the bar's own group, `Deck toolbar`, first.
 */
export function DeckHeaderBar({
  undocked,
  width,
  onTop,
  quickAddTarget,
  onQuickAdd,
  lists,
  undo,
  redo,
  displayName,
  displayMenu,
  filter,
  onFilter,
  actions,
}: DeckHeaderBarProps): ReactElement | null {
  const { menuClick } = useContextMenu();

  /** The card in the air, or `null` — every kind, as `QuickZones` reads it. */
  const dragging = useDndDragging(readDragData);
  /**
   * The caret is inside the bar **and is the kind that holds it up** — in one of its two fields,
   * or on any control the keyboard brought it to. See {@link holdsBar}.
   */
  const [caretHolds, setCaretHolds] = useState(false);
  /**
   * The bar's group element, kept in **state** through a callback ref rather than in a ref
   * object, because it is read during render below — and a `ref.current` read during render is
   * exactly what `react-hooks/refs` refuses. `null` while the bar is not drawn.
   */
  const [group, setGroup] = useState<HTMLDivElement | null>(null);
  /** The element the open context menu came from, anywhere in the app — or `null`. */
  const opener = useMenuOpener();

  /**
   * **A drag puts the bar down whatever was holding it — including a caret the drag never took.**
   *
   * The bar leaves the DOM for the drag's length, and a blur for a focused element that is
   * *removed* is not something to rest on — so {@link caretHolds} could still read `true` when
   * the card lands and bring the bar back over a docked header. Cleared here, during render,
   * which is React's own *adjusting state when something changes*; an effect doing it is the
   * shape `react-hooks/set-state-in-effect` refuses (see `DeckNotesPanel`'s request for the same
   * arrangement).
   */
  if (dragging !== null && caretHolds) setCaretHolds(false);

  /** A menu opened from one of the bar's own buttons is up. */
  const menuFromBar = opener !== null && group !== null && group.contains(opener);
  const mounted = dragging === null && (undocked || caretHolds || menuFromBar);

  /** Each press carries its word beside its glyph from the `wide` rung up. */
  const worded = width === "wide" || width === "widest";
  /** The header's verbs are buttons of their own at the widest rung, and behind `⋯` below it. */
  const verbsOut = width === "widest";

  /** `⋯`'s rows, built at the press and handed the `⋯` itself for each layer to return to. */
  const actionsMenu = (trigger: HTMLElement): MenuItem[] => {
    const row = ({ label, Icon, open }: BarAction): MenuItem => ({
      kind: "action",
      id: label,
      label,
      Icon,
      onSelect: () => open(trigger),
    });
    return [...actions.pair.map(row), { kind: "separator", id: "pair" }, ...actions.rest.map(row)];
  };

  return (
    <AnimatePresence>
      {mounted && (
        <div
          key="deck-header-bar"
          className={cn(
            // Zero height and the column's gap cancelled — see this component's doc. `top-0` is
            // the page scroller's content edge; the panel inside reaches up past it to the top.
            "sticky top-0 left-0 -mb-3 h-0",
            LAYER.popup,
          )}
        >
          <DockedPanel>
            {/**
             * **`role="group"` and deliberately not `role="toolbar"`.**
             *
             * A toolbar is a composite widget, and its keyboard contract is one tab stop with the
             * arrow keys moving between the controls. This bar holds two text fields — Quick add,
             * whose arrows walk its own suggestions, and the filter, whose arrows move a caret —
             * and neither may give its arrows to a row of buttons. The repo refuses a role whose
             * contract it does not keep: `DeckSearchPanel`'s tab strip is `aria-pressed` buttons
             * rather than `role="tab"`, and the deck kind is a group of toggles rather than a
             * radiogroup, both for this reason. A group with a name says what this is — a set of
             * controls that belong together — and promises nothing it does not do.
             */}
            <div
              ref={setGroup}
              role="group"
              aria-label="Deck toolbar"
              // React's `focusin`/`focusout`, which bubble — so these hear every control inside.
              // Decided afresh on every move, so a caret walking from the filter to a button it
              // was clicked onto stops holding the bar at the step where it stops being one.
              onFocus={(e) => setCaretHolds(holdsBar(e.target))}
              onBlur={(e) => {
                // Moving between two of the bar's own controls is not leaving it — `onFocus`
                // above has the next one's answer.
                if (e.currentTarget.contains(e.relatedTarget)) return;
                // Nor is the window losing focus (Alt+Tab): the caret is still in the field and
                // comes back to it with the window, so taking the bar away would return the
                // reader to a caret on `<body>`. A blur with no `relatedTarget` in a document
                // that no longer has focus is that case and only that case — a press anywhere
                // inside the window keeps the document focused.
                if (e.relatedTarget === null && !document.hasFocus()) return;
                setCaretHolds(false);
              }}
              className="flex h-full items-center gap-2"
            >
              <WordedPress
                name="Back to the top"
                word="Top"
                Icon={ArrowUpToLine}
                worded={worded}
                onClick={() => {
                  // **The one press that lets go of the bar whatever holds it**, because docking
                  // the header is its whole job: a caret the keyboard left on it would otherwise
                  // keep the bar pinned over the header it has just brought back. Where the caret
                  // goes next is the host's — a caret left here leaves with the bar.
                  setCaretHolds(false);
                  onTop();
                }}
                className="hover:text-text"
              />

              {/* The toolbar's own field and the toolbar's own write — `onQuickAdd` is the same
                  `addTo` the header's instance calls. Its width follows the rung, and its status
                  line goes under it rather than beside it: this line has no room beside
                  anything, and what is under it is the deck. */}
              <QuickAdd
                targetName={quickAddTarget}
                onAdd={onQuickAdd}
                fieldClassName={QUICK_ADD_WIDTH[width]}
                status="below"
              />

              {lists && (
                <>
                  <Divider />
                  {/* The header's `Deck list` switch, character for character — its comments in
                      `DeckEditor` argue the order (Theory first), the words (written out, never
                      `capitalize`d off the value) and the missing hairline between the halves. */}
                  <div
                    role="group"
                    aria-label="Deck list"
                    className="flex shrink-0 overflow-hidden rounded-md border border-border"
                  >
                    {(
                      [
                        { id: "theory", label: "Theory" },
                        { id: "live", label: "Actual" },
                      ] as const
                    ).map(({ id, label }) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => lists.onPick(id)}
                        aria-pressed={lists.variant === id}
                        className={cn(
                          "h-9 px-2.5 text-xs",
                          "transition-colors duration-150 motion-reduce:transition-none",
                          lists.variant === id
                            ? "bg-accent font-medium text-accent-fg"
                            : "text-dim hover:text-text",
                          FOCUS,
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {/* The header's `Compare` — the glyph alone below `wide`, with the word in the
                      name and the tooltip. `aria-expanded` is the host's, because the dialog it
                      opens is the host's layer. */}
                  <WordedPress
                    name="Compare"
                    word="Compare"
                    Icon={Scale}
                    worded={worded}
                    onClick={(e) => lists.onCompare(e.currentTarget)}
                    aria-haspopup="dialog"
                    aria-expanded={lists.comparing}
                    className="hover:text-text"
                  />
                </>
              )}

              {/* The slack, so the reading half sits left and the editing half right. `min-w-2`
                  so the two halves never touch when the column is at its narrowest. */}
              <span aria-hidden="true" className="min-w-2 flex-1" />

              <div
                role="group"
                aria-label="Undo and redo"
                className="flex shrink-0 items-center gap-1"
              >
                {(
                  [
                    { key: "undo", word: "Undo", Icon: Undo2, press: undo },
                    { key: "redo", word: "Redo", Icon: Redo2, press: redo },
                  ] as const
                ).map(({ key, word, Icon, press }) => (
                  <WordedPress
                    key={key}
                    name={press.label}
                    word={word}
                    Icon={Icon}
                    worded={worded}
                    // The guard is here, not on the attribute: `aria-disabled` greys a control
                    // without stopping it, which is the whole trade that rule makes — and a
                    // `disabled` button would drop out of the tab order under a caret sitting on
                    // it the moment the history ran out.
                    onClick={() => {
                      if (!press.disabled) press.run();
                    }}
                    aria-disabled={press.disabled}
                    className={press.disabled ? "cursor-default opacity-40" : "hover:text-text"}
                  />
                ))}
              </div>

              <Divider />

              {/* How the deck is drawn — View, Group by and Sort — as one menu, named with all
                  three answers so the glyph is never the only thing that says them.
                  `aria-haspopup` and **no `aria-expanded`**: the popup kind is this button's
                  fact, the expanded state is `ContextMenuProvider`'s, and a static `false` would
                  be wrong for exactly as long as the menu is up (`DecksPage`'s `Folder actions`
                  ruling). */}
              <WordedPress
                name={displayName}
                word="Display"
                Icon={SlidersHorizontal}
                worded={worded}
                aria-haspopup="menu"
                onClick={menuClick(displayMenu)}
                className="hover:text-text"
              />

              {/* The header's filter, bound to the header's state — typing in either narrows
                  the one deck. `min-w-0` so this is the control that gives way if the column
                  is narrower than the bar's arithmetic: a field a few pixels short is a field,
                  where a bar whose last button has slid off its own end is a bug. */}
              <div className={cn("relative flex min-w-0 items-center", FILTER_WIDTH[width])}>
                <Search
                  aria-hidden="true"
                  // Centred by `inset-y-0 my-auto` on a fixed box rather than a half-translate,
                  // which lands the glyph on a half pixel.
                  className="pointer-events-none absolute inset-y-0 left-2.5 my-auto size-3.5 text-dim"
                />
                <input
                  type="search"
                  aria-label="Filter this deck"
                  placeholder="Filter this deck…"
                  value={filter}
                  onChange={(e) => onFilter(e.target.value)}
                  // Exactly the header's field: a box with text in it owns one Escape and an
                  // empty one owns none, or the press would empty the box *and* close the deck
                  // behind it. `clearFieldOnEscape` carries the reason.
                  onKeyDown={(e) => clearFieldOnEscape(e, filter, () => onFilter(""))}
                  className={cn(
                    "h-9 w-full min-w-0 rounded-md border border-border bg-bg pr-2.5 pl-8 text-xs",
                    FOCUS,
                  )}
                />
              </div>

              {verbsOut ? (
                <>
                  <Divider />
                  {/* The header's joined pair, drawn as it draws it: one idea read in two
                      directions, in the width of one control and a hairline. */}
                  <div
                    role="group"
                    aria-label="Import and export"
                    className="flex shrink-0 overflow-hidden rounded-md border border-border bg-surface"
                  >
                    {actions.pair.map(({ label, word, Icon, expanded, open }, at) => (
                      <button
                        key={label}
                        type="button"
                        onClick={(e) => open(e.currentTarget)}
                        aria-expanded={expanded}
                        aria-haspopup="dialog"
                        aria-label={label}
                        className={cn(
                          "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 px-2.5",
                          "text-xs whitespace-nowrap text-dim",
                          at > 0 && "border-l border-border",
                          "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
                          FOCUS,
                        )}
                      >
                        <Icon aria-hidden="true" className="size-4 shrink-0" />
                        {word}
                      </button>
                    ))}
                  </div>
                  {actions.rest.map(({ label, word, Icon, expanded, open }) => (
                    <WordedPress
                      key={label}
                      name={label}
                      word={word}
                      Icon={Icon}
                      worded
                      onClick={(e) => open(e.currentTarget)}
                      aria-haspopup="dialog"
                      aria-expanded={expanded}
                      className="hover:text-text"
                    />
                  ))}
                </>
              ) : (
                /* Everything else the header can do to this deck. Each row is handed this
                   button, stashed before the menu opens, because every row that raises a dialog
                   has to give the caret back to *something* when it closes. */
                <WordedPress
                  name="Deck actions"
                  word="Actions"
                  Icon={Ellipsis}
                  worded={worded}
                  aria-haspopup="menu"
                  onClick={(e) => {
                    const trigger = e.currentTarget;
                    menuClick(() => actionsMenu(trigger))(e);
                  }}
                  className="hover:text-text"
                />
              )}
            </div>
          </DockedPanel>
        </div>
      )}
    </AnimatePresence>
  );
}
