/**
 * The chrome every home-page widget is drawn in: the bordered card, its heading, the widget's
 * own control, and the four affordances Customize adds to it.
 *
 * **It is `StatsCard` with an edit tray on the end of its heading line, and the import across the
 * feature boundary is deliberate.** The honest home for `StatsCard`, `BarChart`, `Track` and
 * `percent` is `src/components/` — six widgets and a page are about to draw them, which is what
 * makes them shared furniture rather than the deck stats band's — and moving that file while
 * other branches are editing the band would be a delete-plus-add conflict against live work. So
 * the move is a recorded follow-up and this imports where the file actually is; a cross-feature
 * import is idiomatic here, and `features/collection/CollectionPage.tsx` already takes three
 * things out of `features/decks`. Every rule `StatsCard` states applies unchanged.
 *
 * ## The three things this component is the only place for
 *
 * **The heading is the card's accessible name.** `StatsCard` draws a `<section aria-labelledby>`
 * over an `<h3>`, so a widget is a `region` named by what it says — which is what lets a test, a
 * live pass and a screen reader all address one by its words rather than by its place in a
 * wrapping row. A widget's place is the one thing about it a reader is free to change, so it is
 * the one thing nothing may address it by.
 *
 * **The grip carries arrow keys that write the move.** `dndManager` ships no `KeyboardSensor`, so
 * a reorder that was only a drag would be a rearrange half the readers do not have.
 * `features/decks/categoryDrag.ts`'s grip is the precedent and this is its shape, one axis over:
 * that one is a vertical list and answers up/down, this row is a wrapping flex line and answers
 * left/right. {@link WidgetCardProps.onNudge} is the whole of the keyboard path, and the host is
 * what turns a delta into a position — the same split `CategoriesDialog` makes, and for the same
 * reason: only the host holds the list.
 *
 * **No `@container`, here or on the page that draws these.** `container-type: inline-size`
 * applies layout containment, which makes the box the containing block for every `fixed`
 * descendant — and a widget opens anchored popovers, context menus and, through them, dialogs.
 * A container here would reparent all of them to a card — `components/Dialog.tsx`'s scrim is a
 * bare `fixed inset-0` and corrects for nothing — and `features/decks/DeckStats.tsx` refuses a
 * container query over its own two columns in exactly these words. The row wraps with flexbox
 * instead, which is the deck stats band's own layout and the reason
 * {@link WIDGET_CARD_BOX} and {@link WIDGET_CARD_WIDE} are two whole class strings rather than a
 * width computed from `span`: Tailwind scans source *text*, so an interpolated class emits no
 * rule at all — silently, and only in a build.
 */
import { useCallback, type ReactElement, type ReactNode } from "react";
import { GripVertical, Settings2, Trash2, UnfoldHorizontal } from "lucide-react";
import { AnchoredPopup } from "@/components/AnchoredPopup";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { StatsCard } from "@/features/decks/stats/StatsCard";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * A widget that takes one column of the row: a floor it may not be squeezed below, and a share
 * of whatever is left over.
 *
 * 22rem is the narrowest a widget's own body reads at — a figure row, a bar chart with its
 * labels — and it is a **floor** rather than a width, so the row fits as many as it holds and
 * the last line stretches. `StatsCard`'s own `min-w-0` is overridden by it through
 * `tailwind-merge`, which is what makes this the card's floor rather than a second opinion
 * beside one.
 */
export const WIDGET_CARD_BOX = "min-w-[22rem] flex-1";

/**
 * A widget that takes the whole line — `span: 2`.
 *
 * A basis of 100% and nothing else: it fills its line, wraps everything after it onto the next,
 * and still **shrinks** if the window is narrower than it, which a `w-full` would not. It
 * deliberately does not carry {@link WIDGET_CARD_BOX}'s floor — a minimum width on a box that is
 * already the whole line can only ever overflow it.
 */
export const WIDGET_CARD_WIDE = "basis-full";

/**
 * Every control in the edit tray, so four of them are one row rather than four sizes.
 *
 * 24px is `AnchoredPopup`'s trigger — the settings control is one of these and cannot be
 * restyled — so the other three are read off it rather than chosen again. The press is
 * {@link PRESS}, the app's one recipe, and it carries no out-of-reach clause because nothing
 * here greys: the four affordances are live for the whole of edit mode. Anything that ever does
 * grey uses `aria-disabled` and keeps its tab stop.
 */
const TRAY_BUTTON = cn("grid size-6 shrink-0 place-items-center rounded-md border", PRESS, FOCUS);

/**
 * The tray's resting colours.
 *
 * `text-dim` is the app's dim text and the only spelling of it — the retired name still
 * compiles and paints text in the *surface* colour, which is very nearly invisible.
 * `tokens.test.ts` sweeps `src/` for that name and reads a doc comment as eagerly as a class
 * list, which is why this paragraph does not spell it.
 */
const TRAY_RESTING = "border-border text-dim hover:text-text";

/** A pressed toggle, in the accent that means *on* everywhere else in this app. */
const TRAY_PRESSED = "border-accent text-accent";

/** The glyph inside one of those controls. Its own constant so a button and its icon cannot
 *  come to disagree about the box they share. */
const TRAY_ICON = "size-3.5";

