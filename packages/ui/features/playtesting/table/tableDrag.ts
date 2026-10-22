import type { RefObject } from "react";
import { PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";
import type { GamePlace, PlaytestAction } from "@/lib/ipc";
import { dndDraggable, releasePoint, useDndDragging, useDndDropTarget } from "@/lib/dndTarget";

/**
 * A card moved across the table — the payload, its reader, and the two registrations.
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
const MARK = "mtg-grimoire/table-card";
const MARK_KEY = "dragSource";

/** What a table drag carries: the cards (a pile is several), where they are, and a name. */
export interface TableDrag {
  /** The engine's ids from the current view. One for a single card; a whole pile's otherwise. */
  ids: number[];
  from: GamePlace;
  name: string;
}

export function tableDragData(drag: TableDrag): Record<string, unknown> {
  return { [MARK_KEY]: MARK, ...drag };
}

const PLACES: readonly GamePlace[] = [
  "hand",
  "battlefield",
  "graveyard",
  "exile",
  "command",
  "libraryTop",
  "libraryBottom",
];

export function readTableDrag(data: Record<string, unknown>): TableDrag | null {
  if (data[MARK_KEY] !== MARK) return null;
  const { ids, from, name } = data;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  if (!ids.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id >= 0))
    return null;
  if (typeof from !== "string" || !PLACES.includes(from as GamePlace)) return null;
  if (typeof name !== "string") return null;
  return { ids: ids as number[], from: from as GamePlace, name };
}

/**
 * What letting a card go over `to` asks of the game — or `null` when it asks nothing (a card
 * dropped where it already is, or a move the sandbox is not there to make).
 *
 * **A card from the hand or the command zone dropped on the battlefield is played**, the way a
 * double-click plays it: by the rules — and, with the sandbox on, put down unpaid when they do not
 * allow it; the engine decides which and says so. That is the one drop the rules make, so it is
 * the only one with `sandbox` off. **Anything else dropped anywhere is a move**, the sandbox's, as
 * a hand on a table would make it. A pile dragged from the battlefield moves **its top card**:
 * dragging a pile of seven Forests to the graveyard is one Forest, the way picking the top card
 * off a real pile is.
 *
 * `sandbox` is the board's own reading of it: on, the reader's main phase, nothing out.
 */
export function dropAction(
  drag: TableDrag,
  to: GamePlace,
  sandbox: boolean,
): PlaytestAction | null {
  const id = drag.ids[0];
  if (drag.from === to && to !== "libraryTop" && to !== "libraryBottom") return null;
  if (to === "battlefield" && (drag.from === "hand" || drag.from === "command")) {
    return { type: "play", id };
  }
  return sandbox ? { type: "move", id, to } : null;
}

/**
 * A card that can be picked up off the table.
 *
 * **A `handle` puts the 5px threshold back** (issue #1364), `useCategoryDragSource`'s way:
 * dnd-kit's default activation constraints are none at all for a mouse press inside a declared
 * handle, so the drag began on `pointerdown` and every click on the handle was a zero-pixel drag
 * that never reached its `onClick`. The handle is a card with an attachment tucked under it — so
 * a creature wearing a Role or an Equipment could not be picked as an attacker, a blocker or a
 * target, nor tapped for mana, by a click.
 */
export function tableDraggable({
  element,
  handle,
  payload,
}: {
  element: HTMLElement;
  /** The only place a press may start the drag, when the whole element is not it. */
  handle?: Element;
  /** Read at the press, so a pile that grew since it mounted carries what it is now. */
  payload: () => TableDrag;
}): () => void {
  return dndDraggable({
    element,
    handle,
    data: () => tableDragData(payload()),
    ...(handle === undefined
      ? {}
      : {
          sensors: [
            PointerSensor.configure({
              activationConstraints: [new PointerActivationConstraints.Distance({ value: 5 })],
            }),
          ],
        }),
  });
}

/** The card in the air, or `null` — what lights the zones that could take it. */
export function useTableDragging(): TableDrag | null {
  return useDndDragging(readTableDrag);
}

