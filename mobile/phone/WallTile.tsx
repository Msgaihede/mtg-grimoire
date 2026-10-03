import { CardTile } from "@/components/CardTile";
import { CountTag } from "@/components/CountTag";
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
 * Both walls draw it — `CardWall`'s flat rows and `ShelfWall`'s shelves — so a tile is one
 * composition wherever a list of cards is drawn on the phone.
 */
export function WallTile({
  item,
  onOpen,
  className,
}: {
  item: WallItem;
  onOpen: (item: WallItem) => void;
  className?: string;
}) {
  const copies = item.count > 1 ? `${item.count} copies` : null;
  return (
    <CardTile
      className={className}
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
}
