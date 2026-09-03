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
  /**
   * The collection's free-text `collection_entries.tags` — **not a deck label.**
   *
   * The two mean different things, which is worth saying here rather than leaving to whoever
   * reads the CSV header: this one is a string the reader typed on a copy they own, and
   * {@link TransferCard.labelName} is a row of `deck_labels`. No surface has both —
   * `SURFACE_FIELDS` gives this to the collection and the label to the deck — so the two
   * checkboxes can never be drawn together and the two columns can never appear in one file.
   * That was already true while the deck's column said `Tag` and this one said `Tags`; the
   * rename is what makes it legible from the header row alone.
   */
  tags: string | null;
  notes: string | null;
  setName: string | null;
  rarity: string | null;
  typeLine: string | null;
  unitPrice: number | null;
  /**
   * The deck label this card wears — one row of `deck_labels`, by name. `null` on a surface with
   * no labels and on a deck card wearing none.
   *
   * **A name, because that is what a file can carry and what an import finds a row by.** The id
   * would be meaningless in somebody else's database, and `commit_import` matches on
   * `schema::label_name_key` anyway.
   */
  labelName: string | null;
  /**
   * That label's colour, `#rrggbb`.
   *
   * **A separate field from {@link TransferCard.labelName} because only some formats can carry
   * it separately.** Archidekt's `^Keeper,#4aab08^` holds both in one group, so its writer reads
   * this whether or not the reader ticked anything about a colour; a CSV has one value per cell,
   * so it gets a `Label colour` column of its own that the reader switches on. That asymmetry is
   * `fields.ts`' to declare and is why `FORMAT_FIELDS.archidekt` offers `label` and not
   * `labelColor`.
   */
  labelColor: string | null;
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
  setName: null, rarity: null, typeLine: null, unitPrice: null,
  labelName: null, labelColor: null, legalities: null,
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
    // The one surface that has a label. `deck_get` carries both halves on the row, so this costs
    // no second read.
    labelName: card.labelName,
    labelColor: card.labelColor,
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
