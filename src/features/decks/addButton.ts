import { BUTTON_OVER_ART } from "@/components/QuantityStepper";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The `+` on a tile in the deck editor's search column — **both tabs**, the card search and the
 * collection, which draw the same control and were two copies of one class list until issue #645.
 *
 * **Backed, because it stands over the art.** `CardGrid` draws a tile's `action` in a strip across
 * the foot of the picture, and a bare 1px outline over art of any brightness is the control
 * `BUTTON_OVER_ART` was written to stop drawing: the reader could barely find it. So it takes the
 * felt backing and full-strength glyph the deck's own card steppers carry, and {@link PRESS} with
 * them — the `+` beside a search result and the `+` on the card it lands on are one kind of button.
 *
 * What it keeps of its own is the accent on hover, which says *add* rather than *step*, and its
 * 24px box: the search tile is narrower than a deck card face and the strip it sits in is sized
 * for it. The collection tab adds its refused state over this — `aria-disabled` rather than
 * `disabled`, so the press is stilled there and not here.
 */
export const ADD_BUTTON = cn(
  "grid size-6 shrink-0 place-items-center rounded-md border border-border",
  BUTTON_OVER_ART,
  PRESS,
  FOCUS,
);
