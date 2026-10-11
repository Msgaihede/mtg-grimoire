import { FINISH_LABEL, isFinish, playedFinish, soleFinish, type Finish } from "@grimoire/ui/lib/finish";
import type { CollectionTile } from "@grimoire/ui/features/collection/collectionWall";
import type { CardSummary, DeckCard, WishRow } from "@grimoire/ui/lib/ipc";
import type { Currency } from "@grimoire/ui/lib/marketplace";
import { formatPrice } from "@grimoire/ui/lib/prices";
import type { WallItem } from "./CardWall";
import { wishPrinting } from "./WishPrinting";

/**
 * Each of the phone face's lists, turned into what the wall draws.
 *
 * Three DTOs, the collection's tile, and one wall item. The rows are the desktop's own — the same commands answer both faces —
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

/**
 * A collection **tile** — `collectionWall.ts`'s fold of the rows, the desktop wall's own: one
 * printing in one finish in one folder, whatever grades and languages its copies are in. So two
 * rows of one etched printing are one tile counting both, and one name a screen reader can tell
 * from every other; the wall says the copies.
 */
export function collectionItem(tile: CollectionTile, currency: Currency): WallItem {
  // The finish this copy *is* — the row's own column, not a fact about its printing.
  const finish = marked(tile.finish);
  return {
    key: tile.key,
    cardId: tile.id,
    name: tile.name,
    rarity: tile.rarity,
    chin: {
      setCode: tile.setCode,
      collectorNumber: tile.collectorNumber,
      printingTitle: tile.setName,
    },
    finish,
    money: formatPrice(tile.unitPrice, currency),
    count: tile.copies,
    pressLabel: labelOf(tile.name, printingWords(tile.setCode, tile.collectorNumber), finish),
  };
}

/**
 * A wish: one tile per wish, the desktop wall's grain and the counts' (`ShelfCount.tiles`).
 *
 * **The picture is the printing the wish is drawn as** (`artCardId`): a pinned wish's own, the
 * newest printing for a wish for *any* printing, and nothing at all for a wish whose card the
 * corpus has lost — the one row with no printing to show or to open, which the wall then draws as
 * no control rather than as a press that does nothing.
 */
export function wishItem(row: WishRow, currency: Currency): WallItem {
  // A wish names a printing only when it has both halves; a wish for *any* printing has neither,
  // and is drawn as one particular printing whose set it must not claim.
  const pinned = row.setCode !== null && row.collectorNumber !== null;
  // The finish the wish asks for.
  const finish = marked(row.preferredFinish);
  return {
    key: String(row.id),
    cardId: row.artCardId,
    name: row.name,
    rarity: row.rarity,
    // The desktop wall's caption — the printing, and the `elsewhere` mark beside it. No title:
    // a wish carries no set name, and for a wish for any printing the name of the printing it is
    // drawn as would contradict the words.
    chin: { printing: wishPrinting(row), printingTitle: null },
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
