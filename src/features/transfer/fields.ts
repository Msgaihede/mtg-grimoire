/**
 * What a file can say about a card, and who can say it.
 *
 * **Two independent declarations, and the dialog draws their intersection.** A *format* says
 * what channels it has — Arena's line has nowhere to put a finish, so Arena does not offer one.
 * A *surface* says what facts it holds — a wishlist has no piles, so no wishlist export offers a
 * category. Neither declaration knows about the other, which is what stops this becoming a
 * per-surface list of things to remember to hide.
 */
import type { ExportFormat } from "./formats";
import type { TransferCard } from "./TransferCard";

/**
 * Every field, **in the order a CSV writes its columns**. The first six are today's deck CSV
 * header, spelled in today's order, which is what makes `defaultFields("csv", "deck")` a
 * byte-for-byte reproduction of what shipped.
 */
export const TRANSFER_FIELD_IDS = [
  "quantity",
  "name",
  "setCode",
  "collectorNumber",
  "category",
  "finish",
  // After the first six on purpose: those are today's deck CSV header, spelled in today's order,
  // and inserting into them would change every existing CSV's column order for a field that is
  // switched off by default there.
  "label",
  "labelColor",
  "condition",
  "lang",
  "tradelistQuantity",
  "purchasePrice",
  "purchaseCurrency",
  "acquiredAt",
  "acquisitionSource",
  "serialNumber",
  "grading",
  "altered",
  "signed",
  "proxy",
  "misprint",
  "tags",
  "notes",
  "setName",
  "rarity",
  "typeLine",
  "unitPrice",
] as const;
export type TransferFieldId = (typeof TRANSFER_FIELD_IDS)[number];

export interface TransferField {
  /** The checkbox's word. */
  label: string;
  /** The CSV column name — and what the CSV *reader* matches an incoming header against. */
  csvHeader: string;
  /** `""` when this card has nothing to say, which is what an empty cell means. */
  read(card: TransferCard): string;
}

const flag = (v: boolean | null): string => (v === true ? "yes" : v === false ? "no" : "");
const num = (v: number | null): string => (v === null ? "" : String(v));

export const TRANSFER_FIELDS: Record<TransferFieldId, TransferField> = {
  quantity: { label: "Quantity", csvHeader: "Quantity", read: (c) => String(c.quantity) },
  name: { label: "Name", csvHeader: "Name", read: (c) => c.name },
  setCode: { label: "Set code", csvHeader: "Set", read: (c) => c.setCode ?? "" },
  collectorNumber: {
    label: "Collector number",
    csvHeader: "Collector number",
    read: (c) => c.collectorNumber ?? "",
  },
  category: { label: "Category", csvHeader: "Category", read: (c) => c.categoryName ?? "" },
  /**
   * The deck label — `deck_labels` by name.
   *
   * **It said `Tag` until the rename, one letter off the collection's `Tags` further down, and
   * the collision is resolved now rather than merely survived.** The two were always different
   * facts — a `deck_labels` row against `collection_entries.tags`, free text — and no surface
   * holds both: `SURFACE_FIELDS` gives this one to the deck and that one to the collection, so
   * the two boxes could never be drawn together and the two headers could never be in one file.
   * The near-collision could therefore not produce a wrong import; it only ever cost the
   * reading, and it cost that every time. Only this one moved, because only this one was ever a
   * label.
   *
   * **What it costs is a deck CSV an older build wrote, whose column says `Tag`.** That word
   * survives as a read-only alias in `import/parse.ts` so those files still bring their labels
   * back, and the collection's `Tags` is untouched — `normalizeHeader` keeps the two words
   * apart, so the alias cannot shadow it. Nothing writes `Tag` any more.
   */
  label: { label: "Label", csvHeader: "Label", read: (c) => c.labelName ?? "" },
  /**
   * That label's colour, and **a field only because a CSV cell holds one value.**
   *
   * Archidekt writes the pair as `^Keeper,#4aab08^`, so its writer reads `labelColor` off the
   * card whenever `label` is on and offers no box of its own — a checkbox there would be a
   * control that changes nothing. A CSV has to spend a column, so it gets one, off by default:
   * the colour repeats down every row wearing that label, and it only decides anything on the
   * way back in for a label the importing database has never seen. Ticking it is what makes a
   * CSV round trip lossless into a fresh install.
   */
  labelColor: {
    label: "Label colour",
    csvHeader: "Label colour",
    read: (c) => c.labelColor ?? "",
  },
  // The word rather than the letter: a column somebody opens in a spreadsheet should say `foil`.
  finish: { label: "Finish", csvHeader: "Finish", read: (c) => c.finish ?? "" },
  condition: { label: "Condition", csvHeader: "Condition", read: (c) => c.condition ?? "" },
  lang: { label: "Language", csvHeader: "Language", read: (c) => c.lang ?? "" },
  tradelistQuantity: {
    label: "Tradelist quantity",
    csvHeader: "Tradelist quantity",
    read: (c) => num(c.tradelistQuantity),
  },
  purchasePrice: {
    label: "Purchase price",
    csvHeader: "Purchase price",
    read: (c) => num(c.purchasePrice),
  },
  purchaseCurrency: {
    label: "Purchase currency",
    csvHeader: "Purchase currency",
    read: (c) => c.purchaseCurrency ?? "",
  },
  acquiredAt: { label: "Acquired", csvHeader: "Acquired", read: (c) => c.acquiredAt ?? "" },
  acquisitionSource: {
    label: "Acquired from",
    csvHeader: "Acquired from",
    read: (c) => c.acquisitionSource ?? "",
  },
  serialNumber: {
    label: "Serial number",
    csvHeader: "Serial number",
    read: (c) => c.serialNumber ?? "",
  },
  grading: { label: "Grading", csvHeader: "Grading", read: (c) => c.grading ?? "" },
  altered: { label: "Altered", csvHeader: "Altered", read: (c) => flag(c.altered) },
  signed: { label: "Signed", csvHeader: "Signed", read: (c) => flag(c.signed) },
  proxy: { label: "Proxy", csvHeader: "Proxy", read: (c) => flag(c.proxy) },
  misprint: { label: "Misprint", csvHeader: "Misprint", read: (c) => flag(c.misprint) },
  // The collection's own free text, and **not the deck's label** — see `label` above, which
  // used to be one letter away from this one and is `Label` now.
  tags: { label: "Tags", csvHeader: "Tags", read: (c) => c.tags ?? "" },
  notes: { label: "Notes", csvHeader: "Notes", read: (c) => c.notes ?? "" },
  setName: { label: "Set name", csvHeader: "Set name", read: (c) => c.setName ?? "" },
  rarity: { label: "Rarity", csvHeader: "Rarity", read: (c) => c.rarity ?? "" },
  typeLine: { label: "Type line", csvHeader: "Type line", read: (c) => c.typeLine ?? "" },
  unitPrice: { label: "Price", csvHeader: "Price", read: (c) => num(c.unitPrice) },
};

