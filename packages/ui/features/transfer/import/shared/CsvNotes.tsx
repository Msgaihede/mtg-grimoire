/**
 * What reading a spreadsheet cost, said in a line or two under an import's preview (issue #555).
 *
 * A CSV is the one shape `parse.ts` reads **by column**, and a column it has no field for is
 * read by nothing — a Deckbox export's `Printing Id`, `My Price` and `Scryfall ID` among them.
 * "Nothing is ever silently dropped" is a promise about *lines* everywhere else in the importer;
 * this is where it is kept for *columns*, by naming them. It is also where a file with no count
 * column says that every row became one copy, which is right for a list of cards and quietly
 * wrong for an inventory of fours.
 *
 * **Quiet on purpose.** Dim text, no box and no icon: none of this stops an import, and the
 * problems list above it is where a row that *will not* land is drawn. Nothing at all for a
 * decklist — `list.csv` is absent or `null` for every text that was not read as a spreadsheet.
 */
import type { JSX } from "react";
import type { ParsedList } from "../parse";

export function CsvNotes({ list }: { list: ParsedList }): JSX.Element | null {
  const csv = list.csv;
  if (csv === undefined || csv === null) return null;
  const ignored = csv.ignoredColumns;

  return (
    <div className="space-y-1 text-sm text-dim">
      <p>
        Read as CSV.
        {ignored.length > 0 && ` Ignored columns: ${ignored.join(", ")}.`}
      </p>
      {!csv.hasQuantity && (
        <p>No quantity column found, so each row counts as one copy.</p>
      )}
    </div>
  );
}
