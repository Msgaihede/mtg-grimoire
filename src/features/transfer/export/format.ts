/**
 * A pile of cards as text.
 *
 * The mirror of `../import/parse.ts`, and bound by that file's rules read backwards: **`//` is
 * part of a card name** (`Branchloft Pathway // Boulderloft Pathway` is one card, and seven
 * such names are in the importer's own reference list), so nothing here may cut one; and what
 * this writes has to be something that parser reads, which is what the round-trip test pins.
 *
 * LF and a trailing newline, always. The parser takes CRLF, a lone LF and a lone CR, so it
 * would read any of them — but a file this app wrote should have one answer, and `\n` is the
 * one every other tool in this space emits.
 *
 * **A format is a whole file rather than a row of lines, and a line is composed from a *chosen
 * field set* rather than a fixed template.** `writeLine` and its `LineSpec` are what is left of
 * the old per-format writers: three of the formats write *headings* as well as lines, and two of
 * those decide which headings exist by grouping the input — that part is still `formatExport`'s
 * one switch, which is also the only place that knows a format writes sections at all.
 *
 * An empty list is an empty string in every format, **CSV included**. A header row over no
 * rows is a file that claims to be a decklist and is not one. **That now covers a list a
 * format empties for itself**: Arena and MTGO write only switched-on piles, so a deck that is
 * entirely maybeboard is an empty file in those two rather than a heading over nothing —
 * {@link omittedCount} is what says so out loud.
 */
import type { CategoryKind } from "@/lib/ipc";
import { csvRow } from "../csv";
import { TRANSFER_FIELDS, TRANSFER_FIELD_IDS, type TransferFieldId } from "../fields";
import type { ExportFormat } from "../formats";
import type { TransferCard } from "../TransferCard";
import { foldForFields } from "./fold";

export {
  EXPORT_FORMATS,
  EXPORT_FORMAT_LABEL,
  EXPORT_FORMAT_EXTENSION,
  type ExportFormat,
} from "../formats";

/** The maybeboard's heading, spelled once — it is `SECTION_CATEGORY.maybeboard`'s word read
 *  backwards, and the importer's `SECTIONS` map is what reads it. */
const MAYBEBOARD = "Maybeboard";

/**
 * What a kind is called in a format whose section vocabulary is fixed.
 *
 * **Total over {@link CategoryKind}, with no arm for `maybe` in the sense the word suggests** —
 * nothing anywhere may branch on a kind being `maybe`, and this does not: a pile whose kind is
 * `maybe` but which the reader has switched **on** counts toward the deck like any other, so it
 * writes under `Deck`. {@link sectionOf} is where a switched-*off* pile becomes a maybeboard, and
 * it asks `categoryActive` rather than the kind, which is the whole of what `is_active = 0`
 * means. Rewriting this entry to `Maybeboard` "because that is what it is called" is the bug
 * that rule exists to keep out — it would file a switched-on Maybeboard out of the deck it
 * counts toward, and leave a reader's own switched-off `Ramp` under `Deck` beside it.
 */
const KIND_SECTION: Record<CategoryKind, string> = {
  commander: "Commander",
  companion: "Companion",
  main: "Deck",
  side: "Sideboard",
  maybe: "Deck",
};

/**
 * The order sections come out in.
 *
 * **Deliberately not `sortOptions` — one of the exceptions `lib/options.ts` names, the kind
 * whose order *is* the information.** It is the order a decklist is read in, from the zone the
 * game starts with down to the cards that are not in the deck at all; alphabetically it would
 * open on `Commander`, then `Companion`, `Deck`, `Maybeboard`, `Sideboard`, which puts the cards
 * that count toward nothing in the middle of the ones that do.
 */
const SECTION_ORDER: readonly string[] = [
  "Commander",
  "Companion",
  "Deck",
  "Sideboard",
  MAYBEBOARD,
];

/** The section a card writes under, or `null` on a surface that has no piles at all. */
function sectionOf(card: TransferCard): string | null {
  if (card.categoryKind === null) return null;
  return card.categoryActive === false ? MAYBEBOARD : KIND_SECTION[card.categoryKind];
}

