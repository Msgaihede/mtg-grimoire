/**
 * The one field that names a folder, drawn **as the tile itself** rather than in a strip above the
 * wall.
 *
 * **What this replaced was a panel, and the panel's problem was that it was somewhere else.** Both
 * pages opened a bordered strip under the breadcrumb — a box with its own edge, its own
 * background, an input, `Create folder` and `Cancel` spelled out in words, and a line reading
 * *in Collection* to say which level the strip was about. Every one of those pieces existed to
 * re-establish a context the reader could already see: the level is the wall they are looking at,
 * and the thing being named is going to appear in it. So the strip said, at the size of a second
 * panel, what the wall says by being on screen.
 *
 * The tile says it by being the tile. A name is typed **on the line the folder's name will
 * occupy**, at the same track and the same 62px footprint, so nothing reflows when the field opens
 * and nothing moves when it closes — and ✓ / ✕ take the corner a folder card already gives its
 * `⋯`, which is the one place on a card a reader has been taught to find its controls.
 *
 * **Two shapes, and the border is what tells them apart** — the app's dashed-means-provisional
 * rule ({@link NewFolderCard} argues it in full) decides which:
 *
 * - `create` is **solid**, because the tile is still a control. It is a thing you press standing
 *   among things you open, and it holds no folder yet.
 * - `rename` is **dashed**, because the thing being renamed is already a container. Its figures
 *   line stays under the field ({@link FolderNameFieldProps.footer}), so a reader renaming
 *   *Trade binder* can still see it is the drawer holding 240 cards.
 *
 * Both wear `border-accent` while the field is open, which is the whole of what says *this tile is
 * live*. Neither draws a heading, a hint or a word for its buttons: an input on a folder tile with
 * a tick beside it is not a sentence that needs writing out.
 *
 * **Escape is deliberately not handled here.** The field is one arm of the page's `Panel`, so the
 * page's `"inner"` rung already closes it — and `useDismissOnEscape` listens on `window` in the
 * capture phase, so a handler here would be a second registration for one layer that could never
 * run first anyway. Enter is the `<form>`'s own implicit submission; blur discards.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode, RefObject } from "react";
import { Check, Folder, FolderPlus, X } from "lucide-react";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";

/**
 * A folder card's intrinsic height, so a tile stands at the right size when it is the **only**
 * thing in the wall — a cabinet with no folders in it yet, which is the state every reader meets
 * first. Beside a folder card `h-full` already matches it (the `<li>` is the grid item and grid
 * items stretch to the row), so this floor is what answers the *empty* case rather than what does
 * the matching.
 *
 * **Measured rather than reasoned**, in headless Chromium over Tailwind's own compiled utilities
 * at the wall's real `grid-cols-[repeat(auto-fill,minmax(180px,1fr))]` track: a folder card's
 * button computes **62px** — `p-2.5` (10 × 2) + a `text-sm` line (20) + `mt-1` (4) + a `text-xs`
 * line (16) + two 1px borders. `NewFolderCard`'s own content reaches the same 62 by a different
 * route (20 + a `size-4` glyph + `gap-1` + a `text-sm` line + 2), which is two type scales
 * agreeing today rather than a guarantee — so the floor is written down, and changing the glyph
 * or the gap cannot silently shorten the tile out from under the wall.
 *
 * **`calc(3.75rem + 2px)` rather than a flat `3.875rem`, because the two hairlines are the one
 * part that does not scale.** Everything else in that sum is `rem` — the padding, both line
 * heights, the gap — and a 1px border is a hairline at every size, which is this app's standing
 * rule about what a zoom or a root font size may move. Written that way the floor stays exactly a
 * folder card's height rather than 2px of drift past it.
 *
 * It is a floor on a **block child of the grid item**, not on a flex item, so it grows the box
 * rather than capping it — the failure a past session recorded, where a `min-h` replaced a flex
 * item's `min-height: auto` and the content spilled two elements away. Driven at the narrowest
 * real track (180px) with a label long enough to take two lines, the button measured 82px with
 * `scrollHeight === clientHeight` and the label's rect inside the button's on all four sides:
 * it wraps and grows, and clips nothing.
 *
 * **It moved here from `NewFolderCard` on 2026-09-03, because the naming tile needs it too** — a
 * tile that shrank the moment it became a field would reflow the wall on every press, which is
 * the one thing this whole arrangement promises not to do. This module is the one of the two that
 * depends on nothing: the tile renders the field, so the constant travelling the other way would
 * be a cycle.
 */
