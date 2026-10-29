import { useId, type JSX } from "react";
import { CardArt } from "@/components/CardArt";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import { FinishMark } from "@/components/FinishMark";
import { RarityGem } from "@/components/RarityGem";
import { FOCUS } from "@/lib/focus";
import type { BoosterCard } from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { OpenedCard } from "../booster/open";
import type { PriceOf } from "../booster/value";
import { sortOpened, type CardSort } from "./opening";

const SORTS: { value: CardSort; label: string }[] = [
  { value: "price", label: "Price, high to low" },
  { value: "rarity", label: "Rarity" },
  { value: "number", label: "Collector number" },
];

/**
 * The cards one press opened, as a wall of tiles in the order the reader picks — price high to
 * low first, botbox.dev's order, because the question a pack answers is "what did I get".
 *
 * Each tile is the card (`CardArt`, with the foil sheen and chip on a foil), its price at the
 * reader's marketplace (an em dash when there is none) and its rarity. **A card this corpus does
 * not hold** (`inCorpus: false` — MTGJSON knows it, the local card data does not yet) is a plain
 * name tile: there is no picture to ask for and no card to open. Every other tile is a button
 * that opens the card's modal, as a tile anywhere else in the app does.
 */
export function OpenedWall({
  cards,
  facts,
  priceOf,
  currency,
  sort,
  onSort,
}: {
  cards: readonly OpenedCard[];
  facts: ReadonlyMap<string, BoosterCard>;
  priceOf: PriceOf;
  currency: Currency;
  sort: CardSort;
  onSort: (sort: CardSort) => void;
}): JSX.Element {
  const sortId = useId();
  const open = useAppStore((s) => s.setSelectedCardId);
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
        className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3 p-0"
      >
        {rows.map(({ card, index, price }) => {
          const fact = facts.get(card.cardId);
          const name = fact?.name ?? "Unknown card";
          const inCorpus = fact?.inCorpus ?? false;
          return (
            <li key={`${index}-${card.cardId}`} className="flex min-w-0 flex-col gap-1.5">
              {inCorpus ? (
                <button
                  type="button"
                  onClick={() => open(card.cardId)}
                  aria-label={`${name}${card.foil ? ", foil" : ""}, ${formatPrice(price, currency)}`}
                  className={cn("group block rounded-lg", FOCUS)}
                >
                  <CardArt
                    cardId={card.cardId}
                    name={name}
                    finish={card.foil ? "foil" : null}
                    hoverZoom
                    loading="lazy"
                  />
                </button>
              ) : (
                <NameTile name={name} fact={fact} />
              )}
              <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
                <RarityGem rarity={fact?.rarity ?? null} withLabel className="capitalize" />
                <span className="flex items-center gap-1 font-mono tabular-nums text-text">
                  {card.foil && <FinishMark finish="foil" className="size-3 text-accent" />}
                  {formatPrice(price, currency)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A card with no picture to draw: its name and printing, in the card's own frame. */
function NameTile({ name, fact }: { name: string; fact: BoosterCard | undefined }): JSX.Element {
  return (
    <div
      className="flex aspect-[5/7] w-full flex-col items-center justify-center gap-1 rounded-lg border border-border bg-surface px-2 text-center"
      title="Not in this app's card data yet"
    >
      <span className="line-clamp-3 text-sm">{name}</span>
      {fact?.typeLine && <span className="line-clamp-2 text-xs text-dim">{fact.typeLine}</span>}
      {fact !== undefined && (
        <span className="font-mono text-[0.6875rem] uppercase text-dim">
          {fact.setCode} {fact.collectorNumber}
        </span>
      )}
    </div>
  );
}