export interface WidgetCardProps {
  /** The card's accessible name, and the words in its heading. Every control in the tray folds
   *  it into its own name, so six cards are six addressable Remove buttons rather than one
   *  repeated six times. */
  heading: string;
  /** Customize is on: the tray is drawn. */
  editing: boolean;
  span: 1 | 2;
  /** The widget's own control — a dimension `Dropdown`, a figure. Drawn in **both** modes: it
   *  is what the widget is about rather than an affordance for rearranging the page. */
  actions?: ReactNode;
  /** What the edit-mode settings popover holds. Absent means no settings control at all —
   *  a greyed one reads as broken, and an empty popover is a question with no answers in it. */
  settings?: ReactNode;
  onRemove: () => void;
  onSpan: (span: 1 | 2) => void;
  /** The grip, handed back so the host can register it as the drag handle. `null` arrives when
   *  edit mode ends and the grip unmounts, which is React's own ref contract. */
  dragHandleRef: (el: HTMLElement | null) => void;
  /** One step earlier or later in the row — the grip's arrow keys. A **delta**, because only the
   *  host knows this widget's position and the list it is a position in. */
  onNudge: (delta: -1 | 1) => void;
  children: ReactNode;
}

export function WidgetCard({
  heading,
  editing,
  span,
  actions,
  settings,
  onRemove,
  onSpan,
  dragHandleRef,
  onNudge,
  children,
}: WidgetCardProps): ReactElement {
  const tip = useTooltip();

  /**
   * The host's callback, wrapped once.
   *
   * Two things, and both are a bug otherwise. **Stable**, because React 19 re-runs a ref
   * callback whose identity changed — unregistering and re-registering the draggable on every
   * render of the page, including the ones a drag it started is causing; `categoryDrag.ts` says
   * the same at its own site. And the return is **discarded**, because React reads whatever a
   * ref callback returns as its cleanup, and a host whose `dragHandleRef` happens to return the
   * value of its last expression would silently lose the `null` this contract promises.
   */
  const gripRef = useCallback(
    (element: HTMLButtonElement | null) => {
      dragHandleRef(element);
    },
    [dragHandleRef],
  );

  const wide = span === 2;

  return (
    <StatsCard
      title={heading}
      className={wide ? WIDGET_CARD_WIDE : WIDGET_CARD_BOX}
      actions={
        // `self-center` against the heading row's `items-baseline`: a column of icon buttons has
        // no text baseline worth sharing with a heading, and aligning one to it lifts the tray.
        <div className="flex items-center gap-1.5 self-center">
          {actions}
          {editing && (
            <div
              role="group"
              aria-label={`Customize ${heading}`}
              className="flex items-center gap-1"
            >
              {/*
                The keyboard's whole reorder. The name carries the widget's heading because the
                glyph says nothing and a row of six of these is otherwise six buttons called
                "Move"; the hint is the one sentence saying the arrows do anything at all, which
                is a fact nothing on screen can show.
              */}
              <button
                ref={gripRef}
                type="button"
                aria-label={`Move ${heading}`}
                {...tip("Drag to reorder, or press the left and right arrow keys")}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    onNudge(-1);
                  } else if (e.key === "ArrowRight") {
                    e.preventDefault();
                    onNudge(1);
                  }
                }}
                className={cn(TRAY_BUTTON, TRAY_RESTING, "cursor-grab")}
              >
                <GripVertical className={TRAY_ICON} aria-hidden="true" />
              </button>

              {/*
                One glyph in both states, with `aria-pressed` and the accent saying which one it
                is in — never two glyphs swapped, which is `SortableHeader`'s rule and its
                reason: a different element in the same slot teleports. The name is fixed for the
                same reason a toggle's name is always fixed — a control that renames itself is
                one a reader cannot find twice.
              */}
              <button
                type="button"
                aria-pressed={wide}
                aria-label={`Full width, ${heading}`}
                {...tip("Draw this widget across the whole row")}
                onClick={() => onSpan(wide ? 1 : 2)}
                className={cn(TRAY_BUTTON, wide ? TRAY_PRESSED : TRAY_RESTING)}
              >
                <UnfoldHorizontal className={TRAY_ICON} aria-hidden="true" />
              </button>

              {settings !== undefined && (
                <AnchoredPopup
                  label={`Settings for ${heading}`}
                  panelLabel={`${heading} settings`}
                  icon={<Settings2 className={TRAY_ICON} aria-hidden="true" />}
                  // Pinned by the corner it grows from, which for a control at the right-hand
                  // end of a row is the right one — a panel that grew from the other side would
                  // read as unrelated to the button that produced it.
                  align="end"
                  panelClassName="w-64"
                >
                  {settings}
                </AnchoredPopup>
              )}

              <button
                type="button"
                aria-label={`Remove ${heading}`}
                {...tip("Take this widget off the page")}
                onClick={onRemove}
                className={cn(
                  TRAY_BUTTON,
                  "border-border text-dim",
                  // The destructive colour arrives on hover rather than at rest: a red glyph on
                  // every card of a customizable page reads as six things being wrong.
                  "hover:border-destructive/60 hover:text-destructive",
                )}
              >
                <Trash2 className={TRAY_ICON} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      }
    >
      {children}
    </StatsCard>
  );
}
