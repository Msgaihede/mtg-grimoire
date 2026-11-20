/**
 * A few lines of made-up cards in the chosen format — what a file of this format looks like, on
 * screen before the reader opens their own decklist (issue #1701).
 *
 * **Written by `formatExport`, never spelled here.** The example is the real writer run over a
 * fixed pile with the reader's own format and field choice, so it follows every checkbox and can
 * never drift from what Copy and Save as… write: `4x Example Card (set) 123 [Example category]
 * *F* ^Buy,#0066ff^` is what Archidekt's writer says about that card, not a picture of it.
 *
 * **Made-up cards rather than the first lines of the reader's own file**, for two reasons. An
 * example has to show what the format *can* say — a finish marker, a pile, a label, a section
 * heading — and the reader's first three cards may say none of it (a collection with no foils
 * shows no `*F*`). And names that are plainly placeholders cannot be mistaken for a line of the
 * reader's own export, which a real `Lightning Bolt` above the real decklist could be.
 *
 * **One pile per surface, and each carries only the facts that surface holds** — `fromDeckCard`,
 * `fromCollectionRow`, `fromWishRow` and `fromTradeLine`'s own split. A wishlist's example has
 * no set name for the reason a wishlist export has none, so a CSV column the surface can never
 * fill is blank in the example exactly as it is in the file. The record is total over
 * `TransferSurface`, so a fifth surface cannot arrive without an example of its own.
 *
 * **Every card is in a switched-on pile and has a name of its own**, so neither row filter, nor
 * `omittedCount`, nor the fold can take a line out of the example: it is about the shape of a
 * line, and which of the reader's cards reach the file is the count lines' job.
 */
import type { TransferFieldId, TransferSurface } from "../fields";
import type { ExportFormat } from "../formats";
import { NOTHING, type TransferCard } from "../TransferCard";
import { formatExport } from "./format";

/** The printing facts every surface holds, and `setName`, which every surface but the wishlist
 *  does — the wishlist's pile takes it back off. */
const EXAMPLE_CARD: TransferCard = {
  ...NOTHING,
  name: "Example Card",
  quantity: 4,
  setCode: "set",
  collectorNumber: "123",
  finish: "foil",
  lang: "en",
  setName: "Example Set",
  rarity: "rare",
  typeLine: "Instant",
  unitPrice: 2.5,
};

const ANOTHER_CARD: TransferCard = {
  ...NOTHING,
  name: "Another Card",
  quantity: 1,
  setCode: "set",
  collectorNumber: "45",
  finish: null,
  lang: "en",
  setName: "Example Set",
  rarity: "common",
  typeLine: "Sorcery",
  unitPrice: 0.25,
};

const ONE_MORE_CARD: TransferCard = {
  ...NOTHING,
  name: "One More Card",
  quantity: 2,
  setCode: "set",
  collectorNumber: "7",
  finish: "etched",
  lang: "en",
  setName: "Example Set",
  rarity: "uncommon",
  typeLine: "Artifact",
  unitPrice: 1,
};

/**
 * A deck's three: a commander and two cards in one pile, which is the smallest deck that shows
 * every format's structure — Arena's and Moxfield's section headings, MTGO's `SB:` (issue #1180),
 * Archidekt's pile headings, and a pile holding more than one card.
 */
const DECK: readonly TransferCard[] = [
  {
    ...NOTHING,
    name: "Example Commander",
    quantity: 1,
    setCode: "set",
    collectorNumber: "1",
    lang: "en",
    categoryName: "Commander",
    categoryKind: "commander",
    categoryActive: true,
    setName: "Example Set",
    rarity: "mythic",
    typeLine: "Legendary Creature — Example",
    unitPrice: 4.5,
  },
  {
    ...EXAMPLE_CARD,
    categoryName: "Example category",
    categoryKind: "main",
    categoryActive: true,
    labelName: "Buy",
    labelColor: "#0066ff",
  },
  { ...ANOTHER_CARD, categoryName: "Example category", categoryKind: "main", categoryActive: true },
];

/** A collection's three, with a copy's own facts on them — the first filled in throughout, so
 *  every column a collection CSV can carry has something in it. */
const COLLECTION: readonly TransferCard[] = [
  {
    ...EXAMPLE_CARD,
    condition: "NM",
    tradelistQuantity: 1,
    purchasePrice: 2,
    purchaseCurrency: "USD",
    acquiredAt: "2026-01-15",
    acquisitionSource: "Local game store",
    serialNumber: "042/500",
    grading: "PSA 9",
    altered: false,
    signed: true,
    proxy: false,
    misprint: false,
    tags: "example",
    notes: "Example note",
  },
  {
    ...ANOTHER_CARD,
    condition: "LP",
    tradelistQuantity: 0,
    altered: false,
    signed: false,
    proxy: false,
    misprint: false,
  },
  {
    ...ONE_MORE_CARD,
    condition: "NM",
    tradelistQuantity: 0,
    altered: false,
    signed: false,
    proxy: false,
    misprint: false,
  },
];

/** A wish has no set name (`fromWishRow`) and may carry a note. */
const WISHLIST: readonly TransferCard[] = [
  { ...EXAMPLE_CARD, setName: null, notes: "Example note" },
  { ...ANOTHER_CARD, setName: null },
  { ...ONE_MORE_CARD, setName: null },
];

/** A trade line is a printing, a finish and a count (`fromTradeLine`). */
const TRADE: readonly TransferCard[] = [EXAMPLE_CARD, ANOTHER_CARD, ONE_MORE_CARD];

export const EXAMPLE_CARDS: Record<TransferSurface, readonly TransferCard[]> = {
  deck: DECK,
  collection: COLLECTION,
  wishlist: WISHLIST,
  trade: TRADE,
};

/** The example as text — `formatExport` over this surface's made-up pile, with the reader's own
 *  format and fields. Ends in the writer's trailing newline, like every export. */
export function exampleText(
  surface: TransferSurface,
  format: ExportFormat,
  fields: readonly TransferFieldId[],
): string {
  return formatExport(EXAMPLE_CARDS[surface], format, fields);
}