/**
 * The formats with no maybeboard, which therefore write **only** the piles that are switched on.
 *
 * One set rather than the same two-name test written at each of its two readers: {@link written}
 * and {@link omittedCount} are the two halves of one rule — what is left out, and how much of it
 * — and a drift between them is a number on screen that quietly stops describing the file.
 *
 * The test is `categoryActive` and never the kind: `is_active = 0` is the whole of what a
 * maybeboard is, and a reader's own switched-off pile behaves the same way.
 */
const ACTIVE_ONLY: ReadonlySet<ExportFormat> = new Set<ExportFormat>(["arena", "mtgo"]);

/**
 * The `*F*` / `*E*` marker a line ends with, or `""` for the regular copy.
 *
 * The one thing every text format here can say about a finish, and the channel `parse.ts` reads
 * back — a leading space included, so a caller appends it and nothing has to remember not to
 * emit a trailing one on a plain row.
 *
 * **Not written by `arena` or `mtgo`**, which have no marker in the format; the finish is lost
 * on a round trip through either, which is the same thing already true of a category there.
 */
function finishMark(card: TransferCard): string {
  if (card.finish === "foil") return " *F*";
  if (card.finish === "etched") return " *E*";
  return "";
}

/** How one format shapes the segments a field set turns on. */
interface LineSpec {
  /** Archidekt's `1x`; everyone else's `1`. */
  quantitySuffix: string;
  setCase: "upper" | "lower";
  setWrap: "parens" | "brackets";
}

const LINE_SPEC: Record<ExportFormat, LineSpec> = {
  plain: { quantitySuffix: "", setCase: "upper", setWrap: "parens" },
  mtgo: { quantitySuffix: "", setCase: "upper", setWrap: "parens" },
  arena: { quantitySuffix: "", setCase: "upper", setWrap: "parens" },
  moxfield: { quantitySuffix: "", setCase: "upper", setWrap: "parens" },
  // Lowercase against every other writer on purpose: it is what Archidekt itself emits, and
  // our own parser uppercases what it reads, so the round trip is unaffected either way.
  archidekt: { quantitySuffix: "x", setCase: "lower", setWrap: "parens" },
  tcgplayer: { quantitySuffix: "", setCase: "upper", setWrap: "brackets" },
  csv: { quantitySuffix: "", setCase: "upper", setWrap: "parens" },
};

/**
 * One line, assembled from the segments the field set turns on.
 *
 * **No per-format gating here, and that is the point.** The set handed in has already been
 * intersected with what this format can carry, so a `setCode` reaching this function is a
 * `setCode` the format has somewhere to put. Six line formats fall out of one composer and a
 * three-field spec.
 */
function writeLine(
  card: TransferCard,
  fields: ReadonlySet<TransferFieldId>,
  spec: LineSpec,
): string {
  const parts = [`${card.quantity}${spec.quantitySuffix}`, card.name];
  if (fields.has("setCode") && card.setCode !== null && card.setCode !== "") {
    const set = spec.setCase === "lower" ? card.setCode.toLowerCase() : card.setCode.toUpperCase();
    parts.push(spec.setWrap === "brackets" ? `[${set}]` : `(${set})`);
  }
  if (fields.has("collectorNumber") && card.collectorNumber !== null) {
    parts.push(card.collectorNumber);
  }
  let line = parts.join(" ");
  if (fields.has("category") && card.categoryName !== null) {
    // `{noDeck}` is what makes an export and a re-import keep a maybeboard — the only format
    // here that can say it.
    line += ` [${card.categoryName}${card.categoryActive === false ? "{noDeck}" : ""}]`;
  }
  if (fields.has("finish")) line += finishMark(card);
  return line;
}

/**
 * The cards a format will not write, in **copies**.
 *
 * Only `arena` and `mtgo` leave anything out, and only a pile the reader has switched off:
 * neither format has a maybeboard, and writing one into an Arena deck produces an illegal import
 * at the other end. The dialog draws this number, so the omission is never silent.
 *
 * Copies rather than rows because that is the sentence the reader is owed — six basic lands on
 * one row are six cards missing from the file, and "1 card" would be a true statement about the
 * array and a false one about the deck. `categoryActive === null` — a surface with no piles at
 * all — omits nothing, the same as a switched-on pile.
 */
export function omittedCount(cards: readonly TransferCard[], format: ExportFormat): number {
  if (!ACTIVE_ONLY.has(format)) return 0;
  return cards.reduce((n, card) => (card.categoryActive === false ? n + card.quantity : n), 0);
}

