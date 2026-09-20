/**
 * Moving a **sticky note** past its neighbours on the board — the gesture, and the two pure
 * functions a drag and a key press both write through.
 *
 * `features/decks/categoryDrag.ts` is the precedent and this is deliberately the same shape one
 * table over: a *pile* dragged past other piles writes `deck_category_reorder`, a *note* dragged
 * past other notes writes `sticky_note_reorder`, and both commands take **every** id and write
 * the order column from position. That is why {@link movedTo} answers a whole list rather than a
 * from/to pair, and why the board hands it every note it is drawing rather than the two the
 * gesture named.
 *
 * ## The mark, and why it is not anybody else's
 *
 * Every `draggable` in this window writes into one untyped store, so a reader of it has to refuse
 * anything without *its* own mark and then field-check what is left. {@link STICKY_NOTE_MARK} is
 * this gesture's and nothing else's, exactly as `categoryDrag.ts`'s is that one's: a note can
 * never be dropped into a deck category and a pile can never land on a note, and the fence is a
 * property of the payload rather than of which surface happens to be on screen.
 *
 * ## `sortOrder` is monotonic and never dense
 *
 * A delete leaves holes, and `reorder_notes` lets an id it does not recognise consume a position
 * — so nothing here may compute a destination out of a stored `sortOrder`, and nothing may assume
 * position *n* in the drawn list is `sortOrder` *n*. Both functions below work over the **ids in
 * the order they are drawn** and answer the ids in the order they should be written; the numbers
 * in the column are Rust's business and this module never sees one.
 *
 * ## A drop marks a target and never an insertion point, and that is a decision
 *
 * `features/decks/DropIndicator.tsx` argues the same choice from the other end and for a reason
 * that does not hold here: `deck_cards` has no order column, so a line drawn between two rows
 * would promise a position the data model cannot keep. `sticky_notes` **has** one, so a promise
 * of "between these two" is one this feature could keep — and it is still the wrong mark, for two
 * reasons the grid supplies rather than the table.
 *
 * The board is a **wrapping grid of tiles** whose gutter is the card's own row gap, four to six
 * pixels: an insertion rule drawn in it would be a hairline in a gap narrower than the ring the
 * tiles either side already wear, and at the end of a row it would have to jump to the far edge
 * of the card to mean "first of the next row". And **there is no edge hit-test to drive it**:
 * dnd-kit answers *which target the pointer is over*, not *which side of it*, and the hitbox
 * package that computed a closest edge went out with pragmatic-dnd. So a line would advertise a
 * precision the gesture cannot deliver even though the column could store it.
 *
 * What is drawn instead is the target going gold, and the write is *land where this one is* —
 * `useCategoryReorderDrop`'s rule, kept because it is also what the arrow keys mean. One step
 * further along is the same move by either hand, where an edge hitbox would be a second and
 * quietly different answer for the mouse.
 */
import { useCallback } from "react";

import { dndDraggable, useDndDropTarget, useDndTargetRef } from "@/lib/dndTarget";

/**
 * The mark that says a drag is a sticky note being moved, and nothing else.
 *
 * A key of its own rather than a deck gesture's — see this module's header. Every reader in the
 * app refuses a payload without its own mark, so the two ends are fenced off from each other
 * rather than by which surface is mounted.
 */
const STICKY_NOTE_MARK = "mtg-grimoire/sticky-note-order";

/** What a note tile puts in the air. */
export function stickyNoteDragData(id: number): Record<string, unknown> {
  return { [STICKY_NOTE_MARK]: true, stickyNoteId: id };
}

/**
 * The note a drag is carrying, or `null` for every other drag in the window.
 *
 * Field by field, like `categoryDrag.ts`' reader: the library's store is untyped by construction,
 * so the mark is checked first and the id is then checked for being an id — a payload carrying
 * this mark with a string, a float or a zero in it is refused rather than sent to a command.
 */
