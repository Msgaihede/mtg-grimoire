/**
 * Which numbers pop, and where — the damage and life pops' selection, with nothing drawn.
 *
 * **Out of the step's facts** (`PlaytestHappened`), the ones a reader would want to see land:
 * damage to a creature (`dealt`, popped over the creature) and a life total moved by the rules
 * (`life`, popped by that seat's plate — red for a loss, green for a gain). A life total the
 * reader set by hand pops nothing: they are looking at the plate they changed.
 *
 * **`dealt` names the very permanent hit** (`targetId`, on `seat`'s battlefield), so of two
 * creatures of one name the right one pops. A creature the damage killed is already gone from the
 * view; then nothing pops, rather than a number over the wrong card.
 */
import type { GameCard, PlaytestHappened, PlaytestView } from "@/lib/ipc";
import type { Anchor } from "./arrows";
import { seatOfPlayer } from "./players";

export interface Pop {
  key: string;
  anchor: Anchor;
  /** "−3", "+2" — a real minus sign. */
  text: string;
  tone: "damage" | "loss" | "gain";
}

const MINUS = "−";

export function popsFor(happened: readonly PlaytestHappened[], view: PlaytestView): Pop[] {
  const out: Pop[] = [];
  const onTable = (cards: readonly GameCard[], id: number) => cards.find((c) => c.id === id);
  happened.forEach((h, i) => {
    if (h.type === "dealt" && h.amount > 0) {
      const target = onTable(seatOfPlayer(view, h.seat)?.battlefield ?? [], h.targetId);
      if (target !== undefined)
        out.push({
          key: `${i}`,
          anchor: { card: target.id },
          text: `${MINUS}${h.amount}`,
          tone: "damage",
        });
    }
    if (h.type === "life" && h.amount !== 0) {
      out.push({
        key: `${i}`,
        anchor: { plate: h.seat },
        text: h.amount < 0 ? `${MINUS}${-h.amount}` : `+${h.amount}`,
        tone: h.amount < 0 ? "loss" : "gain",
      });
    }
  });
  return out;
}
