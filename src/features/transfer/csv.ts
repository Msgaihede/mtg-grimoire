/**
 * CSV, RFC 4180, both directions.
 *
 * The writer is `export/format.ts`'s old private `csvField` promoted, unchanged in behaviour: a
 * field is quoted when it carries a comma, a quote or a newline and **never otherwise**, so
 * `Lightning Bolt` stays `Lightning Bolt` rather than becoming `"Lightning Bolt"` on every row.
 *
 * The reader is new, and it is what makes a collection CSV a restore rather than a dump. A
 * character-by-character scanner rather than a split on commas: a quoted field may contain
 * commas *and newlines*, so there is no line-oriented shortcut that is correct.
 */

/** A field, quoted only when it has to be. An inner quote doubles — RFC 4180's escape. */
export function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function csvRow(values: readonly string[]): string {
  return values.map(csvField).join(",");
}

/**
 * Text into a grid of rows and fields.
 *
 * A trailing newline produces no final empty row — every file this app writes ends in one, and
 * a phantom row of blanks would become a nameless import issue for every export ever opened.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
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
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      endRow();
      // CRLF is one break, not two.
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Whatever is still in hand is the last row — unless the file ended on a break, in which
  // case there is nothing in hand and no row to add.
  if (field !== "" || row.length > 0) endRow();
  return rows;
}