export const FOLDER_CARD_HEIGHT = "min-h-[calc(3.75rem+2px)]";

/**
 * The room the two corner controls need, as the box's own right padding.
 *
 * `right-1` + 28px + a 2px gap + 28px = 62, and 4 more so a long name stops short of the tick
 * rather than running under it. It is a literal because Tailwind scans source text for whole
 * class names and a value built by arithmetic emits no rule at all.
 */
const CORNER_ROOM = "pr-[4.125rem]";

/** One corner control's shape — the `⋯`'s box, so the three never disagree about the geometry. */
const CORNER_BUTTON = "grid size-7 place-items-center rounded-md";

export type FolderNameFieldProps = {
  /**
   * Which of the two jobs this is — and therefore the glyph, the border and the words on the
   * tick. One prop rather than three, because a caller cannot assemble an incoherent combination
   * of them: a solid-bordered rename would spend the wall's word for "container" wrong.
   */
  mode: "create" | "rename";
  /** The input's accessible name — "New folder name", or "Rename Trade binder". */
  label: string;
  /** The name the field opens on, arriving **selected**: the commonest rename replaces the word
   *  rather than edits inside it. Empty for a create. */
  initial?: string;
  /** The tick's accessible name, which is the only place the two jobs read differently in words —
   *  "Create folder" / "Rename folder". Never printed: the corner has room for a glyph. */
  submitLabel: string;
  /** The write is in flight. Holds the field open, greys the tick, and suspends the blur discard —
   *  a control that disables itself on the press is blurred by the browser with no `relatedTarget`
   *  at all, which would otherwise read as the reader looking away. */
  pending: boolean;
  /** The figures line, drawn under the field on a rename so the drawer still says what is in it.
   *  Nothing to say on a create — the folder does not exist yet. */
  footer?: ReactNode;
  onSubmit: (name: string) => void;
  onCancel: () => void;
};

