import { useEffect, useRef, useState, type JSX } from "react";
import type { GameCard, GoldfishAction, GoldfishPlace } from "@/lib/ipc";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { cn } from "@/lib/utils";
import { DROP_GLOW } from "./Battlefield";
import { CardFace, pointerAt } from "./Inspect";
import { goldfishDraggable, useGoldfishDropTarget, type GoldfishDrag } from "./goldfishDrag";
import { HAND_CARD_H, HAND_CARD_W, HAND_LIFT, arrangeHand, handRow } from "./layout";
import { cardMenu } from "./menus";
import type { Pointed } from "./types";

/** How far past the row the hand's drop band reaches either side. */
const BAND_REACH = 80;

export interface HandFanProps {
  cards: GameCard[];
  onAct: (action: GoldfishAction) => void;
  onDrop: (drag: GoldfishDrag, to: GoldfishPlace) => void;
  onPoint: (pointed: Pointed) => void;
  onUnpoint: () => void;
  /** The card pointed at, which is pulled out of the row; `null` when it is not one of these. */
  pointedId: number | null;
}

/**
 * The reader's hand, held in a straight row at the foot of the board: each card shows its top,
 * the cards overlap when there are too many to sit side by side, and the card pointed at is
 * pulled up out of the row and drawn over its neighbours (`handRow`).
 *
 * **The order is the reader's, not the engine's** (`arrangeHand`): the kept hand is held lands
 * first, and a card drawn after that goes on the right.
 *
 * **The band is the hand's drop target and takes no pointer itself.** It reaches past the row
 * either side and as high as a lifted card, so its empty corners lie over the back row of the
 * table; a band that caught the pointer would make the lands under it unclickable. Drops are
 * found by geometry, not by what is under the pointer (`useDndDropTarget`'s `overlay`), so the
 * band still wins a card let go over it.
 */
export function HandFan({
  cards,
  onAct,
  onDrop,
  onPoint,
  onUnpoint,
  pointedId,
}: HandFanProps): JSX.Element {
  const ref = useRef<HTMLElement>(null);
  const over = useGoldfishDropTarget({ ref, place: "hand", onDrop, overlay: true });

  // The held order, carried from render to render: adjusted while rendering when the hand
  // changed, React's way to keep state that follows a prop without an effect.
  const [order, setOrder] = useState<number[]>([]);
  const arranged = arrangeHand(order, cards);
  if (arranged.length !== order.length || arranged.some((id, i) => id !== order[i])) {
    setOrder(arranged);
  }
  const byId = new Map(cards.map((c) => [c.id, c]));
  const held = arranged.flatMap((id) => byId.get(id) ?? []);
  const row = handRow(held.length);

  return (
    <section
      ref={ref}
      aria-label="Hand"
      className={cn(
        "pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2 rounded-t-2xl",
        over && DROP_GLOW,
      )}
      style={{ width: row.width + 2 * BAND_REACH, height: row.height }}
    >
      <div
        className="absolute top-0"
        style={{ left: BAND_REACH, width: row.width, height: row.height }}
      >
        {held.map((card, i) => (
          <HandCard
            key={card.id}
            card={card}
            left={row.lefts[i]}
            top={row.restTop}
            lifted={card.id === pointedId}
            onAct={onAct}
            onPoint={onPoint}
            onUnpoint={onUnpoint}
          />
        ))}
      </div>
    </section>
  );
}

function HandCard({
  card,
  left,
  top,
  lifted,
  onAct,
  onPoint,
  onUnpoint,
}: {
  card: GameCard;
  left: number;
  top: number;
  lifted: boolean;
  onAct: (action: GoldfishAction) => void;
  onPoint: (pointed: Pointed) => void;
  onUnpoint: () => void;
}): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  const { menu, menuKey } = useContextMenu();
  const { id, name } = card;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return goldfishDraggable({ element, payload: () => ({ ids: [id], from: "hand", name }) });
  }, [id, name]);

  const build = () => cardMenu({ card, ids: [id], place: "hand", onAct });
  const openMenu = menu(build);
  const play = () => onAct({ type: "play", id });

  return (
    <button
      ref={ref}
      type="button"
      aria-label={`${name}. Drag to play, or double-click`}
      data-land={id}
      onDoubleClick={play}
      // A double-click is a mouse's gesture; Enter on the focused card is the keyboard's way to
      // the same play (Space is the board's next turn). Their click carries no `detail`, a
      // mouse's always does.
      onClick={(e) => {
        if (e.detail === 0) play();
      }}
      onContextMenu={(e) => {
        onUnpoint();
        openMenu(e);
      }}
      onKeyDown={menuKey(build)}
      onMouseEnter={(e) =>
        onPoint({ card, ids: [id], place: "hand", line: `${name} · in hand`, at: pointerAt(e) })
      }
      onMouseLeave={() => onUnpoint()}
      data-point={id}
      // **The button never moves; only its face does.** Its box is the card at rest, so pulling
      // the face up cannot take the card out from under the pointer — and while it is up, the
      // strip it rose into is the button's too, so the pointer can follow the face.
      className={cn(
        "pointer-events-auto absolute cursor-grab rounded-md bg-transparent p-0",
        FOCUS,
        lifted && LAYER.raised,
      )}
      style={{ left, top, width: HAND_CARD_W, height: HAND_CARD_H }}
    >
      {lifted && (
        <span
          aria-hidden="true"
          className="absolute inset-x-0"
          style={{ top: -HAND_LIFT, height: HAND_LIFT }}
        />
      )}
      <span
        className={cn(
          "pointer-events-none block h-full w-full rounded-md",
          "transition-[translate,box-shadow] duration-150 ease-out motion-reduce:transition-none",
          lifted && "shadow-lg",
        )}
        style={{ translate: lifted ? `0 -${HAND_LIFT}px` : "0 0" }}
      >
        <CardFace card={card} />
      </span>
    </button>
  );
}
