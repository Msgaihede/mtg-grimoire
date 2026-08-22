/**
 * The one card shape both halves of a transfer speak.
 *
 * **`null` means this surface does not have this fact, never "empty".** That distinction is what
 * `availableFields` reads to decide a checkbox does not exist: a deck has no condition, so a
 * deck's rows carry `condition: null` and the Condition box never draws — rather than drawing
 * over a column of blanks.
 */
import type { CategoryKind, CollectionRow, DeckCard, DeckFinish, WishRow } from "@/lib/ipc";

export interface TransferCard {
  name: string;
  quantity: number;
  setCode: string | null;
  collectorNumber: string | null;
  finish: DeckFinish;
  lang: string | null;
  categoryName: string | null;
  categoryKind: CategoryKind | null;
  categoryActive: boolean | null;
  condition: string | null;
  tradelistQuantity: number | null;
  purchasePrice: number | null;
  purchaseCurrency: string | null;
  acquiredAt: string | null;
  acquisitionSource: string | null;
  serialNumber: string | null;
  grading: string | null;
  altered: boolean | null;
  signed: boolean | null;
  proxy: boolean | null;
  misprint: boolean | null;
  tags: string | null;
  notes: string | null;
  setName: string | null;
  rarity: string | null;
  typeLine: string | null;
  unitPrice: number | null;
  /**
   * This printing's `legalities` blob, JSON, verbatim — 23 keys and growing.
   *
   * **Not a field**: it is never written to a file and never draws a checkbox in the field
   * row, which is why it is absent from `fields.ts`. It is the one fact the *Arena filter*
   * reads (`export/arena.ts`), and all three surfaces answer it — `cards.legalities` is a
   * fact about the printing, so a collection row and a wishlist row carry it as readily as a
   * deck card does.
   *
   * `null` is the orphan case every other field here spells that way, and `arena.ts` says what
   * the filter does with one.
   */
  legalities: string | null;
}

/** Every field a surface does not have, in one object to spread. */
const NOTHING = {
  setCode: null, collectorNumber: null, finish: null, lang: null,
  categoryName: null, categoryKind: null, categoryActive: null,
  condition: null, tradelistQuantity: null, purchasePrice: null, purchaseCurrency: null,
  acquiredAt: null, acquisitionSource: null, serialNumber: null, grading: null,
  altered: null, signed: null, proxy: null, misprint: null, tags: null, notes: null,
  setName: null, rarity: null, typeLine: null, unitPrice: null, legalities: null,
} satisfies Omit<TransferCard, "name" | "quantity">;

/**
 * `'nonfoil'` is the collection's spelling of the regular copy; `null` is everyone else's.
 * Two spellings of one finish would fold as two rows in `foldForFields` and write two lines
 * naming the same card.
 */
function finishOf(raw: string | null | undefined): DeckFinish {
  if (raw === "foil") return "foil";
  if (raw === "etched") return "etched";
  return null;
}

export function fromDeckCard(card: DeckCard): TransferCard {
  return {
    ...NOTHING,
    name: card.name,
    quantity: card.quantity,
    setCode: card.setCode,
    collectorNumber: card.collectorNumber,
    finish: card.finish,
    lang: card.lang,
    categoryName: card.categoryName,
    categoryKind: card.categoryKind,
    categoryActive: card.categoryActive,
    setName: card.setName,
    rarity: card.rarity ?? null,
    typeLine: card.typeLine ?? null,
    unitPrice: card.unitPrice ?? null,
    legalities: card.legalities,
  };
}

export function fromCollectionRow(row: CollectionRow): TransferCard {
  return {
    ...NOTHING,
    name: row.name ?? "",
    quantity: row.quantity,
    setCode: row.setCode,
    collectorNumber: row.collectorNumber,
    finish: finishOf(row.finish),
    lang: row.lang,
    condition: row.condition,
    tradelistQuantity: row.tradelistQuantity,
    purchasePrice: row.purchasePrice,
    purchaseCurrency: row.purchaseCurrency,
    acquiredAt: row.acquiredAt,
    acquisitionSource: row.acquisitionSource,
    serialNumber: row.serialNumber,
    grading: row.grading,
    altered: row.altered,
    signed: row.signed,
    proxy: row.proxy,
    misprint: row.misprint,
    tags: row.tags,
    notes: row.notes,
    setName: row.setName,
    rarity: row.rarity,
    typeLine: row.typeLine,
    unitPrice: row.unitPrice,
    legalities: row.legalities,
  };
}

export function fromWishRow(row: WishRow): TransferCard {
  return {
    ...NOTHING,
    name: row.name,
    quantity: row.quantity,
    setCode: row.setCode,
    collectorNumber: row.collectorNumber,
    finish: finishOf(row.preferredFinish),
    lang: row.lang,
    notes: row.notes,
    rarity: row.rarity,
    typeLine: row.typeLine,
    unitPrice: row.unitPrice,
    legalities: row.legalities,
  };
}
