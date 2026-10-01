import { FINISH_LABEL, isFinish, playedFinish, soleFinish, type Finish } from "@/lib/finish";
import type { CardSummary, CollectionRow, DeckCard, WishRow } from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import type { WallItem } from "./CardWall";

/**
 * Each of the phone face's lists, turned into what the wall draws.
 *
 * Four DTOs and one tile. The rows are the desktop's own — the same commands answer both faces —
 * so everything a list knows about a card arrives here and what the wall needs is picked out once.
 *
 * **Which finish a tile is marked with is the desktop's rule for that list, not one rule for all
 * four**, because the four rows answer different questions: a search result is a *printing*
 * (`soleFinish` — marked only where the printing leaves no choice), a deck row is what the deck
 * *plays* (`playedFinish` — the deck's own statement, then the printing's), and a collection row
 * and a wish each carry a finish of their own.
 */

/** A printing, said the way the chin writes it. */
const printingWords = (setCode: string, collectorNumber: string): string =>
  `${setCode.toUpperCase()} ${collectorNumber}`;

/**
 * A stored finish, as a mark. `nonfoil` goes unmarked — the app's rule on every wall — and so
 * does a word this app has never heard of: the two columns this reads are TEXT.
 */
function marked(finish: string | null): Finish | null {
  return finish !== null && isFinish(finish) && finish !== "nonfoil" ? finish : null;
}

/**
 * The tile's accessible name: the card, its printing, and the finish it is marked with.
 *
 * The finish is in it because the mark is a glyph in the chin and the name is all the tile's
 * button says — without it a foil copy and a regular copy of one printing are two controls with
 * one name. **The count is not**: the wall appends `, N copies` itself (`WallItem.pressLabel`).
 */
function labelOf(name: string, printing: string, finish: Finish | null): string {
  return finish === null
    ? `${name}, ${printing}`
    : `${name}, ${printing}, ${FINISH_LABEL[finish]}`;
}

export function searchItem(card: CardSummary, currency: Currency): WallItem {
  // What the *object* is: a foil-only printing is foil, and one sold both ways says nothing.
  const finish = soleFinish(card.finishes);
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
    finish,
    money: formatPrice(card.price, currency),
    count: card.ownedQuantity,
    pressLabel: labelOf(card.name, printingWords(card.setCode, card.collectorNumber), finish),
  };
}

export function collectionItem(row: CollectionRow, currency: Currency): WallItem {
  const name = row.name ?? "Unknown card";
  // The finish this copy *is* — the row's own column, not a fact about its printing.
  const finish = marked(row.finish);
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
    finish,
    money: formatPrice(row.unitPrice, currency),
    count: row.quantity,
    pressLabel: labelOf(name, printingWords(row.setCode, row.collectorNumber), finish),
  };
}

export function wishItem(row: WishRow, currency: Currency): WallItem {
  // A wish names a printing only when it has both halves; a wish for *any* printing has neither,
  // and is drawn as one particular printing whose set it must not claim.
  const pinned = row.setCode !== null && row.collectorNumber !== null;
  // The finish the wish asks for.
  const finish = marked(row.preferredFinish);
  return {
    key: String(row.id),
    cardId: row.cardId ?? row.artCardId,
    name: row.name,
    rarity: row.rarity,
    chin: pinned
      ? { setCode: row.setCode as string, collectorNumber: row.collectorNumber as string }
      : { printing: "Any printing", printingTitle: null },
    finish,
    money: formatPrice(row.unitPrice, currency),
    count: row.quantity,
    pressLabel: labelOf(
      row.name,
      pinned
        ? printingWords(row.setCode as string, row.collectorNumber as string)
        : "any printing",
      finish,
    ),
  };
}

export function deckCardItem(card: DeckCard, currency: Currency): WallItem {
  // The deck's own statement first, the printing's second. A `null` on the row is the deck not
  // having said — which a foil-only printing answers for it, since that copy is foil whatever
  // the row says.
  const finish = playedFinish(card.finish, card.finishes);
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
    finish,
    money: formatPrice(card.unitPrice, currency),
    count: card.quantity,
    pressLabel: labelOf(card.name, printingWords(card.setCode, card.collectorNumber), finish),
  };
}
