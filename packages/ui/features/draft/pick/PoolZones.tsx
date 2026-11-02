import { useMemo, useRef, type JSX } from "react";
import { useDndDropTarget } from "@/lib/dndTarget";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import type { DraftCard } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { readPickDrag, type PickDrag } from "./pickDrag";
import { PoolColumns } from "./PoolColumns";
import { splitPool, type Destination } from "./split";

/** A pick let go over one of the zones: whether it may be, and what it does there. */
export interface ZoneDrop {
  canDrop: (drag: PickDrag) => boolean;
  onDrop: (drag: PickDrag, to: Destination) => void;
}

/**
 * **The pool as Deck and Sideboard** (issue #1471) — Arena's two lists, each a curve
 * (`PoolColumns`). A card from the pack dropped on either is picked into it (`drop`); a press on a
 * card in either sends it to the other (`onMove`). The split is the page's (`./split.ts`).
 *
 * Both are drop targets for the pointer only, as the pool was: a pick cannot be taken back, so it
 * is where the pointer is let go, never a carried card's corner overlapping a zone.
 */
export function PoolZones({
  pool,
  sideboard,
  onMove,
  drop,
}: {
  pool: readonly DraftCard[];
  /** The `instanceId`s on the sideboard; every other card is the deck's. */
  sideboard: readonly string[];
  onMove?: (card: DraftCard, to: Destination) => void;
  /** Absent where nothing is picked by a drop (a Winston table, the Build step). */
  drop?: ZoneDrop;
}): JSX.Element {
  const split = useMemo(() => splitPool(pool, sideboard), [pool, sideboard]);
  const deckRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);
  const canDrop = (drag: PickDrag) => drop?.canDrop(drag) ?? false;
  const deckTarget = useDndDropTarget({
    ref: deckRef,
    read: readPickDrag,
    canDrop,
    onDrop: (drag) => drop?.onDrop(drag, "deck"),
    pointerOnly: true,
  });
  const sideTarget = useDndDropTarget({
    ref: sideRef,
    read: readPickDrag,
    canDrop,
    onDrop: (drag) => drop?.onDrop(drag, "sideboard"),
    pointerOnly: true,
  });
  const zone = (target: { armed: boolean; over: boolean }) =>
    cn("-m-1.5 rounded-xl p-1.5", target.armed && DROP_RING, target.over && DROP_OVER);

  return (
    <div className="flex flex-col gap-6">
      <div ref={deckRef} className={zone(deckTarget)}>
        <PoolColumns
          pool={split.deck}
          title="Deck"
          empty="The cards you pick land here, by mana value."
          moveTo="sideboard"
          onMove={onMove}
        />
      </div>
      <div ref={sideRef} className={zone(sideTarget)}>
        <PoolColumns
          pool={split.sideboard}
          title="Sideboard"
          empty={
            drop === undefined
              ? "Nothing in your sideboard. Click a card in your deck to move it here."
              : "Drop a card here to pick it into your sideboard, or click a card in your deck to move it here."
          }
          moveTo="deck"
          onMove={onMove}
        />
      </div>
    </div>
  );
}
