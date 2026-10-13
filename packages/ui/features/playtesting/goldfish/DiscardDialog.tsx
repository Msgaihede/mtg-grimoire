import { useState, type JSX } from "react";
import type { GameCard, GoldfishAction, GoldfishView } from "@/lib/ipc";
import { CardImage } from "@/components/CardImage";
import { Dialog } from "@/components/Dialog";
import { cardImageUrl } from "@/lib/images";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { landsFirst } from "./layout";

/**
 * The cleanup step's discard: a turn passed with more cards in hand than the maximum hand size,
 * and the reader says which ones go (CR 514.1).
 *
 * **The engine says how many; this only collects which**, the way `OpeningHand` does for the
 * bottom of the library. `view.discard` is the count and `discard` is refused unless it carries
 * exactly that many ids from the hand, so the button stays greyed until the picks match.
 *
 * **Closing it is looking at the board, not taking the turn back.** The game is in its cleanup
 * step and stays there (`stage: "discard"`): the board draws "Discard N" where "Next turn" was,
 * which opens this again.
 */
export function DiscardDialog({
  view,
  onAct,
  onClose,
}: {
  view: GoldfishView;
  onAct: (a: GoldfishAction) => void;
  onClose: () => void;
}): JSX.Element {
  // Keyed on the hand's ids, like the opening hand: a pick held across a hand that changed would
  // name a card that is no longer in it.
  const key = view.hand.map((c) => c.id).join(",");
  return <Choosing key={key} view={view} onAct={onAct} onClose={onClose} />;
}

function Choosing({
  view,
  onAct,
  onClose,
}: {
  view: GoldfishView;
  onAct: (a: GoldfishAction) => void;
  onClose: () => void;
}): JSX.Element {
  const need = view.discard;
  /** Ids picked to discard, oldest pick first. */
  const [picked, setPicked] = useState<number[]>([]);

  const pick = (id: number) =>
    setPicked((now) => {
      if (now.includes(id)) return now.filter((x) => x !== id);
      // Past the count the oldest pick is dropped, as in the opening hand.
      const next = [...now, id];
      return next.length > need ? next.slice(next.length - need) : next;
    });

  const ready = picked.length === need;
  const cards = need === 1 ? "card" : "cards";

  return (
    <Dialog
      open
      title="Discard to hand size"
      subtitle={`${view.hand.length} cards in hand · pick ${need} ${cards} to discard before the turn ends`}
      closeLabel="Close and look at the board"
      size="w-[52rem]"
      onDismiss={onClose}
      onClose={onClose}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div
          role="group"
          aria-label="Your hand"
          className="grid grid-cols-[repeat(auto-fill,120px)] justify-center gap-x-3 gap-y-4"
        >
          {landsFirst(view.hand).map((card) => (
            <HandCard
              key={card.id}
              card={card}
              picked={picked.includes(card.id)}
              onPick={() => pick(card.id)}
            />
          ))}
        </div>
      </div>

      <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-3">
        <span className="text-xs text-dim">
          {picked.length} of {need} picked
        </span>
        <button
          type="button"
          // `aria-disabled`, never the attribute: it greys and ungreys as the reader picks, and a
          // `disabled` button would leave the tab order each time.
          aria-disabled={!ready}
          onClick={() => {
            if (ready) onAct({ type: "discard", ids: picked });
          }}
          className={cn(
            "inline-flex h-9 items-center rounded-full border border-accent bg-surface px-4",
            "text-[13px] font-semibold text-accent transition-colors motion-reduce:transition-none",
            PRESS,
            FOCUS,
            ready
              ? "hover:bg-accent hover:text-accent-fg"
              : "cursor-default opacity-45 active:scale-100",
          )}
        >
          Discard {need} and end the turn
        </button>
      </div>
    </Dialog>
  );
}

function HandCard({
  card,
  picked,
  onPick,
}: {
  card: GameCard;
  picked: boolean;
  onPick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={picked}
      aria-label={picked ? `${card.name}, to be discarded` : card.name}
      onClick={onPick}
      className={cn(
        "relative h-[168px] w-[120px] rounded-lg p-0",
        FOCUS,
        picked && "outline-2 outline-offset-2 outline-accent outline-solid",
      )}
    >
      {card.cardId !== null ? (
        <CardImage
          src={cardImageUrl(card.cardId, 0, "grid")}
          alt={card.name}
          className={cn("block h-full w-full rounded-md", picked && "opacity-60")}
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center rounded-md border border-border bg-surface p-2 text-center text-xs">
          {card.name}
        </span>
      )}
      {picked && (
        <span className="absolute bottom-2 left-1.5 rounded bg-accent px-1.5 py-px text-[11px] text-accent-fg">
          Discard
        </span>
      )}
    </button>
  );
}
