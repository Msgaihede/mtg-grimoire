/**
 * Arranging the decks inside one colour combination on the **Deck colors** widget — the drag and
 * the payload it carries.
 *
 * `stickyNoteDrag.ts` is the precedent, one widget over, and this is the same gesture: a deck is
 * dragged onto another deck **of the same combination** and takes its place, and the arrow keys
 * mean the same move ({@link steppedBy} through {@link movedTo}, imported from there so the two
 * gestures cannot come to disagree about what moving one place means). What is drawn is the target
 * going gold, never an insertion line — that file's header argues why at length, and every word of
 * it holds for a row of chips that wraps.
 *
 * **The mark is this gesture's and nothing else's.** Every `draggable` in the window writes into
 * one untyped store, so {@link readDeckColorDrag} refuses anything without {@link DECK_COLOR_MARK}
 * and then checks the fields: a deck chip cannot be dropped into a deck category or onto a sticky
 * note, and a sticky note cannot land on a deck chip. **The combination rides in the payload** and
 * `canDrop` compares it, so a Boros deck cannot be dropped among the Azorius ones — its colour is a
 * fact about its cards, and a drag is not the place to change it.
 */
import { useCallback } from "react";

import { dndDraggable, useDndDropTarget, useDndTargetRef } from "@/lib/dndTarget";

export { movedTo, steppedBy } from "./stickyNoteDrag";

/** The mark that says a drag is a deck being arranged inside its colour combination. */
const DECK_COLOR_MARK = "mtg-grimoire/deck-color-order";

/** What a deck chip carries. */
export interface DeckColorDrag {
  deckId: number;
  /** The combination the deck is filed under, as a `ComboKey`. */
  combo: string;
}

/** What a deck chip puts in the air. */
export function deckColorDragData(drag: DeckColorDrag): Record<string, unknown> {
  return { [DECK_COLOR_MARK]: true, deckId: drag.deckId, combo: drag.combo };
}

/**
 * The deck a drag is carrying, or `null` for every other drag in the window. Field by field — the
 * store is untyped by construction, so a payload with this mark and a string id, a float or a
 * missing combination is refused rather than written.
 */
export function readDeckColorDrag(data: Record<string, unknown>): DeckColorDrag | null {
  if (data[DECK_COLOR_MARK] !== true) return null;
  const { deckId, combo } = data;
  if (typeof deckId !== "number" || !Number.isSafeInteger(deckId) || deckId <= 0) return null;
  if (typeof combo !== "string") return null;
  return { deckId, combo };
}

/**
 * A deck chip as both ends of the gesture — the thing picked up and the place another deck of its
 * combination lands. One element carries both, `useStickyNoteTile`'s reason: a drop mark goes on
 * the element carrying the target's own edge, and the chip's edge is on the button that is also
 * the source. No handle, so the manager's own activation constraints hold and a quick press is
 * still a press that opens the deck.
 */
export function useDeckColorChip(
  drag: DeckColorDrag,
  onMove: (dragged: number, targetId: number) => void,
): {
  attach: (element: HTMLElement | null) => (() => void) | undefined;
  armed: boolean;
  over: boolean;
} {
  const { ref, attach: attachTarget } = useDndTargetRef();
  const { deckId, combo } = drag;

  const attach = useCallback(
    (element: HTMLElement | null) => {
      const releaseTarget = attachTarget(element);
      if (!element) return releaseTarget;
      const releaseSource = dndDraggable({
        element,
        data: () => deckColorDragData({ deckId, combo }),
      });
      return () => {
        releaseSource();
        releaseTarget();
      };
    },
    [attachTarget, deckId, combo],
  );

  const canDrop = useCallback(
    (dragged: DeckColorDrag) => dragged.combo === combo && dragged.deckId !== deckId,
    [combo, deckId],
  );
  const onDrop = useCallback(
    (dragged: DeckColorDrag) => onMove(dragged.deckId, deckId),
    [deckId, onMove],
  );
  const { armed, over } = useDndDropTarget({ ref, read: readDeckColorDrag, canDrop, onDrop });

  return { attach, armed, over };
}
