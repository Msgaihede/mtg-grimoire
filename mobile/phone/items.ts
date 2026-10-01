import { isFinish, type Finish } from "@/lib/finish";
import type { CardSummary, CollectionRow, DeckCard, WishRow } from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import type { WallItem } from "./CardWall";

/**
 * Each of the phone face's lists, turned into what the wall draws.
 *
 * Four DTOs and one tile. The rows are the desktop's own — the same commands answer both faces —
 * so everything a list knows about a card arrives here and what the wall needs is picked out once.
 */

/** A printing, said the way the chin writes it. */
const printingWords = (setCode: string, collectorNumber: string): string =>
  `${setCode.toUpperCase()} ${collectorNumber}`;

/** The finish a copy *is*, as a mark. `nonfoil` goes unmarked — the app's rule on every wall. */
function marked(finish: string | null): Finish | null {
  return finish !== null && isFinish(finish) && finish !== "nonfoil" ? finish : null;
}

export function searchItem(card: CardSummary, currency: Currency): WallItem {
  return {
    key: card.id,
    cardId: card.id,
    name: card.name,
    rarity: card.rarity,
    chin: {
      setCode: card.setCode,
      collectorNumber: card.collectorNumber,
      printingTitle: card.setName,
    },
    finish: null,
    money: formatPrice(card.price, currency),
    count: card.ownedQuantity,
    pressLabel: `${card.name}, ${printingWords(card.setCode, card.collectorNumber)}`,
  };
}

export function collectionItem(row: CollectionRow, currency: Currency): WallItem {
  const name = row.name ?? "Unknown card";
  return {
    key: String(row.id),
    cardId: row.cardId,
    name,
    rarity: row.rarity,
    chin: {
      setCode: row.setCode,
      collectorNumber: row.collectorNumber,
      printingTitle: row.setName,
    },
    finish: marked(row.finish),
    money: formatPrice(row.unitPrice, currency),
    count: row.quantity,
    pressLabel: `${name}, ${printingWords(row.setCode, row.collectorNumber)}`,
  };
}

export function wishItem(row: WishRow, currency: Currency): WallItem {
  // A wish names a printing only when it has both halves; a wish for *any* printing has neither,
  // and is drawn as one particular printing whose set it must not claim.
  const pinned = row.setCode !== null && row.collectorNumber !== null;
  return {
    key: String(row.id),
    cardId: row.cardId ?? row.artCardId,
    name: row.name,
    rarity: row.rarity,
    chin: pinned
      ? { setCode: row.setCode as string, collectorNumber: row.collectorNumber as string }
      : { printing: "Any printing", printingTitle: null },
    finish: marked(row.preferredFinish),
    money: formatPrice(row.unitPrice, currency),
    count: row.quantity,
    pressLabel: pinned
      ? `${row.name}, ${printingWords(row.setCode as string, row.collectorNumber as string)}`
      : `${row.name}, any printing`,
  };
}

export function deckCardItem(card: DeckCard, currency: Currency): WallItem {
  return {
    key: String(card.id),
    cardId: card.cardId,
    name: card.name,
    rarity: card.rarity,
    chin: {
      setCode: card.setCode,
      collectorNumber: card.collectorNumber,
      printingTitle: card.setName,
    },
    // A deck row spells the regular copy `null` already.
    finish: marked(card.finish),
    money: formatPrice(card.unitPrice, currency),
    count: card.quantity,
    pressLabel: `${card.name}, ${printingWords(card.setCode, card.collectorNumber)}`,
  };
}
