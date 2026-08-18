import { describe, expect, it } from "vitest";
import { EXPORT_FORMATS, formatExport, omittedCount, type ExportCard } from "./format";
import { parseDecklist } from "../import/parse";

/**
 * One card, overridden per test.
 *
 * The three category defaults are what a single-pile export always looked like — the main deck,
 * switched on — so every assertion written before `ExportCard` widened still means what it did.
 */
const card = (over: Partial<ExportCard> = {}): ExportCard => ({
  name: "Sol Ring",
  quantity: 1,
  setCode: "LTC",
  collectorNumber: "285",
  finish: null,
  categoryName: "Main deck",
  categoryKind: "main",
  categoryActive: true,
  ...over,
});

const BOLT = card({ name: "Lightning Bolt", quantity: 2, setCode: "lea", collectorNumber: "161" });
const PATHWAY = card({
  name: "Branchloft Pathway // Boulderloft Pathway",
  setCode: "znr",
  collectorNumber: "258",
  finish: null,
});

describe("formatExport", () => {
  it("writes plain lines as quantity then name", () => {
    expect(formatExport([BOLT], "plain")).toBe("2 Lightning Bolt\n");
  });

  it("keeps a double-faced name whole in every format", () => {
    // `//` is part of the name anywhere but the start of a line -- seven such names are in
    // the importer's own reference list. Cutting one here is a card the reader loses.
    for (const format of EXPORT_FORMATS) {
      expect(formatExport([PATHWAY], format)).toContain(
        "Branchloft Pathway // Boulderloft Pathway",
      );
    }
  });

  it("names the printing in the MTGO and Moxfield formats", () => {
    // Moxfield writes its heading even for one section: the vocabulary is fixed, so `Deck` is a
    // fact about where these cards are and not a separator that a one-pile file can do without.
    expect(formatExport([BOLT], "moxfield")).toBe("Deck\n2 Lightning Bolt (LEA) 161\n");
    expect(formatExport([BOLT], "mtgo")).toBe("2 Lightning Bolt\n");
  });

  it("writes a CSV with a header row", () => {
    expect(formatExport([BOLT], "csv")).toBe(
      "Quantity,Name,Set,Collector number,Category,Finish\n2,Lightning Bolt,lea,161,Main deck,\n",
    );
  });

  it("quotes a CSV field containing a comma or a quote", () => {
    const odd = card({
      name: 'Ach! Hans, Run! "the" card',
      setCode: "unh",
      collectorNumber: "1",
      finish: null,
    });
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

  it("answers with an empty string when a format filters every card out", () => {
    // The empty-list rule reaches a list that is not empty: an Arena export of a deck that is
    // entirely maybeboard writes nothing, and a `Deck` heading over nothing would be the same
    // file-claiming-to-be-a-decklist the CSV header rule refuses.
    const cards = [card({ name: "Mox Amber", categoryActive: false })];
    expect(formatExport(cards, "arena")).toBe("");
    expect(formatExport(cards, "mtgo")).toBe("");
    expect(formatExport(cards, "moxfield")).not.toBe("");
  });

  it("writes MTGO's sideboard with an SB: prefix", () => {
    const cards = [
      card({ name: "Sol Ring" }),
      card({ name: "Duress", categoryName: "Sideboard", categoryKind: "side" }),
    ];
    expect(formatExport(cards, "mtgo")).toBe("1 Sol Ring\nSB: 1 Duress\n");
  });

  it("writes Arena's and Moxfield's sections in a fixed ladder", () => {
    const cards = [
      card({ name: "Duress", categoryName: "Sideboard", categoryKind: "side" }),
      card({ name: "Sol Ring" }),
      card({ name: "Captain Sisay", categoryName: "Commander", categoryKind: "commander" }),
    ];
    expect(formatExport(cards, "arena")).toBe(
      "Commander\n1 Captain Sisay (LTC) 285\n\nDeck\n1 Sol Ring (LTC) 285\n\nSideboard\n1 Duress (LTC) 285\n",
    );
  });

  it("writes a switched-on pile whose kind is maybe under Deck", () => {
    // Nothing anywhere may branch on a kind being `maybe`: the switch is the whole of what an
    // inactive pile means, so a Maybeboard the reader turned **on** counts toward the deck and
    // writes there. `KIND_SECTION` is what would silently reverse this.
    const cards = [card({ name: "Mox Amber", categoryName: "Maybeboard", categoryKind: "maybe" })];
    expect(formatExport(cards, "moxfield")).toBe("Deck\n1 Mox Amber (LTC) 285\n");
    expect(omittedCount(cards, "arena")).toBe(0);
  });

  it("puts a switched-off pile in Moxfield's maybeboard and leaves it out of Arena's", () => {
    const cards = [
      card({ name: "Sol Ring" }),
      card({ name: "Mox Amber", categoryName: "Ramp", categoryActive: false }),
    ];
    expect(formatExport(cards, "moxfield")).toContain("Maybeboard\n1 Mox Amber");
    expect(formatExport(cards, "arena")).not.toContain("Mox Amber");
    expect(omittedCount(cards, "arena")).toBe(1);
    expect(omittedCount(cards, "moxfield")).toBe(0);
  });

  it("counts omitted copies, not rows", () => {
    const cards = [card({ name: "Forest", quantity: 6, categoryActive: false })];
    expect(omittedCount(cards, "mtgo")).toBe(6);
  });

  it("writes Archidekt's headings, brackets and noDeck flag", () => {
    const cards = [
      card({ name: "Sol Ring", categoryName: "Ramp", setCode: "FIC", collectorNumber: "358" }),
      card({
        name: "Mox Amber",
        categoryName: "Maybe",
        categoryActive: false,
        setCode: "DOM",
        collectorNumber: "224",
        finish: null,
      }),
    ];
    expect(formatExport(cards, "archidekt")).toBe(
      "Ramp\n1x Sol Ring (fic) 358 [Ramp]\n\nMaybe\n1x Mox Amber (dom) 224 [Maybe{noDeck}]\n",
    );
  });

  it("writes TCGplayer's bracketed printing, flat and uppercased", () => {
    const cards = [
      card({ name: "Sol Ring", categoryName: "Ramp", categoryKind: "commander" }),
      BOLT,
    ];
    // No heading over either row, though one of these is a commander and the other is not:
    // Mass Entry reads every line as one item, so a heading would be read as a card.
    expect(formatExport(cards, "tcgplayer")).toBe(
      "1 Sol Ring [LTC] 285\n2 Lightning Bolt [LEA] 161\n",
    );
  });

  it("writes a switched-off pile into TCGplayer, and leaves nothing out", () => {
    // The one flat format that keeps a maybeboard: a Mass Entry list is a cart, and the pile a
    // reader switched off is usually exactly what they still have to buy. Arena and MTGO cut it.
    const cards = [card({ name: "Forest", quantity: 6, categoryActive: false })];
    expect(formatExport(cards, "tcgplayer")).toBe("6 Forest [LTC] 285\n");
    expect(omittedCount(cards, "tcgplayer")).toBe(0);
    expect(omittedCount(cards, "arena")).toBe(6);
  });

  it("writes no finish marker into TCGplayer", () => {
    // A printing's foil is chosen in the cart rather than named in the text, so `*F*` here would
    // be a word Mass Entry reads as part of the card's name.
    expect(formatExport([card({ finish: "foil" })], "tcgplayer")).toBe("1 Sol Ring [LTC] 285\n");
    expect(formatExport([card({ finish: "foil" })], "plain")).toBe("1 Sol Ring *F*\n");
  });

  it("gives the CSV a category column", () => {
    expect(formatExport([card({ name: "Sol Ring", categoryName: "Ramp" })], "csv")).toBe(
      "Quantity,Name,Set,Collector number,Category,Finish\n1,Sol Ring,LTC,285,Ramp,\n",
    );
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

  it("round-trips every format this app can also read", () => {
    const cards = [
      card({ name: "Captain Sisay", categoryName: "Commander", categoryKind: "commander" }),
      card({ name: "Branchloft Pathway // Boulderloft Pathway", categoryName: "Land" }),
      card({ name: "Duress", categoryName: "Sideboard", categoryKind: "side" }),
    ];
    // **Two formats are write-only, and each for its own reason.** CSV, because nothing in
    // `parse.ts` reads a comma-separated decklist and adding one would be a second grammar
    // rather than a rule inside the one there is. TCGplayer, because its line is aimed at a
    // cart rather than at us: `parse.ts`'s `BRACKET` is anchored to the end of the line, so a
    // bracket with a collector number after it is not a bracket to that parser and the whole
    // tail lands in the name — see the next test, which pins that rather than leaving it as a
    // claim. Both are excluded **by name** so neither gap can read as an oversight.
    const readable = EXPORT_FORMATS.filter((f) => f !== "csv" && f !== "tcgplayer");
    expect(readable).toEqual(["plain", "mtgo", "arena", "moxfield", "archidekt"]);
    for (const f of readable) {
      const back = parseDecklist(formatExport(cards, f));
      expect(back.issues, f).toEqual([]);
      expect(back.lines.map((l) => l.name).sort(), f).toEqual(cards.map((c) => c.name).sort());
      expect(back.totalCards, f).toBe(3);
    }
  });

  it("does not round-trip TCGplayer, and this is where that is measured", () => {
    // The reason TCGplayer sits beside CSV in the exclusion above, pinned rather than asserted
    // in prose: the copies survive and the **name does not**. If `parse.ts` ever learns to read
    // an unanchored bracket, this test fails and the exclusion is the thing to revisit.
    const back = parseDecklist(formatExport([BOLT], "tcgplayer"));
    expect(back.lines.map((l) => l.name)).toEqual(["Lightning Bolt [LEA] 161"]);
    expect(back.lines.map((l) => l.quantity)).toEqual([2]);
  });

  it("round-trips the piles through the formats that carry them", () => {
    const cards = [
      card({ name: "Sol Ring", categoryName: "Ramp" }),
      card({ name: "Duress", categoryName: "Sideboard", categoryKind: "side" }),
    ];
    const archidekt = parseDecklist(formatExport(cards, "archidekt"));
    expect(archidekt.lines.map((l) => l.categoryName)).toEqual(["Ramp", null]);
    expect(archidekt.lines.map((l) => l.section)).toEqual(["deck", "sideboard"]);
    const moxfield = parseDecklist(formatExport(cards, "moxfield"));
    expect(moxfield.lines.map((l) => l.section)).toEqual(["deck", "sideboard"]);
  });

  it("round-trips a switched-off pile through Archidekt and nothing else", () => {
    // `{noDeck}` is the whole reason Archidekt is here: it is the one format that can say a pile
    // counts toward nothing, so it is the one export a reader can re-import without losing their
    // maybeboard. Moxfield keeps the cards under a heading and loses the switch.
    const cards = [card({ name: "Mox Amber", categoryName: "Cuts", categoryActive: false })];
    const archidekt = parseDecklist(formatExport(cards, "archidekt"));
    expect(archidekt.lines.map((l) => [l.categoryName, l.excluded])).toEqual([["Cuts", true]]);
    const moxfield = parseDecklist(formatExport(cards, "moxfield"));
    expect(moxfield.lines.map((l) => [l.section, l.excluded])).toEqual([["maybeboard", false]]);
  });
});