/**
 * One place a card can be let go. `overlay` for a target drawn over another (the zone columns
 * and the hand sit over the table's own box), so the smaller one wins the pointer.
 *
 * `pointerOnly` for the table: **a card is played only when the pointer is on the table.** The
 * default detector falls back to the carried card's whole shape, and a card lifted out of the
 * hand overlaps the table's bottom edge while the pointer is still in the hand or beside it — so
 * a card let go there was played. Dropping a card to play it is a decision the pointer makes,
 * not the card's corner.
 *
 * **A zone catches its own cards too**, and asks the game nothing for them. A card from the hand
 * let go over the hand asks nothing (`dropAction` is `null`) — the hand reorders itself by where it
 * was let go (`HandFan`, issue #1330) — and a zone that refused it would leave the
 * drop to whatever lies under it: the hand's band reaches up over the table's bottom edge, so a
 * card put back in the hand there was played. Caught, it is simply put back. Only a zone a card
 * could go to lights up for it, so the hand does not glow under a card carried out of it.
 *
 * `refuse` for a zone that is not the reader's — the board's opponents' tables: it takes
 * nothing, and a card let go over it falls through to whatever else is there (nothing).
 *
 * `sandbox` is {@link dropAction}'s: off, a zone takes only a play, so only the reader's table
 * lights up under a card from the hand, and the hand still catches its own cards back.
 */
export function useTableDropTarget({
  ref,
  place,
  onDrop,
  sandbox,
  overlay = false,
  pointerOnly = false,
  refuse = false,
}: {
  ref: RefObject<HTMLElement | null>;
  place: GamePlace;
  /** `at` is where the pointer let go, in the window's coordinates. */
  onDrop: (drag: TableDrag, place: GamePlace, at: { x: number; y: number }) => void;
  sandbox: boolean;
  overlay?: boolean;
  pointerOnly?: boolean;
  refuse?: boolean;
}): boolean {
  const dragging = useTableDragging();
  const { over } = useDndDropTarget({
    ref,
    read: readTableDrag,
    canDrop: (drag) =>
      !refuse && (drag.from === place || dropAction(drag, place, sandbox) !== null),
    onDrop: (drag) => onDrop(drag, place, releasePoint()),
    overlay,
    pointerOnly,
  });
  return !refuse && over && dragging !== null && dropAction(dragging, place, sandbox) !== null;
}

/**
 * A card or a player a carried card can be let go on to make one of the rules' plays — an
 * attack, a block, a target (`play/aim.ts`) — rather than a zone to move it to. The board says
 * what each one takes; the pieces only register it.
 */
export interface DropAim {
  accepts: (drag: TableDrag) => boolean;
  onAim: (drag: TableDrag) => void;
}

/** A table's aims: each card on it, by id, and the felt between them (`table`), when it is one. */
export interface TableAim {
  card: (id: number) => DropAim;
  table?: DropAim;
}

/**
 * One aim registered on `ref`, lit (`true`) while a card it takes is over it. With no `aim` it
 * takes nothing, so a piece can register one unconditionally.
 *
 * `overlay` for a card on a table — **it is drawn over the table's own target**, and has to win
 * the pointer against it while the pointer is on the card and lose it everywhere else, which is
 * exactly `useDndDropTarget`'s `overlay`. Anything else (a plate, a table's felt) is
 * `pointerOnly`: a plate is small, and a card carried past it must not be caught by its corner.
 */
export function useAimTarget({
  ref,
  aim,
  overlay = false,
}: {
  ref: RefObject<HTMLElement | null>;
  aim: DropAim | undefined;
  overlay?: boolean;
}): boolean {
  const { over } = useDndDropTarget({
    ref,
    read: readTableDrag,
    canDrop: (drag) => aim?.accepts(drag) ?? false,
    onDrop: (drag) => aim?.onAim(drag),
    overlay,
    pointerOnly: !overlay,
  });
  return over && aim !== undefined;
}