export function FolderNameField({
  mode,
  label,
  initial = "",
  submitLabel,
  pending,
  footer,
  onSubmit,
  onCancel,
}: FolderNameFieldProps): ReactElement {
  const rootRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initial);

  // Both calls, in this order. The spec says `select()` only sets the selection, and jsdom
  // implements the spec — where Chromium focuses on select, which is what makes a missing
  // `focus()` look sufficient in the shipped window and fail in the suite. The name arrives
  // selected because the commonest rename replaces the word rather than edits inside it.
  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, []);

  const trimmed = name.trim();
  const Glyph = mode === "create" ? FolderPlus : Folder;

  const field = (
    <input
      ref={inputRef}
      aria-label={label}
      value={name}
      onChange={(e) => setName(e.target.value)}
      className={cn(
        // No border, no background and no padding of its own: the tile is the field, so a second
        // box drawn inside the first would be the strip this replaced, one level in.
        "min-w-0 flex-1 border-0 bg-transparent p-0 text-sm leading-5",
        "text-text caret-accent outline-none",
      )}
    />
  );

  return (
    <form
      ref={rootRef}
      // `h-full` on the create shape alone, and it is the tile's `h-full` reaching through: the
      // `<li>` is the grid item and stretches to the tallest card in its row, so a naming tile
      // sized only by its own floor would shrink the moment it opened beside a card with a long
      // wrapped name. A rename does not want it — a folder card's own button is content-height,
      // so a field that stretched would be taller than the card it replaced.
      className={mode === "create" ? "h-full" : undefined}
      // **`data-no-drag` on the whole form, not on each control.** `NOT_A_DRAG` is matched with
      // `closest()`, so one mark on the root covers the input, the tick and the cross at once —
      // and it is load-bearing on a rename, where the `<li>` under this form is a folder drag
      // source: without it, pressing into the field and moving five pixels files the folder
      // somewhere instead of placing the caret, and the press that was meant is never delivered.
      data-no-drag=""
      onSubmit={(e) => {
        e.preventDefault();
        if (!trimmed || pending) return;
        onSubmit(trimmed);
      }}
      // Clicking or tabbing away discards a half-typed name, exactly as every other layer in this
      // app discards its half-made decision.
      onBlur={(e) => {
        if (pending) return;
        if (!rootRef.current?.contains(e.relatedTarget)) onCancel();
      }}
    >
      {mode === "create" ? (
        <div
          className={cn(
            "flex h-full w-full items-center gap-2 rounded-xl border border-accent bg-surface p-2.5",
            FOLDER_CARD_HEIGHT,
            CORNER_ROOM,
          )}
        >
          <Glyph className="size-3.5 flex-none text-accent" aria-hidden="true" />
          {field}
        </div>
      ) : (
        <div
          className={cn(
            "w-full rounded-xl border border-dashed border-accent bg-surface p-2.5",
            CORNER_ROOM,
          )}
        >
          <span className="flex items-center gap-2">
            <Glyph className="size-3.5 flex-none text-accent" aria-hidden="true" />
            {field}
          </span>
          {footer}
        </div>
      )}

      {/* The corner a folder card gives its `⋯`, holding the two answers this field has. Absolute
          against the **`<li>`** rather than against anything here: a `<form>` with no positioning
          establishes no containing block, so the pair lands in the same place on a naming tile and
          on a renaming card, whose boxes are different heights. */}
      <div className="absolute right-1 top-1 flex gap-0.5">
        <button
          type="submit"
          aria-label={submitLabel}
          // A real `disabled`, not `aria-disabled`: the house rule is about controls that grey as
          // the reader types *and still have something to say*, and this one is a submit whose
          // whole meaning is the field beside it.
          disabled={!trimmed || pending}
          className={cn(
            CORNER_BUTTON,
            "text-accent transition-colors duration-150",
            "hover:bg-accent hover:text-accent-foreground",
            "disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-accent",
            "motion-reduce:transition-none",
            FOCUS,
          )}
        >
          <Check className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Cancel"
          onClick={onCancel}
          className={cn(
            CORNER_BUTTON,
            // `hover:bg-bg` where the `⋯` uses `hover:bg-surface`, and the difference is the box
            // underneath: this pair sits over a tile that has *become* `bg-surface`, so the `⋯`'s
            // wash would be a hover that paints nothing.
            "text-dim transition-colors duration-150 hover:bg-bg hover:text-text",
            "motion-reduce:transition-none",
            FOCUS,
          )}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}

/**
 * The caret's way back to the control the field replaced — a hook, because the control does not
 * exist while the field is open.
 *
 * **This is the one thing the field could not do for itself.** Every other layer in this app hands
 * focus back through the page's `dismiss`, which focuses the element it remembered as the opener;
 * that works because the opener is still mounted behind the layer. Here the opener *is* what the
 * field replaced — the `New folder` tile, or a folder card's `⋯` — so by the time the page focuses
 * it, it is a detached node and the call is a silent no-op. The element that should take the caret
 * is the one React has just rendered in its place, and only the host knows which that is.
 *
 * **The `document.body` test is what keeps this from stealing a caret.** CLAUDE.md's rule is that
 * an outside click does not hand focus back, because the reader is already somewhere else — so
 * this restores only when nothing else has taken it, which is exactly the state Escape, the ✕ and
 * a committed write all leave behind (the focused element unmounts and the browser drops the caret
 * to `<body>`). A click on another card lands there instead and this stays out of the way. A click
 * on dead space does end at `<body>` and does get the caret back, which is the right answer for a
 * different reason: focus on `<body>` restarts the next Tab from the top of the app, and the tile
 * the reader was just typing in is a better place to resume than the top of the window.
 */
export function useFolderFieldReturn<T extends HTMLElement>(open: boolean): RefObject<T | null> {
  const ref = useRef<T>(null);
  const was = useRef(open);

  useEffect(() => {
    const previously = was.current;
    was.current = open;
    if (open || !previously) return;
    const active = document.activeElement;
    if (active === null || active === document.body) ref.current?.focus();
  }, [open]);

  return ref;
}
