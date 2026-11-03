import { useMemo, useRef, type JSX } from "react";
import { useDndDropTarget } from "@/lib/dndTarget";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import type { DraftCard } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { PANEL } from "../setup/parts";
import { readPickDrag, type PickDrag } from "./pickDrag";
import { PoolColumns } from "./PoolColumns";
import { PoolTray } from "./PoolTray";
import { splitPool, type Destination } from "./split";
import type { DraftTrayLayout } from "./trayLayout";

/** A pick let go over one of the zones: whether it may be, and what it does there. */
export interface ZoneDrop {
  canDrop: (drag: PickDrag) => boolean;
  onDrop: (drag: PickDrag, to: Destination) => void;
}

/**
 * **The pool as Deck and Sideboard** (issue #1471) — Arena's two lists: under the pack, side by
 * side on a panel of their own (`PoolColumns`, issue #1499), or, with `layout` `side`, a tray of
 * name rows beside it (`PoolTray`, issue #1474; the caller draws the panel round the two, and it
 * is their one scroller). A card from the pack dropped on either is picked into
 * it (`drop`); a press on a card in either sends it to the other (`onMove`). The split is the
 * page's (`./split.ts`).
 *
 * Both are drop targets for the pointer only, as the pool was: a pick cannot be taken back, so it
 * is where the pointer is let go, never a carried card's corner overlapping a zone.
 */
export function PoolZones({
  pool,
  sideboard,
  onMove,
  drop,
  layout = "bottom",
}: {
  pool: readonly DraftCard[];
  /** The `instanceId`s on the sideboard; every other card is the deck's. */
  sideboard: readonly string[];
  onMove?: (card: DraftCard, to: Destination) => void;
  /** Absent where nothing is picked by a drop (a Winston table, the Build step). */
  drop?: ZoneDrop;
  /** Curves under the pack, or trays beside it (`trayLayout.ts`). */
  layout?: DraftTrayLayout;
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
  const sideEmpty =
    drop === undefined
      ? "Nothing in your sideboard. Click a card in your deck to move it here."
      : "Drop a card here to pick it into your sideboard, or click a card in your deck to move it here.";

  if (layout === "side") {
    // The two trays one after the other at their whole height: the panel round them is the one
    // scroller (`PickScreen`), never a scroll per tray.
    return (
      <div className="flex flex-col gap-5">
        <div ref={deckRef} className={zone(deckTarget)}>
          <PoolTray pool={split.deck} title="Deck" moveTo="sideboard" onMove={onMove} />
        </div>
        <div ref={sideRef} className={zone(sideTarget)}>
          <PoolTray
            pool={split.sideboard}
            title="Sideboard"
            empty={sideEmpty}
            moveTo="deck"
            onMove={onMove}
          />
        </div>
      </div>
    );
  }

  // Side by side (issue #1499), so either is a drop away without a scroll. Each zone is as wide
  // as its columns want and both shrink in step, so a deck column and a sideboard column stay one
  // width; the panel sets the pool apart from the pack it is picked from.
  return (
    <div className={cn(PANEL, "flex items-start gap-7 p-4")}>
      <div ref={deckRef} className={cn(zone(deckTarget), "min-w-0 flex-[0_1_auto]")}>
        <PoolColumns pool={split.deck} title="Deck" moveTo="sideboard" onMove={onMove} />
      </div>
      <span aria-hidden="true" className="w-px self-stretch bg-border" />
      <div ref={sideRef} className={cn(zone(sideTarget), "min-w-0 flex-[0_1_auto]")}>
        <PoolColumns
          pool={split.sideboard}
          title="Sideboard"
          empty={sideEmpty}
          moveTo="deck"
          onMove={onMove}
          shape="grouped"
        />
      </div>
    </div>
  );
}