/** The cards a format writes, in the caller's own order. */
function written(cards: readonly TransferCard[], format: ExportFormat): readonly TransferCard[] {
  if (!ACTIVE_ONLY.has(format)) return cards;
  return cards.filter((card) => card.categoryActive !== false);
}

/**
 * Cards under headings: one group per key, **in first-appearance order**, or one flat list with
 * no heading at all when `keyOf` answers `null` for every card — the shape a surface with no
 * piles writes.
 *
 * First appearance is what keeps this file pure — the caller's array order is the file's order,
 * so a deck's own category order needs no second argument and no `DeckCategory` here.
 */
function sectioned(
  cards: readonly TransferCard[],
  keyOf: (card: TransferCard) => string | null,
  write: (card: TransferCard) => string,
  order?: readonly string[],
): string {
  if (cards.every((card) => keyOf(card) === null)) return cards.map(write).join("\n");
  const groups = new Map<string, TransferCard[]>();
  for (const card of cards) {
    const key = keyOf(card) ?? "";
    const existing = groups.get(key);
    if (existing) existing.push(card);
    else groups.set(key, [card]);
  }
  const entries = [...groups];
  if (order !== undefined) entries.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  return entries.map(([name, rows]) => [name, ...rows.map(write)].join("\n")).join("\n\n");
}

/**
 * Render a pile of cards as decklist text in one of {@link EXPORT_FORMATS}, over the fields the
 * reader chose.
 *
 * An empty list is `""` in every format, CSV's header included — a header with nothing under
 * it is a file that claims to be a decklist and is not one. **A list a format empties for
 * itself answers the same way**: the filter runs first, so an Arena export of a deck that is
 * entirely maybeboard is `""` rather than a `Deck` heading over nothing. Every non-empty result
 * ends in a single trailing `\n`.
 *
 * **Filter first, fold second, and the order is load-bearing.** Folding first can merge a
 * switched-off row into a switched-on one — the folded row inherits the FIRST card's
 * `categoryActive` — so an Arena export would carry copies that `omittedCount` reports as
 * omitted in the same breath. Filtering first means nothing inactive survives to be folded, and
 * the sentence beside the format stays true of the file under it.
 */
export function formatExport(
  cards: readonly TransferCard[],
  format: ExportFormat,
  fields: readonly TransferFieldId[],
): string {
  const set = new Set(fields);
  const rows = foldForFields(written(cards, format), fields);
  if (rows.length === 0) return "";
  const spec = LINE_SPEC[format];
  const line = (card: TransferCard) => writeLine(card, set, spec);

  let text: string;
  switch (format) {
    case "plain":
      text = rows.map(line).join("\n");
      break;
    case "mtgo":
      // MTGO's own export omits the printing entirely — it resolves a name against whatever
      // copies a player owns rather than pinning one, so naming a set here would be a promise
      // this format was never in a position to keep. `SB:` is a one-line override rather than a
      // heading, which is exactly how the importer reads it back.
      text = rows
        .map((card) => {
          const section = sectionOf(card);
          const prefix = section === "Sideboard" || section === "Companion" ? "SB: " : "";
          return prefix + line(card);
        })
        .join("\n");
      break;
    case "arena":
    case "moxfield":
      // Arena's and Moxfield's headings and lines differ only in which fields the reader has
      // switched on — Moxfield's defaults include `finish`, Arena's do not — so one arm now
      // covers both.
      text = sectioned(rows, sectionOf, line, SECTION_ORDER);
      break;
    case "archidekt":
      // Grouped by the pile's own name rather than a section word, and in the caller's order: a
      // deck's array order is its category order, and imposing one here would re-file somebody's
      // deck on the way out.
      text = sectioned(rows, (card) => card.categoryName, line);
      break;
    case "tcgplayer":
      // Flat, and grouped by nothing: Mass Entry reads every line as one item, so a heading here
      // would be read as a card. `written` has left the switched-off piles in — see the writer.
      text = rows.map(line).join("\n");
      break;
    case "csv": {
      const columns = TRANSFER_FIELD_IDS.filter((id) => set.has(id));
      text = [
        csvRow(columns.map((id) => TRANSFER_FIELDS[id].csvHeader)),
        ...rows.map((card) => csvRow(columns.map((id) => TRANSFER_FIELDS[id].read(card)))),
      ].join("\n");
      break;
    }
  }
  return text + "\n";
}
