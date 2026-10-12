import type { RefObject } from "react";
import type { GoldfishAction, GoldfishPlace } from "@/lib/ipc";
import { dndDraggable, useDndDragging, useDndDropTarget } from "@/lib/dndTarget";

/**
 * A card moved across the goldfish table — the payload, its reader, and the two registrations.
 *
 * **`features/decks/deckDrag.ts`'s arrangement, for its reasons**: one shared dnd-kit manager for
 * the window (`lib/dndManager.ts`, never the browser's own drag, which `CardImage` refuses), a
 * payload marked so that a deck card or a deck tile dragged anywhere near the board is not one of
 * these and the other way round, and read field by field because the library's store is untyped.
 *
 * **Every drop is a zone, never a coordinate.** The artboard's table is laid out by the rules —
 * creatures in front, lands and the rest behind — so where on the table a card is let go does not
 * decide where it sits; which zone it is let go over decides what happens to it (`dropAction`).
 */
const MARK = "mtg-grimoire/goldfish-card";
const MARK_KEY = "dragSource";

/** What a goldfish drag carries: the cards (a pile is several), where they are, and a name. */
export interface GoldfishDrag {
  /** The engine's ids from the current view. One for a single card; a whole pile's otherwise. */
  ids: number[];
  from: GoldfishPlace;
  name: string;
}

export function goldfishDragData(drag: GoldfishDrag): Record<string, unknown> {
  return { [MARK_KEY]: MARK, ...drag };
}

const PLACES: readonly GoldfishPlace[] = [
  "hand",
  "battlefield",
  "graveyard",
  "exile",
  "command",
  "libraryTop",
  "libraryBottom",
];

export function readGoldfishDrag(data: Record<string, unknown>): GoldfishDrag | null {
  if (data[MARK_KEY] !== MARK) return null;
  const { ids, from, name } = data;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  if (!ids.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id >= 0))
    return null;
  if (typeof from !== "string" || !PLACES.includes(from as GoldfishPlace)) return null;
  if (typeof name !== "string") return null;
  return { ids: ids as number[], from: from as GoldfishPlace, name };
}

/**
 * What letting a card go over `to` asks of the game — or `null` when it asks nothing (a card
 * dropped where it already is).
 *
 * **A card from the hand or the command zone dropped on the battlefield is played**, the way a
 * double-click plays it: by the rules when they allow (a land drop, a paid cast) and placed by
 * hand when they do not — the engine decides which and says so. Anything else dropped anywhere is
 * a move, as a hand on a table would make it. A pile dragged from the battlefield moves **its top
 * card**: dragging a pile of seven Forests to the graveyard is one Forest, the way picking the top
 * card off a real pile is.
 */
export function dropAction(drag: GoldfishDrag, to: GoldfishPlace): GoldfishAction | null {
  const id = drag.ids[0];
  if (drag.from === to && to !== "libraryTop" && to !== "libraryBottom") return null;
  if (to === "battlefield" && (drag.from === "hand" || drag.from === "command")) {
    return { type: "play", id };
  }
  return { type: "move", id, to };
}

export function goldfishDraggable({
  element,
  payload,
}: {
  element: HTMLElement;
  /** Read at the press, so a pile that grew since it mounted carries what it is now. */
  payload: () => GoldfishDrag;
}): () => void {
  return dndDraggable({ element, data: () => goldfishDragData(payload()) });
}

/** The card in the air, or `null` — what lights the zones that could take it. */
export function useGoldfishDragging(): GoldfishDrag | null {
  return useDndDragging(readGoldfishDrag);
}

/**
 * One place a card can be let go. `overlay` for a target drawn over another (the zone columns
 * and the hand sit over the table's own box), so the smaller one wins the pointer.
 */
export function useGoldfishDropTarget({
  ref,
  place,
  onDrop,
  overlay = false,
}: {
  ref: RefObject<HTMLElement | null>;
  place: GoldfishPlace;
  onDrop: (drag: GoldfishDrag, place: GoldfishPlace) => void;
  overlay?: boolean;
}): boolean {
  const { over } = useDndDropTarget({
    ref,
    read: readGoldfishDrag,
    canDrop: (drag) => dropAction(drag, place) !== null,
    onDrop: (drag) => onDrop(drag, place),
    overlay,
  });
  return over;
}
