/**
 * Moving a **deck note** past its neighbours in the Notes band — issue #509.
 *
 * `categoryDrag.ts` is the precedent and this is its grip-and-card shape one table over: a pile
 * dragged past other piles writes `deck_category_reorder`, a note dragged past other notes writes
 * `deck_note_reorder`, and both commands take **every** id and write `sort_order` from position.
 * So a move is the whole list it produces — `categoryDrag.ts`' {@link movedTo}, reused rather than
 * spelled a third time.
 *
 * ## A grip, and not the whole card
 *
 * `stickyNoteDrag.ts` makes the whole tile the handle and this deliberately does not. A deck note
 * is **prose written to be read and copied** — the band is `select-text` for issue #473's reason —
 * so a press anywhere in the body has to stay a text selection. The grip in the card's title row
 * is the only place a press may start a drag; the card itself is the source, so what is in the air
 * previews the note being moved rather than a 14px glyph.
 *
 * ## The mark is this gesture's and nothing else's
 *
 * Every `draggable` in this window writes into one untyped store. A note cannot be dropped into a
 * deck category, a pile cannot land on a note, and a sticky note from the home page — the same
 * shape of row in a different table — cannot land here either: {@link readDeckNoteDrag} refuses
 * any payload without {@link DECK_NOTE_MARK}.
 *
 * ## A drop is *land where this one is*
 *
 * `useCategoryReorderDrop`'s rule and `stickyNoteDrag.ts`' too, and for their reason: dnd-kit
 * answers which target the pointer is over and not which side of it, and one arrow press on the
 * grip means the same one-place move.
 */
import { useCallback, useState } from "react";
import { PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";
import { dndDraggable, useDndDropTarget, useDndTargetRef } from "@/lib/dndTarget";

export { movedTo } from "./categoryDrag";

/** The mark that says a drag is a deck note being moved, and nothing else. */
const DECK_NOTE_MARK = "mtg-grimoire/deck-note-order";

/** What a note card puts in the air. */
export function deckNoteDragData(id: number): Record<string, unknown> {
  return { [DECK_NOTE_MARK]: true, deckNoteId: id };
}

/** The note a drag is carrying, or `null` for every other drag in the window. Field by field:
 *  a payload carrying this mark with anything but a positive integer id is refused. */
export function readDeckNoteDrag(data: Record<string, unknown>): number | null {
  if (data[DECK_NOTE_MARK] !== true) return null;
  const id = data.deckNoteId;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * A note card as both ends of the gesture: the thing picked up (by its grip) and the place
 * another note can land.
 *
 * **Both registrations go on the card's `<li>`**, which is `CategoriesDialog`'s row arrangement:
 * dnd-kit keys a `Draggable` and a `Droppable` in two registries, so one element can be both. The
 * drop marks go on that element too, because it carries the card's own border.
 *
 * **The handle is state rather than a ref** for `useCategoryDragSource`'s reason: a source
 * registered before its grip arrives would drag from anywhere in the card, body text included. And
 * a declared handle switches dnd-kit's default activation constraints off, so the 5px distance is
 * put back — without it a plain click on the grip is a zero-pixel reorder. The per-source sensor
 * list also drops `KeyboardSensor`, so arrow keys on the grip are this feature's own move rather
 * than a library drag.
 *
 * `onMove` is `undefined` for a band that offers no reorder (a single note, or the workbench's
 * still states): nothing is registered at all, so the card is not a source and not a target.
 */
export function useDeckNoteReorder(
  id: number,
  onMove: ((dragged: number, targetId: number) => void) | undefined,
): {
  /** Callback ref for the card's `<li>`. */
  attachCard: (element: HTMLElement | null) => (() => void) | undefined;
  /** Callback ref for the grip `<button>`. */
  attachHandle: (element: HTMLElement | null) => () => void;
  /** A note is in the air and this card is somewhere it could go. */
  armed: boolean;
  /** …and it is this one. */
  over: boolean;
} {
  const enabled = onMove !== undefined;
  const [handle, setHandle] = useState<HTMLElement | null>(null);
  const { ref, attach: attachTarget } = useDndTargetRef();

  const attachHandle = useCallback((element: HTMLElement | null) => {
    setHandle(element);
    return () => setHandle(null);
  }, []);

  const attachCard = useCallback(
    (element: HTMLElement | null) => {
      if (!element || !enabled) return undefined;
      const releaseTarget = attachTarget(element);
      const releaseSource =
        handle === null
          ? undefined
          : dndDraggable({
              element,
              handle,
              data: () => deckNoteDragData(id),
              sensors: [
                PointerSensor.configure({
                  activationConstraints: [new PointerActivationConstraints.Distance({ value: 5 })],
                }),
              ],
            });
      return () => {
        releaseSource?.();
        releaseTarget();
      };
    },
    [attachTarget, enabled, handle, id],
  );

  const canDrop = useCallback((dragged: number) => enabled && dragged !== id, [enabled, id]);
  const onDrop = useCallback((dragged: number) => onMove?.(dragged, id), [id, onMove]);
  const { armed, over } = useDndDropTarget({ ref, read: readDeckNoteDrag, canDrop, onDrop });

  return { attachCard, attachHandle, armed: armed && enabled, over: over && enabled };
}
