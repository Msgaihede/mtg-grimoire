import { Ellipsis } from "lucide-react";
import { CardTile } from "@/components/CardTile";
import { CountTag } from "@/components/CountTag";
import { BUTTON_OVER_ART } from "@/components/QuantityStepper";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { WallItem } from "./CardWall";

/**
 * One tile on a phone wall: the card, its chin, and its count laid on the art above one.
 *
 * **A tile with no card is not a control.** `onOpen` is passed to `CardTile` only where
 * `item.cardId` names a card: a wish whose card the corpus no longer has has neither a printing
 * of its own nor one to be drawn as, so there is no id a sheet could ask about — and a button that
 * does nothing is a stop a screen reader lands on and a press that answers nobody. Without
 * `onPress`, `CardTile` draws the art in a plain box, and the no-art frame says the name.
 *
 * **`onActions` draws the tile's `⋯`** — the way to act on the tile without leaving the page,
 * step 3.5b's answer and 3.5a's choice for a deck row read across to a wall: a visible 44px
 * control rather than a long-press, which nothing announces, a slow scroll can fire, and neither
 * a keyboard nor a screen reader can make. It is a **sibling** of the art's button, never inside
 * it (`CardTile`'s own rule for a control in a corner), so a press on the picture still opens the
 * card. **Top-left**, because top-right is the finish chip's on every card face in this app and
 * bottom-left is the count's; the target is the corner's 44px square and the drawn chip the
 * stepper-over-art's backed circle inside it, so it reads over art of any brightness. Its name
 * says which tile it is about, because one card can be two tiles.
 *
 * Both walls draw it — `CardWall`'s flat rows and `ShelfWall`'s shelves — so a tile is one
 * composition wherever a list of cards is drawn on the phone.
 */
export function WallTile({
  item,
  onOpen,
  onActions,
  className,
}: {
  item: WallItem;
  onOpen: (item: WallItem) => void;
  /** The tile's actions, opened from its `⋯` — absent draws no `⋯` at all. */
  onActions?: () => void;
  className?: string;
}) {
  const copies = item.count > 1 ? `${item.count} copies` : null;
  const tile = (
    <CardTile
      className={onActions === undefined ? className : "min-w-0 flex-1"}
      cardId={item.cardId}
      name={item.name}
      rarity={item.rarity}
      chin={item.chin}
      finish={item.finish}
      money={item.money}
      pressLabel={copies === null ? item.pressLabel : `${item.pressLabel}, ${copies}`}
      onPress={item.cardId === null ? undefined : () => onOpen(item)}
      overlay={
        copies === null ? undefined : (
          // The tag as it is, placed by its own `className`: it is a filled, slanted banner already,
          // and a backed chip around it is the square box on art that reads as something to press.
          <CountTag count={item.count} title={copies} className="absolute bottom-1 left-1" />
        )
      }
    />
  );
  if (onActions === undefined) return tile;
  return (
    <div className={cn("relative flex", className)}>
      {tile}
      <button
        type="button"
        aria-label={`Edit ${item.pressLabel}`}
        aria-haspopup="dialog"
        onClick={onActions}
        className={cn(
          "absolute top-0 left-0 flex size-11 items-start justify-start rounded-lg p-1",
          FOCUS,
        )}
      >
        <span
          aria-hidden
          className={cn(
            "flex size-8 items-center justify-center rounded-full shadow-sm",
            BUTTON_OVER_ART,
            PRESS,
          )}
        >
          <Ellipsis className="size-4" />
        </span>
      </button>
    </div>
  );
}
