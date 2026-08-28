import { type RefObject } from "react";
import { dndDraggable, useDndDragging, useDndDropTarget } from "@/lib/dndTarget";

/**
 * The gesture that files a deck into one of the filing cabinet's drawers — the payload, the two
 * readers of it, and the three registrations that raise a drawer's ring.
 *
 * **`dnd.ts`'s sibling, and the two are meant to be read together.** That module is the app's
 * *card* drag; this is the *deck* drag, and the pair share a key so that each refuses the
 * other's payload (see {@link DECK_MARK}). Everything here follows that module's rules for its
 * reasons: a payload is read field by field rather than cast, because the library's store is
 * untyped by construction; and a press on a control inside a draggable is a press on the
 * control, which since 3b is the library's own rule — `lib/dndManager.ts` configures
 * `PointerSensor.preventActivation` with this app's `NOT_A_DRAG` once, for every draggable in the
 * window, where each registration used to carry a copy of it.
 *
 * It sits beside `FolderTree.tsx` rather than inside it because the gallery registers these in
 * three places — a deck tile, a folder row, a folder card on the wall — and a drop target is not
 * a tree.
 */

/**
 * A deck in the air, and the mark that says so.
 *
 * **A different mark from `dnd.ts`'s, deliberately, and it shares that module's key.** A deck
 * is not a card, and the two must be told apart in both directions: `readDragData` refuses
 * anything whose `dragSource` is not the card mark, so a deck dragged over a category column or
 * over the sidebar's Decks entry lights nothing up and writes nothing; and `readDeckDrag`
 * refuses a card for the same reason. Sharing the key is what makes each fence answer the
 * other's payload rather than ignoring it.
 */
const DECK_MARK = "mtg-grimoire/deck-file-drag";
const MARK_KEY = "dragSource";

/** What a deck drag carries: the deck, and its name for whatever wants to say what moved. */
export interface DeckDrag {
  deckId: number;
  name: string;
}

/** What a deck tile hands the adapter. Flat, so `canDrop` reads it without unwrapping. */
export function deckDragData(drag: DeckDrag): Record<string, unknown> {
  return { [MARK_KEY]: DECK_MARK, ...drag };
}

/**
 * The payload a folder may act on, or `null` for everything else.
 *
 * Field by field rather than a cast — `dnd.ts`'s rule, for its reason: this is the app's
 * boundary with an untyped store every draggable in the window writes into.
 */
export function readDeckDrag(data: Record<string, unknown>): DeckDrag | null {
  if (data[MARK_KEY] !== DECK_MARK) return null;
  const { deckId, name } = data;
  if (typeof deckId !== "number" || !Number.isSafeInteger(deckId) || deckId <= 0) return null;
  if (typeof name !== "string") return null;
  return { deckId, name };
}

/**
 * A deck tile that can be picked up, and a press on one of its controls that is a press on the
 * control.
 *
 * `cardDraggable`'s arrangement rather than `cardDraggable` itself: the payload is a deck and
 * the mark has to differ (see {@link DECK_MARK}), so what is shared is `dndDraggable` and the
 * reasoning. **The guard the exclusion needs is a removal rather than a regression.** A tile
 * carries a Delete button and a drag starts from the nearest draggable *ancestor* of whatever
 * was pressed, so without an exclusion a press on Delete plus five pixels of travel is a drag of
 * the whole tile and the click never lands. This used to be a capture-phase `mousedown` here
 * remembered for a `canDrag`; `lib/dndManager.ts` now configures
 * `PointerSensor.preventActivation` with `NOT_A_DRAG` once for the whole window, so the rule is
 * said once instead of once per registration.
 */
export function deckDraggable({
  element,
  payload,
}: {
  element: HTMLElement;
  /** Read at the press, so a tile renamed since it mounted carries what it is now. */
  payload: () => DeckDrag;
}): () => void {
  return dndDraggable({ element, data: () => deckDragData(payload()) });
}

/**
 * The deck in the air, or `null` — what raises the ring on every folder that could take it.
 *
 * The deck rather than a bare "something is being dragged", because a folder the deck is
 * already in cannot take it: a boolean would light every drawer up and then refuse the one the
 * reader aimed at. A card drag raises nothing here at all, and this is where that is decided.
 */
export function useDeckDragging(): DeckDrag | null {
  return useDndDragging(readDeckDrag);
}

/**
 * One place a deck can be let go: a folder row, or a folder card on the wall.
 *
 * `canDrop` and `onDrop` are read through a ref rather than through the effect's deps, so a
 * target does not tear itself down and re-register every time the deck list changes under it —
 * `AppShell`'s sidebar entries do the same, for the same reason.
 */
export function useDeckDropTarget({
  ref,
  canDrop,
  onDrop,
}: {
  ref: RefObject<HTMLElement | null>;
  canDrop: (drag: DeckDrag) => boolean;
  onDrop: (drag: DeckDrag) => void;
}): boolean {
  // Only `over`, deliberately. Every folder-shaped target answers the same yes/no about a deck,
  // so the ring is raised once by the page from {@link useDeckDragging}'s payload rather than per
  // target — which is the split `wishDrag.ts` explains at length and which does **not** hold for
  // a wish or a collection entry, where the folder a row is already in refuses it.
  const { over } = useDndDropTarget({ ref, read: readDeckDrag, canDrop, onDrop });
  return over;
}
