/**
 * Moving a **deck tag** past its neighbours in Deck settings — issue #913.
 *
 * `noteDrag.ts` is the precedent and this is its grip-and-card shape one field over: a chip is
 * picked up by its word and let go on another chip, and the write is the whole list it produces
 * (`deckTags.ts`' `movedTag`), which `DeckTagsField` hands to its `onChange` like any other edit.
 * There is no reorder command — `deck_update({ tags })` stores the list in the order it is sent.
 *
 * ## The word is the grip, and the ✕ is not
 *
 * The chip's ✕ takes it off, so a press there must stay a press. The word is the only place a drag
 * may start; the `<li>` is the source, so what is in the air is the whole chip rather than its
 * text.
 *
 * ## The mark is this gesture's and nothing else's
 *
 * Every `draggable` in this window writes into one untyped store, and the settings dialog is drawn
 * over a deck whose piles and notes are drop targets of their own. {@link readDeckTagDrag}
 * refuses any payload without {@link DECK_TAG_MARK}, and the readers on those surfaces refuse
 * this one.
 *
 * ## A drop is *land where this one is*
 *
 * `useCategoryReorderDrop`'s rule and `noteDrag.ts`' too, and for their reason: dnd-kit answers
 * which target the pointer is over and not which side of it, and one arrow press on the word means
 * the same one-place move.
 */
import { useCallback, useState } from "react";
import { PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";
import { dndDraggable, useDndDropTarget, useDndTargetRef } from "@/lib/dndTarget";

/** The mark that says a drag is a deck tag being moved, and nothing else. */
const DECK_TAG_MARK = "mtg-grimoire/deck-tag-order";

/** What a chip puts in the air. */
export function deckTagDragData(tag: string): Record<string, unknown> {
  return { [DECK_TAG_MARK]: true, deckTag: tag };
}

/** The tag a drag is carrying, or `null` for every other drag in the window. Field by field: a
 *  payload carrying this mark with anything but a non-empty string is refused. */
export function readDeckTagDrag(data: Record<string, unknown>): string | null {
  if (data[DECK_TAG_MARK] !== true) return null;
  const tag = data.deckTag;
  return typeof tag === "string" && tag !== "" ? tag : null;
}

/**
 * A chip as both ends of the gesture: the thing picked up (by its word) and the place another
 * chip can land.
 *
 * `useDeckNoteReorder` with a tag for an id, and for each of its reasons: both registrations go on
 * the `<li>`, the handle is state so a source never registers without it, the 5px distance is put
 * back so a click on the word is not a zero-pixel reorder, and the per-source sensor list leaves
 * out `KeyboardSensor` so the word's arrow keys are this feature's own move.
 *
 * `onMove` is `undefined` for a field with fewer than two tags: nothing is registered at all.
 */
export function useDeckTagReorder(
  tag: string,
  onMove: ((dragged: string, target: string) => void) | undefined,
): {
  /** Callback ref for the chip's `<li>`. */
  attachChip: (element: HTMLElement | null) => (() => void) | undefined;
  /** Callback ref for the word. */
  attachHandle: (element: HTMLElement | null) => () => void;
  /** A tag is in the air and this chip is somewhere it could go. */
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

  const attachChip = useCallback(
    (element: HTMLElement | null) => {
      if (!element || !enabled) return undefined;
      const releaseTarget = attachTarget(element);
      const releaseSource =
        handle === null
          ? undefined
          : dndDraggable({
              element,
              handle,
              data: () => deckTagDragData(tag),
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
    [attachTarget, enabled, handle, tag],
  );

  const canDrop = useCallback((dragged: string) => enabled && dragged !== tag, [enabled, tag]);
  const onDrop = useCallback((dragged: string) => onMove?.(dragged, tag), [onMove, tag]);
  const { armed, over } = useDndDropTarget({ ref, read: readDeckTagDrag, canDrop, onDrop });

  return { attachChip, attachHandle, armed: armed && enabled, over: over && enabled };
}
