import { useId, type JSX } from "react";
import { CardTile } from "@/components/CardTile";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import { scaled } from "@/lib/cardZoom";
import type { BoosterCard } from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import type { OpenedCard } from "../booster/open";
import type { PriceOf } from "../booster/value";
import { sortOpened, type CardSort } from "./opening";

const SORTS: { value: CardSort; label: string }[] = [
  { value: "price", label: "Price, high to low" },
  { value: "rarity", label: "Rarity" },
  { value: "number", label: "Collector number" },
];

/** A tile's least width at 100%, px — the 9.5rem the wall drew before it had a zoom. */
const TILE_WIDTH = 152;

/**
 * The cards one press opened, as a wall of tiles in the order the reader picks — price high to
 * low first, botbox.dev's order, because the question a pack answers is "what did I get".
 *
 * Each tile is the app's own `CardTile` (issue #1462) — the art, with the foil sheen and chip on a
 * foil, and the `CardChin` every other wall draws under it: rarity, `SET · number`, the finish and
 * the price at the reader's marketplaces (an em dash when there is none). **A card this corpus
 * does not hold** (`inCorpus: false` — MTGJSON knows it, the local card data does not yet) is the
 * same tile with no picture and no press: there is no image to ask for and no card to open, but
 * its printing is still MTGJSON's fact to state. Every other tile's art is a button that opens the
 * card's modal, as a tile anywhere else in the app does.
 *
 * **A card under the page's minimum has its price in red** (issue #1502): it is not counted at that
 * price in any figure beside the wall — taken out, or counted at the bulk price — and the tile is
 * where the reader looks to see which cards those are. The price itself stays the market's.
 */
export function OpenedWall({
  cards,
  facts,
  priceOf,
  currency,
  sort,
  onSort,
  minimum,
  underMinimum = "Under the minimum: not counted at this price",
}: {
  cards: readonly OpenedCard[];
  facts: ReadonlyMap<string, BoosterCard>;
  priceOf: PriceOf;
  currency: Currency;
  sort: CardSort;
  onSort: (sort: CardSort) => void;
  /** The page's minimum card value; a priced card strictly under it is drawn red. */
  minimum?: number;
  /** What a red price means, on hover and to a screen reader. */
  underMinimum?: string;
}): JSX.Element {
  const sortId = useId();
  const open = useAppStore((s) => s.setSelectedCardId);
  const zoom = useAppStore((s) => s.cardZoom.packs);
  const rows = sortOpened(cards, sort, priceOf, facts);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <span id={`${sortId}-label`} className="text-sm text-dim">
          Sort
        </span>
        <Dropdown
          id={sortId}
          labelledBy={`${sortId}-label`}
          size="sm"
          value={sort}
          onChange={(v) => onSort(v as CardSort)}
          options={SORTS}
        />
      </div>
      <ul
        aria-label="Opened cards"
        className="m-0 grid list-none gap-3 p-0"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(${scaled(TILE_WIDTH, zoom)}px, 1fr))`,
        }}
      >
        {rows.map(({ card, index, price }) => {
          const fact = facts.get(card.cardId);
          const name = fact?.name ?? "Unknown card";
          const inCorpus = fact?.inCorpus ?? false;
          return (
            <li
              key={`${index}-${card.cardId}`}
              className="min-w-0"
              title={inCorpus ? undefined : "Not in this app's card data yet"}
            >
              <CardTile
                // `null` for a card this corpus lacks: no picture to ask for, so the frame draws
                // its named no-art state and fetches nothing.
                cardId={inCorpus ? card.cardId : null}
                name={name}
                finish={card.foil ? "foil" : null}
                rarity={fact?.rarity ?? null}
                chin={
                  fact !== undefined
                    ? { setCode: fact.setCode, collectorNumber: fact.collectorNumber }
                    : { printing: "—", printingTitle: null }
                }
                money={
                  minimum !== undefined && price !== null && price < minimum ? (
                    <span className="text-destructive" title={underMinimum}>
                      {formatPrice(price, currency)}
                      <span className="sr-only">, {underMinimum.toLowerCase()}</span>
                    </span>
                  ) : (
                    formatPrice(price, currency)
                  )
                }
                zoom={zoom}
                onPress={inCorpus ? () => open(card.cardId) : undefined}
                hoverZoom
                loading="lazy"
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
