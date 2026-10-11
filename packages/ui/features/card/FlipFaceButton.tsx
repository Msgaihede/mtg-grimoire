import { FlipHorizontal2 } from "lucide-react";
import {
  BUTTON_OVER_ART,
  QUANTITY_STEPPER_CARD_BOX,
  QUANTITY_STEPPER_CARD_ICON,
} from "@/components/QuantityStepper";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS_INSET } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { toggleShownFace, useShownFace } from "./shownFace";

/**
 * The flip button drawn **under a card's quantity controls** — issue #844's button half, beside
 * the card menu's "Flip card" row.
 *
 * **The `size="card"` stepper's own box**, `QUANTITY_STEPPER_CARD_BOX` with the art backing, which
 * is the argument the wishlist's pencil already made one slot up: a control standing directly
 * under a vertical `card` stepper in one column up the card's right-hand edge has to be the same
 * object, at every stop of the zoom ladder, or the two read as controls that happen to be
 * adjacent. Both halves scale on `--control-scale`, so the box follows the reader's zoom with no
 * arithmetic here.
 *
 * Drawn only for a printing `hasBackFace` (`./printings`) says has a back — the caller's gate,
 * because only the caller holds the row's `layout`. A card with one side gets no button at all,
 * not a greyed one: there is nothing it could ever do.
 *
 * **`data-no-drag` is load-bearing**: every surface that draws this has a tile or a card that is
 * itself a drag source, and `NOT_A_DRAG` (`dnd.ts`) excludes form fields by tag but not buttons —
 * without the mark a press plus five pixels of travel is a drag of the card.
 *
 * `aria-pressed` rather than two labels: the press toggles, so the state is the pressed-ness and
 * the name stays the card's — a wall of forty transforming cards is forty different buttons only
 * if each one says which card it turns.
 */
export function FlipFaceButton({ cardId, name }: { cardId: string; name: string }) {
  const face = useShownFace(cardId);
  const tip = useTooltip();
  return (
    <button
      type="button"
      data-no-drag=""
      aria-label={`Flip ${name}`}
      aria-pressed={face === 1}
      // The modal's own words for the same verb (`CardModalArt`), and `describes: false` because
      // the accessible name already says it — the tooltip is for the eye that sees only a glyph.
      {...tip("Flip card", { describes: false })}
      onClick={() => toggleShownFace(cardId)}
      className={cn(
        "grid shrink-0 place-items-center border border-border",
        QUANTITY_STEPPER_CARD_BOX,
        BUTTON_OVER_ART,
        PRESS,
        FOCUS_INSET,
      )}
    >
      <FlipHorizontal2 className={QUANTITY_STEPPER_CARD_ICON} aria-hidden="true" />
    </button>
  );
}
