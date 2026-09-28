import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { parseDecklist, type ParsedList } from "../parse";
import { CsvNotes } from "./CsvNotes";

/** A list with nothing in it but the CSV shape under test — the component reads nothing else. */
function listWith(csv: ParsedList["csv"]): ParsedList {
  return { lines: [], issues: [], totalCards: 0, suggestedName: null, csv };
}

describe("CsvNotes", () => {
  /** A decklist is not a spreadsheet, and the absence of a shape is two spellings — the field
   *  left off (every hand-built list in the suite) and an explicit `null`. */
  it("draws nothing for a list that was not read as a CSV", () => {
    const { container: pasted } = render(<CsvNotes list={parseDecklist("4 Lightning Bolt")} />);
    expect(pasted).toBeEmptyDOMElement();
    const { container: nulled } = render(<CsvNotes list={listWith(null)} />);
    expect(nulled).toBeEmptyDOMElement();
  });

  it("says a spreadsheet was read, and nothing more when every column was", () => {
    render(
      <CsvNotes list={listWith({ delimiter: ",", ignoredColumns: [], hasQuantity: true })} />,
    );
    expect(screen.getByText("Read as CSV.")).toBeInTheDocument();
    expect(screen.queryByText(/Not read/)).toBeNull();
    expect(screen.queryByText(/No quantity column/)).toBeNull();
  });

  it("names every column it did not read, in the file's own words", () => {
    render(
      <CsvNotes
        list={listWith({
          delimiter: ",",
          ignoredColumns: ["Printing Id", "Artist Proof", "Promo"],
          hasQuantity: true,
        })}
      />,
    );
    expect(
      screen.getByText("Read as CSV. Ignored columns: Printing Id, Artist Proof, Promo."),
    ).toBeInTheDocument();
  });

  it("warns that every row is one copy when no column counts them", () => {
    render(
      <CsvNotes list={listWith({ delimiter: ";", ignoredColumns: [], hasQuantity: false })} />,
    );
    expect(
      screen.getByText(
        "No quantity column found, so each row counts as one copy.",
      ),
    ).toBeInTheDocument();
  });

  /** Wired end to end: the parser's shape is what the component draws, not a fixture's. */
  it("reads what the parser said about a real-shaped export", () => {
    render(<CsvNotes list={parseDecklist("Name,Set code,Scryfall ID\nSol Ring,LTC,abc\n")} />);
    expect(
      screen.getByText("Read as CSV. Ignored columns: Scryfall ID."),
    ).toBeInTheDocument();
    expect(screen.getByText(/No quantity column/)).toBeInTheDocument();
  });
});