export function readStickyNoteDrag(data: Record<string, unknown>): number | null {
  if (data[STICKY_NOTE_MARK] !== true) return null;
  const id = data.stickyNoteId;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * One id moved to one position — the whole of what a reorder is, as a pure function.
 *
 * `sticky_note_reorder` takes **every** id and writes `sort_order` from position, so a move is
 * expressed as the list it produces rather than as a from/to pair. Total: an id the list does not
 * hold, and a position off either end, both answer a copy of the list they were given rather than
 * throwing — a reorder that raced a delete in another window still lands somewhere sensible.
 */
export function movedTo(ids: readonly number[], id: number, to: number): number[] {
  const next = [...ids];
  const from = next.indexOf(id);
  if (from < 0) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  if (from === target) return next;
  next.splice(from, 1);
  next.splice(target, 0, id);
  return next;
}

/**
 * One id stepped `delta` places along the order, within the first `within` positions.
 *
 * **The keyboard's move, and `within` is what keeps it to the board the reader is looking at.**
 * A board draws whole rows and cuts the rest (`boardGeometry`), and a pointer can only aim at a
 * tile that is drawn — so without the cap an arrow key could step a note past the last drawn tile
 * and out of sight, which is a gesture whose result the reader cannot see. `within` is that tile
 * count; it is clamped against the list's own length, so a board with room for more tiles than
 * there are notes is not a licence to step past the end.
 *
 * Expressed through {@link movedTo} rather than beside it, so the two gestures cannot come to
 * disagree about what moving a note means.
 */
export function steppedBy(
  ids: readonly number[],
  id: number,
  delta: number,
  within: number,
): number[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  const last = Math.min(within, ids.length) - 1;
  // A board with room for no tile has no position to step to — and `Math.max(0, …)` here instead
  // would make *zero tiles* mean *move it to the front*, which is the one answer nobody asked
  // for. A card that draws none is unreachable from the board (there is no tile to focus), so
  // this is the function staying total rather than a case with a surface behind it.
  if (last < 0) return [...ids];
  return movedTo(ids, id, Math.max(0, Math.min(last, from + delta)));
}

/**
 * A note tile as both ends of the gesture: the thing that can be picked up, and the place another
 * note can be dropped.
 *
 * **One element carries both**, which is what the two marks want: `src/lib/dropMarks.ts`' rule is
 * that a drop mark goes on the element carrying the target's own edge, and a tile's edge is on the
 * `<button>` that is also the drag source. Registering the target on the `<li>` around it and
 * marking the button would be the three-concentric-outlines bug that file was written about.
 *
 * **No `handle` and therefore no `sensors` of its own.** A tile is small and is the whole of what
 * is being moved, so there is nowhere narrower for a press to start — which means the manager's
 * own `PointerSensor` instance is used unchanged, and this source cannot be the one that trips
 * issue #331's per-source sensor erasure. It also means the library's own activation constraints
 * are still in force, so a plain click on a tile is a click and opens the editor.
 *
 * ⚠️ **Both constraints, and *either one alone* activates** — 5px of travel **or** a 200ms hold.
 * So "a plain click opens the editor" is a claim about a *quick* press, not about a still one: a
 * reader who presses a tile and holds it without moving has begun a drag, which is dnd-kit's
 * touch affordance and is wanted here. It is stated because the distance half on its own reads
 * like the whole rule — a test in this feature asserted exactly that and failed the first time a
 * loaded `verify` held the press past 200ms.
 *
 * **`armed` is raised on every other tile at `dragstart` rather than only on the one under the
 * pointer**, which is `useDndDropTarget`'s own rule: a note picked up on a board of eight lights
 * the seven it could go to at once, instead of nothing until the pointer happens to cross one. It
 * costs nothing when something else in the window is in the air — {@link readStickyNoteDrag}
 * refuses that payload, so the tile is skipped before it is ever measured.
 */
export function useStickyNoteTile(
  id: number,
  onMove: (dragged: number, targetId: number) => void,
): {
  /** A callback ref for the tile's own `<button>`. Returns the teardown React 19 runs in place of
   *  calling it with `null`, so the source and the target are unregistered together. */
  attach: (element: HTMLElement | null) => (() => void) | undefined;
  /** A note is in the air and this tile is somewhere it could go. */
  armed: boolean;
  /** …and it is this one. */
  over: boolean;
} {
  // `attach` rather than `ref` — React's ref lint reads a hook result called `ref` as a ref object
  // and flags every read beside it as a ref access during render. `useDndTargetRef` carries why
  // the element has to be state rather than a plain ref.
  const { ref, attach: attachTarget } = useDndTargetRef();

  const attach = useCallback(
    (element: HTMLElement | null) => {
      const releaseTarget = attachTarget(element);
      if (!element) return releaseTarget;
      // Read as the drag begins rather than here: `dndDraggable`'s own rule, and the reason the
      // record is a callback at all.
      const releaseSource = dndDraggable({ element, data: () => stickyNoteDragData(id) });
      return () => {
        releaseSource();
        releaseTarget();
      };
    },
    [attachTarget, id],
  );

  // The same question twice — "a note is in the air and it is not this one" — asked once for the
  // mark and once for the write. A note dragged over itself lights nothing and writes nothing.
  const canDrop = useCallback((dragged: number) => dragged !== id, [id]);
  const onDrop = useCallback((dragged: number) => onMove(dragged, id), [id, onMove]);
  const { armed, over } = useDndDropTarget({ ref, read: readStickyNoteDrag, canDrop, onDrop });

  return { attach, armed, over };
}
