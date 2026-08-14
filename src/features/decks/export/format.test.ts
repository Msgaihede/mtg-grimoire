import { describe, expect, it } from "vitest";
import { EXPORT_FORMATS, formatExport, type ExportCard } from "./format";
import { parseDecklist } from "../import/parse";

const BOLT: ExportCard = { name: "Lightning Bolt", quantity: 2, setCode: "lea", collectorNumber: "161" };
const PATHWAY: ExportCard = {
  name: "Branchloft Pathway // Boulderloft Pathway",
  quantity: 1, setCode: "znr", collectorNumber: "258",
};

describe("formatExport", () => {
  it("writes plain lines as quantity then name", () => {
    expect(formatExport([BOLT], "plain")).toBe("2 Lightning Bolt\n");
  });

  it("keeps a double-faced name whole in every format", () => {
    // `//` is part of the name anywhere but the start of a line -- seven such names are in
    // the importer's own reference list. Cutting one here is a card the reader loses.
    for (const format of EXPORT_FORMATS) {
      expect(formatExport([PATHWAY], format)).toContain("Branchloft Pathway // Boulderloft Pathway");
    }
  });

  it("names the printing in the MTGO and Moxfield formats", () => {
    expect(formatExport([BOLT], "moxfield")).toBe("2 Lightning Bolt (LEA) 161\n");
    expect(formatExport([BOLT], "mtgo")).toBe("2 Lightning Bolt\n");
  });

  it("writes a CSV with a header row", () => {
    expect(formatExport([BOLT], "csv")).toBe(
      "Quantity,Name,Set,Collector number\n2,Lightning Bolt,lea,161\n",
    );
  });

  it("quotes a CSV field containing a comma or a quote", () => {
    const odd: ExportCard = {
      name: 'Ach! Hans, Run! "the" card', quantity: 1, setCode: "unh", collectorNumber: "1",
    };
    expect(formatExport([odd], "csv")).toContain('"Ach! Hans, Run! ""the"" card"');
  });

  it("ends every format with a trailing newline and uses LF", () => {
    for (const format of EXPORT_FORMATS) {
      const out = formatExport([BOLT, PATHWAY], format);
      expect(out.endsWith("\n")).toBe(true);
      expect(out).not.toContain("\r");
    }
  });

  it("answers an empty list with an empty string, never a stray header", () => {
    for (const format of EXPORT_FORMATS) {
      expect(formatExport([], format)).toBe("");
    }
  });

  it("round-trips through this app's own importer", () => {
    // The only test here that matters in the field: what we write, we must be able to read.
    // `parseDecklist` (../import/parse.ts) returns `ParsedList { lines, issues, totalCards,
    // suggestedName }`, each `ParsedLine` carrying `name` and `quantity` -- confirmed against
    // that file rather than assumed, and it matches the brief's guess exactly.
    const text = formatExport([BOLT, PATHWAY], "plain");
    const parsed = parseDecklist(text);
    expect(parsed.issues).toHaveLength(0);
    expect(parsed.lines.map((l) => l.name)).toEqual([
      "Lightning Bolt",
      "Branchloft Pathway // Boulderloft Pathway",
    ]);
    expect(parsed.lines.map((l) => l.quantity)).toEqual([2, 1]);
  });
});
