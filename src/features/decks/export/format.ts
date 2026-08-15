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
 * An empty list is an empty string in every format, **CSV included**. A header row over no
 * rows is a file that claims to be a decklist and is not one.
 */
import type { DeckCard } from "@/lib/ipc";

export const EXPORT_FORMATS = ["plain", "mtgo", "moxfield", "csv"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_FORMAT_LABEL: Record<ExportFormat, string> = {
  plain: "Plain text",
  mtgo: "MTGO",
  moxfield: "Moxfield",
  csv: "CSV",
};

export const EXPORT_FORMAT_EXTENSION: Record<ExportFormat, string> = {
  plain: "txt",
  mtgo: "txt",
  moxfield: "txt",
  csv: "csv",
};

/** What a card needs to be exported — a `Pick` of `DeckCard`, so a whole one satisfies it. */
export type ExportCard = Pick<DeckCard, "name" | "quantity" | "setCode" | "collectorNumber">;

/**
 * A CSV field, quoted when it carries a comma, a quote or a newline — and never otherwise, so
 * `Lightning Bolt` stays `Lightning Bolt` rather than becoming `"Lightning Bolt"` on every row.
 * An inner quote doubles, which is the escape RFC 4180 (and every spreadsheet reading this
 * file) agrees on.
 */
function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** `quantity name`, with nothing about the printing — the shape a plain paste and MTGO share. */
function plainLine(card: ExportCard): string {
  return `${card.quantity} ${card.name}`;
}

/**
 * `quantity name (SET) collectorNumber` — Moxfield's shape, and the one format here that names
 * a printing rather than just a card. The set code is uppercased for the same reason the
 * importer uppercases the one it reads: `(ltc)` and `(LTC)` are the same set and a decklist
 * should pick one spelling rather than echo whatever case this row happened to store.
 */
function moxfieldLine(card: ExportCard): string {
  return `${card.quantity} ${card.name} (${card.setCode.toUpperCase()}) ${card.collectorNumber}`;
}

/**
 * One `Record<ExportFormat, …>` rather than a branch per format in four places — a fifth
 * format is one entry here, not four new `if`s scattered across the module.
 *
 * Each writer answers one line with **no** trailing newline; {@link formatExport} joins and
 * terminates, so a writer never has to know whether it is the last line.
 */
const LINE_WRITERS: Record<ExportFormat, (card: ExportCard) => string> = {
  plain: plainLine,
  // MTGO's own export omits the printing entirely — it resolves a name against whatever
  // copies a player owns rather than pinning one, so naming a set here would be a promise
  // this format was never in a position to keep.
  mtgo: plainLine,
  moxfield: moxfieldLine,
  csv: (card) =>
    [
      String(card.quantity),
      csvField(card.name),
      csvField(card.setCode),
      csvField(card.collectorNumber),
    ].join(","),
};

const CSV_HEADER = "Quantity,Name,Set,Collector number";

/**
 * Render a pile of cards as decklist text in one of {@link EXPORT_FORMATS}.
 *
 * An empty list is `""` in every format, CSV's header included — a header with nothing under
 * it is a file that claims to be a decklist and is not one. Every non-empty result ends in a
 * single trailing `\n`.
 */
export function formatExport(cards: readonly ExportCard[], format: ExportFormat): string {
  if (cards.length === 0) return "";

  const write = LINE_WRITERS[format];
  const rows = cards.map(write);
  if (format === "csv") rows.unshift(CSV_HEADER);

  return rows.join("\n") + "\n";
}
