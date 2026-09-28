import { useState, type ReactElement } from "react";
import { AnimatePresence } from "motion/react";
import {
  ArrowUpToLine,
  Ellipsis,
  Redo2,
  Scale,
  Search,
  SlidersHorizontal,
  Undo2,
} from "lucide-react";
import { FILTER_FOCUS } from "@/components/FilterChips";
import type { MenuItem } from "@/components/menu/types";
import { isTextField, useContextMenu, useMenuOpener } from "@/components/menu/useContextMenu";
import { PopupPanel } from "@/components/PopupListbox";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { useDndDragging } from "@/lib/dndTarget";
import { FOCUS } from "@/lib/focus";
import type { CardSummary, DeckVariant } from "@/lib/ipc";
import { KEYBOARD_MODALITY_ATTR } from "@/lib/keyboardModality";
import { LAYER } from "@/lib/layers";
import { clearFieldOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { readDragData } from "./dnd";
import { PLAIN_PRESS } from "./headerControls";
import { QuickAdd } from "./QuickAdd";

/**
 * How far down the page the undocked bar reaches, in px — what a surface that sticks to the top
 * of the same scroller has to start below so it is not drawn under the bar.
 *
 * **Three numbers, and each is this file's**: the panel is inset `top-2` (8) from the scroller's
 * top edge, it is 50 tall (`h-[50px]` — 36 of control, 6 of padding either side, a hairline
 * border either side), and 8 more is left under it so whatever sticks beneath reads as a
 * neighbour rather than as a second line of the same bar. `DeckEditor` offsets the docked search
 * panel and the table view's sticky header by this, and only while the bar is shown — a
 * clearance held open under a bar that is not drawn is a 66px strip of desk nobody can use.
 *
 * A number rather than a class, because the two callers spend it differently (one is a measured
 * height, one an inline `top`); change it here and the arithmetic above together.
 */
export const DECK_BAR_CLEARANCE_PX = 66;

/** One of the two history presses, already worded — `auditText`'s sentence is the name. */
export interface BarPress {
  label: string;
  disabled: boolean;
  run: () => void;
}

export interface DeckHeaderBarProps {
  /** The header's toolbar row has left the page scroller (`AppShell`'s `<main>`). */
  undocked: boolean;
  /** The editor column is under `TIGHT_HEADER_PX`: the two fields draw narrower. */
  tight: boolean;
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
   * The rows the `⋯` opens, built on the press and **handed the button that opened them**, so a
   * dialog opened from one of them can give the caret back to it when it closes — a
   * `MenuAction.onSelect` is a bare callback with no element behind it.
   */
  actionsMenu: (trigger: HTMLElement) => MenuItem[];
}

/**
 * Every icon-only press on the bar — the undo/redo pair's recipe in `DeckEditor`, character for
 * character, so a glyph here and the same glyph in the header are one control drawn twice.
 * `shrink-0` because a 36px square that gives way is a glyph clipped by its own box.
 */
const ICON_PRESS = cn(PLAIN_PRESS, FILTER_FOCUS, "grid w-9 shrink-0 place-items-center px-0");

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
 * The deck editor's header, folded into one line and pinned to the top of the page while the
 * header itself is scrolled away (issue #577).
 *
 * The header is three lines — actions, `DeckLedger`, toolbar — and it scrolls with the page, so a
 * reader forty cards down a Stacks desk had to go back to the top to quick add, undo, or narrow
 * the deck. While the toolbar row is on screen nothing here is drawn and the header is exactly
 * what it was ("docked"); once that row has left the page scroller this bar appears across the
 * top of it ("undocked"), and scrolling back up docks the header and puts the bar away. It
 * carries the presses a reader makes *while working down the deck* — back to the top, quick add,
 * the two lists, undo and redo, how the deck is drawn, the filter, and the rest of the header's
 * verbs behind one `⋯` — and none of the header's readouts: the ledger is a thing read at the top.
 *
 * ## The box: QuickZones' trick, for QuickZones' reasons
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
  tight,
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
  actionsMenu,
}: DeckHeaderBarProps): ReactElement | null {
  const tip = useTooltip();
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

  return (
    <AnimatePresence>
      {mounted && (
        <div
          key="deck-header-bar"
          className={cn(
            // Zero height and the column's gap cancelled — see this component's doc. `top-0` is
            // the page scroller's own top edge, so the bar rides whatever the reader can see.
            "sticky top-0 left-0 -mb-3 h-0",
            LAYER.popup,
          )}
        >
          <PopupPanel
            className={cn(
              // 50px: 36 of control, `p-1.5` either side, a hairline border either side — see
              // {@link DECK_BAR_CLEARANCE_PX}, which is the arithmetic a neighbour relies on.
              "absolute inset-x-0 top-2 h-[50px] rounded-lg border border-border p-1.5",
              // The desk scrolls *under* this bar, so it is nearly opaque and blurs what little
              // shows through: a card face passing behind a row of glyphs at full sharpness is a
              // second picture competing with the controls.
              "bg-surface/95 backdrop-blur-sm",
              // Deeper than Tailwind's own `shadow-lg`, whose alpha is 0.1 and is not a shadow on
              // this app's felt — `CardStack`'s `stackedCardShadow` argues it and sits at 0.45
              // under every card this bar floats over. A tight contact shadow for the edge and a
              // wide soft one for the height, so the bar reads as lifted off the deck rather than
              // as one more stack on it. Written out whole: an interpolated arbitrary value emits
              // no rule.
              "shadow-[0_2px_6px_rgb(0_0_0/0.45),0_14px_32px_-8px_rgb(0_0_0/0.6)]",
              // The `popup` preset scales from its own origin, and a bar pinned to the top edge
              // arrives from the top edge.
              "origin-top",
            )}
          >
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
              <button
                type="button"
                onClick={() => {
                  // **The one press that lets go of the bar whatever holds it**, because docking
                  // the header is its whole job: a caret the keyboard left on it would otherwise
                  // keep the bar pinned over the header it has just brought back. Where the caret
                  // goes next is the host's — a caret left here leaves with the bar.
                  setCaretHolds(false);
                  onTop();
                }}
                aria-label="Back to the top"
                {...tip("Back to the top", { describes: false })}
                className={cn(ICON_PRESS, "hover:text-text")}
              >
                <ArrowUpToLine aria-hidden="true" className="size-4" />
              </button>

              {/* The toolbar's own field and the toolbar's own write — `onQuickAdd` is the same
                  `addTo` the header's instance calls. Narrower when the column is tight, and its
                  status line under it rather than beside it: this line has no room beside
                  anything, and what is under it is the deck. */}
              <QuickAdd
                targetName={quickAddTarget}
                onAdd={onQuickAdd}
                fieldClassName={tight ? "w-44" : "w-60"}
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
                  {/* The header's `Compare` at its narrow width — the glyph alone, with the word
                      in the name and the tooltip. `aria-expanded` is the host's, because the
                      dialog it opens is the host's layer. */}
                  <button
                    type="button"
                    onClick={(e) => lists.onCompare(e.currentTarget)}
                    aria-haspopup="dialog"
                    aria-expanded={lists.comparing}
                    aria-label="Compare"
                    {...tip("Compare", { describes: false })}
                    className={cn(ICON_PRESS, "hover:text-text")}
                  >
                    <Scale aria-hidden="true" className="size-4" />
                  </button>
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
                    { key: "undo", Icon: Undo2, press: undo },
                    { key: "redo", Icon: Redo2, press: redo },
                  ] as const
                ).map(({ key, Icon, press }) => (
                  <button
                    key={key}
                    type="button"
                    // The guard is here, not on the attribute: `aria-disabled` greys a control
                    // without stopping it, which is the whole trade that rule makes — and a
                    // `disabled` button would drop out of the tab order under a caret sitting on
                    // it the moment the history ran out.
                    onClick={() => {
                      if (!press.disabled) press.run();
                    }}
                    aria-disabled={press.disabled}
                    aria-label={press.label}
                    {...tip(press.label, { describes: false })}
                    className={cn(
                      ICON_PRESS,
                      press.disabled ? "cursor-default opacity-40" : "hover:text-text",
                    )}
                  >
                    <Icon aria-hidden="true" className="size-4" />
                  </button>
                ))}
              </div>

              <Divider />

              {/* How the deck is drawn — View, Group by and Sort — as one menu, named with all
                  three answers so the glyph is never the only thing that says them.
                  `aria-haspopup` and **no `aria-expanded`**: the popup kind is this button's
                  fact, the expanded state is `ContextMenuProvider`'s, and a static `false` would
                  be wrong for exactly as long as the menu is up (`DecksPage`'s `Folder actions`
                  ruling). */}
              <button
                type="button"
                aria-haspopup="menu"
                aria-label={displayName}
                {...tip(displayName, { describes: false })}
                onClick={menuClick(displayMenu)}
                className={cn(ICON_PRESS, "hover:text-text")}
              >
                <SlidersHorizontal aria-hidden="true" className="size-4" />
              </button>

              {/* The header's filter, bound to the header's state — typing in either narrows
                  the one deck. `min-w-0` so this is the control that gives way if the column
                  is narrower than the bar's arithmetic: a field a few pixels short is a field,
                  where a bar whose `⋯` has slid off its own end is a bug. */}
              <div className={cn("relative flex min-w-0 items-center", tight ? "w-37" : "w-60")}>
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

              {/* Everything else the header can do to this deck. The builder is handed this
                  button, stashed before the menu opens, because every row that raises a dialog
                  has to give the caret back to *something* when it closes. */}
              <button
                type="button"
                aria-haspopup="menu"
                aria-label="Deck actions"
                {...tip("Deck actions", { describes: false })}
                onClick={(e) => {
                  const trigger = e.currentTarget;
                  menuClick(() => actionsMenu(trigger))(e);
                }}
                className={cn(ICON_PRESS, "hover:text-text")}
              >
                <Ellipsis aria-hidden="true" className="size-4" />
              </button>
            </div>
          </PopupPanel>
        </div>
      )}
    </AnimatePresence>
  );
}
