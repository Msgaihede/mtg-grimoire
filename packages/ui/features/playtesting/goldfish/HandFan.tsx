import { useEffect, useRef, type JSX } from "react";
import type { GameCard, GoldfishAction, GoldfishPlace } from "@/lib/ipc";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { cn } from "@/lib/utils";
import { DROP_GLOW } from "./Battlefield";
import { CardFace, sideOf } from "./Inspect";
import { goldfishDraggable, useGoldfishDropTarget, type GoldfishDrag } from "./goldfishDrag";
import { fanHand, type HandSlot } from "./layout";
import { cardMenu } from "./menus";
import type { Pointed } from "./types";

export interface HandFanProps {
  cards: GameCard[];
  onAct: (action: GoldfishAction) => void;
  onDrop: (drag: GoldfishDrag, to: GoldfishPlace) => void;
  onPoint: (pointed: Pointed) => void;
  onUnpoint: () => void;
  /** The card pointed at, which is held up whole; `null` when it is not one of these. */
  pointedId: number | null;
}

/**
 * The reader's hand, held at the foot of the board: each card shows its top and rises whole when
 * pointed at (`fanHand`).
 *
 * **The band is the hand's drop target and takes no pointer itself.** It is as tall as a lifted
 * card, so its empty upper corners lie over the back row of the table; a band that caught the
 * pointer would make the lands under it unclickable. Drops are found by geometry, not by what is
 * under the pointer (`useDndDropTarget`'s `overlay`), so the band still wins a card let go over
 * it.
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
  const lifted = pointedId === null ? -1 : cards.findIndex((c) => c.id === pointedId);
  const fan = fanHand(cards.length, lifted < 0 ? null : lifted);

  return (
    <section
      ref={ref}
      aria-label="Hand"
      className={cn(
        "pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2 rounded-t-2xl",
        over && DROP_GLOW,
      )}
      style={{ width: fan.width + 40, height: fan.height }}
    >
      <div className="absolute top-0 left-5" style={{ width: fan.width, height: fan.height }}>
        {cards.map((card, i) => (
          <HandCard
            key={card.id}
            card={card}
            slot={fan.slots[i]}
            lifted={i === lifted}
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
  slot,
  lifted,
  onAct,
  onPoint,
  onUnpoint,
}: {
  card: GameCard;
  slot: HandSlot;
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
      onDoubleClick={play}
      // A double-click is a mouse's gesture; Enter or Space on the focused card is the keyboard's
      // way to the same play. Their click carries no `detail`, a mouse's always does.
      onClick={(e) => {
        if (e.detail === 0) play();
      }}
      onContextMenu={(e) => {
        onUnpoint();
        openMenu(e);
      }}
      onKeyDown={menuKey(build)}
      onMouseEnter={(e) =>
        onPoint({
          card,
          ids: [id],
          place: "hand",
          line: `${name} · in hand`,
          side: sideOf(e.clientX),
        })
      }
      onMouseLeave={onUnpoint}
      className={cn(
        "pointer-events-auto absolute h-[185px] w-[132px] origin-bottom cursor-grab rounded-md p-0",
        "transition-[top,transform] duration-150 ease-out motion-reduce:transition-none",
        FOCUS,
        lifted && LAYER.raised,
      )}
      style={{ left: slot.left, top: slot.top, transform: `rotate(${slot.rotate}deg)` }}
    >
      <CardFace card={card} />
    </button>
  );
}
