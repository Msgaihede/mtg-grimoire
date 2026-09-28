/**
 * CSV formula injection, both directions (issue #555).
 *
 * A spreadsheet reads a cell that starts with `=`, `+`, `-` or `@` as a formula, so a note a
 * reader wrote as `-2 lent to Sam` opens in Excel as `#NAME?` — and a cell another app wrote can
 * do worse than that. The defence every spreadsheet honours is a leading apostrophe: Excel,
 * LibreOffice and Google Sheets all show `'-2 lent` as the text `-2 lent`. Tab and carriage
 * return lead the list too, because both are read as the start of a formula by some of them.
 *
 * **The writer escapes and the reader un-escapes, so the app's own CSV still round-trips.** That
 * is why the writer's test is `'*` *then* a trigger rather than the trigger alone: a note that
 * already starts `'=` is written `''=`, and reading one apostrophe back off gives the reader the
 * note they wrote. A cell that starts with an apostrophe followed by anything else is not
 * touched in either direction.
 *
 * **Every cell, not a list of free-text columns.** No field this app writes can legitimately
 * start with one of these characters except the free-text ones — a quantity, a price and a
 * collector number never go negative — so escaping every cell costs nothing and cannot leave a
 * column out the day a new free-text field joins the registry.
 *
 * `src-tauri/src/transfer/csv.rs` carries the same rule for the plain-text mirror, and the golden
 * fence is what holds the two together.
 */

/** A leading run of apostrophes, then something a spreadsheet would read as a formula. */
const NEEDS_ESCAPE = /^'*[=+\-@\t\r]/;

/** One apostrophe too many in front of a formula character — what {@link escapeFormula} wrote. */
const ESCAPED = /^'+[=+\-@\t\r]/;

/** A cell as the CSV writer should emit it: one apostrophe in front of anything a spreadsheet
 *  would evaluate. */
export function escapeFormula(value: string): string {
  return NEEDS_ESCAPE.test(value) ? `'${value}` : value;
}

/** A cell as the CSV reader should hand it on: the apostrophe {@link escapeFormula} added, taken
 *  back off. A cell that starts with an apostrophe before anything else is left alone. */
export function unescapeFormula(value: string): string {
  return ESCAPED.test(value) ? value.slice(1) : value;
}
