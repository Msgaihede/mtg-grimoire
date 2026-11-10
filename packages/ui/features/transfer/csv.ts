/**
 * CSV, RFC 4180, both directions.
 *
 * The writer is `export/format.ts`'s old private `csvField` promoted, unchanged in behaviour: a
 * field is quoted when it carries a comma, a quote or a newline and **never otherwise**, so
 * `Lightning Bolt` stays `Lightning Bolt` rather than becoming `"Lightning Bolt"` on every row.
 *
 * The reader is new, and it is what makes a collection CSV a restore rather than a dump. A
 * character-by-character scanner rather than a split on commas: a quoted field may contain
 * commas *and newlines*, so there is no line-oriented shortcut that is correct. {@link readCsv}
 * is the file-level half over it — the separator, the `sep=` line, the byte-order mark and the
 * formula escape — and it says which physical line each row starts on, because after a note
 * written in two paragraphs "row 7" and "line 7" are two different places.
 */
import { unescapeFormula } from "./formula";

/** A field, quoted only when it has to be. An inner quote doubles — RFC 4180's escape. */
export function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function csvRow(values: readonly string[]): string {
  return values.map(csvField).join(",");
}

/**
 * What separates one cell from the next. **Three, because three are written in the wild**: a
 * comma by every exporter in scope, a semicolon by Excel in any locale whose decimal point is a
 * comma (Denmark, Germany — a spreadsheet cannot spend the comma on both jobs), and a tab by
 * anything that copies a sheet to the clipboard. Cardmarket's own export is the semicolon one.
 */
export type CsvDelimiter = "," | ";" | "\t";

/** One row of a CSV, and where in the file it came from. */
export interface CsvRecord {
  /** Every cell, unquoted — and, through {@link readCsv}, with the formula escape taken off. */
  cells: string[];
  /**
   * The **physical** line the row starts on, 1-based, counted over the whole file as it arrived:
   * the `sep=` line and every line a quoted cell spans included.
   *
   * **It is not the row's index plus one**, and the difference is the whole reason this field
   * exists. A quoted cell may hold a newline — a note somebody wrote in two paragraphs — so after
   * one such row, "row 7" is no longer "line 7", and a preview quoting line 7 would send the
   * reader to the wrong row of their own file. Counted with the same three breaks `parse.ts`'s
   * per-line reader splits on (CRLF once, a lone CR, a lone LF), so the two readers agree about
   * what a line is.
   */
  line: number;
  /** The row's text exactly as it arrived — quotes, delimiters and all, line break excluded —
   *  so a preview can quote the reader's own file back to them rather than a re-joined guess. */
  raw: string;
  /**
   * `true` when a quote opened in this row is **never closed** before the file ends (issue
   * #1553). Read strictly, everything from that quote to the end of the file is one cell, and
   * every row after it would vanish into it with nothing said. The scanner instead takes that
   * quote as a literal character and reads on, so the rows after it come back as rows — and this
   * flag is how the row that carried it reaches the preview as an issue rather than as a card.
   */
  unterminated?: true;
}

/** A whole CSV, read: the separator it turned out to use, and its rows. */
export interface CsvText {
  delimiter: CsvDelimiter;
  records: CsvRecord[];
}

/**
 * The scanner: text into rows, from `from`, counting physical lines from `firstLine`.
 *
 * A trailing newline produces no final empty row — every file this app writes ends in one, and
 * a phantom row of blanks would become a nameless import issue for every export ever opened.
 */