/** What no format may omit. A line with no count and no name is not a card. */
export const ALWAYS: readonly TransferFieldId[] = ["quantity", "name"];

interface FormatFields {
  /** What the reader may toggle. `always` is implicit and never listed here. */
  optional: readonly TransferFieldId[];
  /** What is on when the dialog opens — chosen to reproduce today's output byte for byte. */
  defaultOn: readonly TransferFieldId[];
}

const PRINTING: readonly TransferFieldId[] = ["setCode", "collectorNumber"];

export const FORMAT_FIELDS: Record<ExportFormat, FormatFields> = {
  plain: { optional: ["finish"], defaultOn: ["finish"] },
  // MTGO's `SB:` is structure, not a field, and the format says nothing else about a card.
  mtgo: { optional: [], defaultOn: [] },
  arena: { optional: PRINTING, defaultOn: PRINTING },
  moxfield: { optional: [...PRINTING, "finish"], defaultOn: [...PRINTING, "finish"] },
  // **`label` and not `labelColor`**: the colour rides inside `^Keeper,#4aab08^`, so it is part
  // of what `label` writes here rather than a channel of its own. On by default like this
  // format's other four — Archidekt's defaults are everything Archidekt can say, and the caret
  // group is something Archidekt itself emits.
  archidekt: {
    optional: [...PRINTING, "finish", "category", "label"],
    defaultOn: [...PRINTING, "finish", "category", "label"],
  },
  tcgplayer: { optional: PRINTING, defaultOn: PRINTING },
  // Everything, and the surface is what narrows it. `condition` is in the defaults so a
  // collection CSV separates a NM copy from an LP one without the reader having to know that
  // is what makes them two rows; on a deck it is not available and drops out.
  csv: {
    optional: TRANSFER_FIELD_IDS,
    defaultOn: [...PRINTING, "category", "finish", "condition"],
  },
};

export type TransferSurface = "deck" | "collection" | "wishlist";

export const SURFACE_FIELDS: Record<TransferSurface, readonly TransferFieldId[]> = {
  deck: [
    "quantity", "name", "setCode", "collectorNumber", "category", "finish", "label", "labelColor",
    "lang", "setName", "rarity", "typeLine", "unitPrice",
  ],
  collection: [
    "quantity", "name", "setCode", "collectorNumber", "finish", "condition", "lang",
    "tradelistQuantity", "purchasePrice", "purchaseCurrency", "acquiredAt",
    "acquisitionSource", "serialNumber", "grading", "altered", "signed", "proxy",
    "misprint", "tags", "notes", "setName", "rarity", "typeLine", "unitPrice",
  ],
  // No `setName`: a `WishRow` carries a set code and nothing about the set.
  wishlist: [
    "quantity", "name", "setCode", "collectorNumber", "finish", "lang", "notes",
    "rarity", "typeLine", "unitPrice",
  ],
};

/** The intersection, in registry order — which is what makes a CSV's columns stable. */
export function availableFields(
  format: ExportFormat,
  surface: TransferSurface,
): TransferFieldId[] {
  const offered = new Set<TransferFieldId>([...ALWAYS, ...FORMAT_FIELDS[format].optional]);
  const held = new Set<TransferFieldId>(SURFACE_FIELDS[surface]);
  return TRANSFER_FIELD_IDS.filter((id) => offered.has(id) && held.has(id));
}

/** What is on when the dialog opens: the format's defaults, narrowed to what the surface has. */
export function defaultFields(
  format: ExportFormat,
  surface: TransferSurface,
): TransferFieldId[] {
  const on = new Set<TransferFieldId>([...ALWAYS, ...FORMAT_FIELDS[format].defaultOn]);
  return availableFields(format, surface).filter((id) => on.has(id));
}