function scan(text: string, delimiter: string, from: number, firstLine: number): CsvRecord[] {
  const records: CsvRecord[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = from;
  let line = firstLine;
  let start = from;
  let startLine = firstLine;
  // Where the open quote is and what was in hand when it opened — everything needed to go back
  // and read it as a literal character if the file ends before it closes (issue #1553).
  let opened: { at: number; line: number; row: string[]; field: string } | null = null;
  // Quotes this scan has already taken as literal, because each of them was never closed.
  const literal = new Set<number>();
  // Whether the row in hand carried one of those, which is what flags it `unterminated`.
  let rowUnterminated = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = (end: number) => {
    endField();
    const record: CsvRecord = { cells: row, line: startLine, raw: text.slice(start, end) };
    if (rowUnterminated) record.unterminated = true;
    records.push(record);
    row = [];
    rowUnterminated = false;
  };

  for (;;) {
    if (i >= text.length) {
      if (!quoted || opened === null) break;
      // The file ended inside a quoted cell. Strictly that cell is the rest of the file — and
      // every row below the quote is gone into it, silently. Back to the quote instead, which
      // is read as a literal this time, and on from there: the rows after it are rows again,
      // and the row it sat in says, through `unterminated`, that it was malformed.
      literal.add(opened.at);
      i = opened.at;
      line = opened.line;
      row = opened.row;
      field = opened.field;
      quoted = false;
      opened = null;
      continue;
    }
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        // A doubled quote is one quote; a lone one closes the field.
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        opened = null;
        i += 1;
        continue;
      }
      // A break inside a quoted cell is part of the cell **and still a line of the file**. CRLF
      // is counted at its LF, so it is one line and not two.
      if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line += 1;
      field += ch;
      i += 1;
      continue;
    }
    // A quote opens a quoted cell **only at the start of one** (issue #1553) — blanks before it
    // allowed, which is what `1, "Aragorn, the Uniter"` has always relied on. Anywhere else it is
    // a character of the cell: `7" playmat promo` is a note about a seven-inch playmat, and
    // reading its quote as an opening one put every row below it into that note.
    if (ch === '"' && field.trim() === "" && !literal.has(i)) {
      opened = { at: i, line, row: [...row], field };
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === '"' && literal.has(i)) rowUnterminated = true;
    if (ch === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      endRow(i);
      // CRLF is one break, not two.
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      line += 1;
      start = i;
      startLine = line;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Whatever is still in hand is the last row — unless the file ended on a break, in which
  // case there is nothing in hand and no row to add.
  if (field !== "" || row.length > 0) endRow(text.length);
  return records;
}

/**
 * Text into a grid of rows and fields — RFC 4180, nothing else.
 *
 * The bare grid, with no byte-order mark or `sep=` line taken off and no formula escape undone:
 * this is the inverse of {@link csvRow} and the tests hold it to that. What a *file* needs on
 * top of it is {@link readCsv}.
 */
export function parseCsv(text: string, delimiter: CsvDelimiter = ","): string[][] {
  return scan(text, delimiter, 0, 1).map((record) => record.cells);
}

/**
 * Excel's separator declaration — `sep=,` alone on the first line — which Dragon Shield's export
 * writes **inside quotes** (`"sep=,"`, measured on a real export) and Excel writes bare. Both are
 * taken. It declares the separator rather than merely decorating the file, so what it names is
 * used; a declared separator this reader has no type for (`sep=|`) is still stripped, and the
 * file falls back to being measured like any other.
 */
const SEP_LINE = /^"?sep=([^\r\n"]?)"?[ ]*(?:\r\n|\r|\n|$)/i;

/**
 * The separator a header line uses: whichever of the three it carries most of, **outside
 * quotes** — a quoted `"Aragorn, the Uniter"` in a semicolon file is one cell, not a vote for the
 * comma. **The comma wins every tie**, because it is the default and a line carrying none of the
 * three (a one-column file, or a decklist) must go on reading exactly as it always did; a
 * semicolon beats a tab on a tie between the two, because Excel's EU export is the commoner file.
 *
 * Only the first line is read. A CSV's header is where the separator is stated most reliably —
 * column *names* hold no commas or semicolons of their own in any export in scope — while a data
 * row can hold a card called `Aragorn, the Uniter` in an unquoted cell of a semicolon file.
 */
function detectDelimiter(text: string, from: number): CsvDelimiter {
  let commas = 0;
  let semicolons = 0;
  let tabs = 0;
  let quoted = false;
  // Whether the cell in hand is still blank — the scanner's rule for when a quote opens one
  // (issue #1553), so `7" playmat` is no more a quoted cell here than it is there.
  let blank = true;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    // A doubled quote toggles twice, which is the same as not toggling — so `""` inside a quoted
    // cell needs no rule of its own here.
    if (quoted) {
      if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"' && blank) quoted = true;
    else if (ch === "\r" || ch === "\n") break;
    else if (ch === "," || ch === ";" || ch === "\t") {
      if (ch === ",") commas += 1;
      else if (ch === ";") semicolons += 1;
      else tabs += 1;
      blank = true;
      continue;
    }
    if (ch !== " " && ch !== '"') blank = false;
  }
  if (semicolons > commas && semicolons >= tabs) return ";";
  if (tabs > commas && tabs > semicolons) return "\t";
  return ",";
}

/** The declared separator, if it is one this reader has a type for. */
function declared(char: string): CsvDelimiter | null {
  return char === "," || char === ";" || char === "\t" ? char : null;
}

/**
 * A CSV **file** into rows: what {@link parseCsv} does, plus the four things a real file needs.
 *
 * 1. **A byte-order mark comes off.** Excel writes one on every UTF-8 save; left on, it is the
 *    first character of the first header cell.
 * 2. **A `sep=` line comes off** ({@link SEP_LINE}), and the separator it names is used.
 * 3. **The separator is measured** from the header line when nothing declared one
 *    ({@link detectDelimiter}).
 * 4. **Every cell has the formula escape taken off** (`formula.ts`' `unescapeFormula`), header
 *    cells included — the writer puts one apostrophe in front of anything a spreadsheet would
 *    evaluate, and this is the half that makes the app's own CSV round-trip through it.
 *
 * Line numbers are still counted over the text **as it arrived**, so a Dragon Shield file's
 * header is line 2 — the line a reader opening it in a text editor finds it on.
 */
export function readCsv(text: string): CsvText {
  let from = text.startsWith("﻿") ? 1 : 0;
  let firstLine = 1;
  let delimiter: CsvDelimiter | null = null;
  const sep = SEP_LINE.exec(text.slice(from));
  if (sep !== null) {
    delimiter = declared(sep[1]);
    from += sep[0].length;
    firstLine = 2;
  }
  delimiter ??= detectDelimiter(text, from);
  const records = scan(text, delimiter, from, firstLine).map((record) => ({
    ...record,
    cells: record.cells.map(unescapeFormula),
  }));
  return { delimiter, records };
}
