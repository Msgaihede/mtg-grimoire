import { describe, expect, it } from "vitest";
import {
  dropsInactive,
  EXPORT_FORMATS,
  formatExport,
  inactiveCopies,
  isActivePile,
  omittedCount,
} from "./format";
import { defaultFields } from "../fields";
import { transferCard } from "../fixtures";
import type { TransferCard } from "../TransferCard";
import { parseDecklist } from "../import/parse";

/** This suite's cards are **deck** cards: the three category defaults are what a single-pile
 *  export always looked like — the main deck, switched on — so every assertion written before
 *  `TransferCard` existed still means what it did. */
const card = (over: Partial<TransferCard> = {}): TransferCard =>
  transferCard({ name: "Sol Ring", setCode: "LTC", collectorNumber: "285",
    categoryName: "Main deck", categoryKind: "main", categoryActive: true, ...over });

const BOLT = card({ name: "Lightning Bolt", quantity: 2, setCode: "lea", collectorNumber: "161" });
const PATHWAY = card({
  name: "Branchloft Pathway // Boulderloft Pathway",
  setCode: "znr",
  collectorNumber: "258",
  finish: null,
});

describe("formatExport", () => {
  it("writes plain lines as quantity then name", () => {
    expect(formatExport([BOLT], "plain", defaultFields("plain", "deck"))).toBe(
      "2 Lightning Bolt\n",
    );
  });

  it("keeps a double-faced name whole in every format", () => {
    // `//` is part of the name anywhere but the start of a line -- seven such names are in
    // the importer's own reference list. Cutting one here is a card the reader loses.
    for (const format of EXPORT_FORMATS) {
      expect(formatExport([PATHWAY], format, defaultFields(format, "deck"))).toContain(
        "Branchloft Pathway // Boulderloft Pathway",
      );
    }
  });

  it("names the printing in the MTGO and Moxfield formats", () => {
    // Moxfield writes its heading even for one section: the vocabulary is fixed, so `Deck` is a
    // fact about where these cards are and not a separator that a one-pile file can do without.
    expect(formatExport([BOLT], "moxfield", defaultFields("moxfield", "deck"))).toBe(
      "Deck\n2 Lightning Bolt (LEA) 161\n",
    );
    expect(formatExport([BOLT], "mtgo", defaultFields("mtgo", "deck"))).toBe(
      "2 Lightning Bolt\n",
    );
  });

  it("writes a CSV with a header row", () => {
    expect(formatExport([BOLT], "csv", defaultFields("csv", "deck"))).toBe(
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
    expect(formatExport([odd], "csv", defaultFields("csv", "deck"))).toContain(
      '"Ach! Hans, Run! ""the"" card"',
    );
  });

  it("ends every format with a trailing newline and uses LF", () => {
    for (const format of EXPORT_FORMATS) {
      const out = formatExport([BOLT, PATHWAY], format, defaultFields(format, "deck"));
      expect(out.endsWith("\n")).toBe(true);
      expect(out).not.toContain("\r");
    }
  });

  it("answers an empty list with an empty string, never a stray header", () => {
    for (const format of EXPORT_FORMATS) {
      expect(formatExport([], format, defaultFields(format, "deck"))).toBe("");
    }
  });

  it("answers with an empty string when a format filters every card out", () => {
    // The empty-list rule reaches a list that is not empty: an Arena export of a deck that is
    // entirely maybeboard writes nothing, and a `Deck` heading over nothing would be the same
    // file-claiming-to-be-a-decklist the CSV header rule refuses.
    const cards = [card({ name: "Mox Amber", categoryActive: false })];
    expect(formatExport(cards, "arena", defaultFields("arena", "deck"))).toBe("");
    expect(formatExport(cards, "mtgo", defaultFields("mtgo", "deck"))).toBe("");
    expect(formatExport(cards, "moxfield", defaultFields("moxfield", "deck"))).not.toBe("");
  });

  it("writes MTGO's sideboard with an SB: prefix", () => {
    const cards = [
      card({ name: "Sol Ring" }),
      card({ name: "Duress", categoryName: "Sideboard", categoryKind: "side" }),
    ];
    expect(formatExport(cards, "mtgo", defaultFields("mtgo", "deck"))).toBe(
      "1 Sol Ring\nSB: 1 Duress\n",
    );
  });

  it("writes Arena's and Moxfield's sections in a fixed ladder", () => {
    const cards = [
      card({ name: "Duress", categoryName: "Sideboard", categoryKind: "side" }),
      card({ name: "Sol Ring" }),
      card({ name: "Captain Sisay", categoryName: "Commander", categoryKind: "commander" }),
    ];
    expect(formatExport(cards, "arena", defaultFields("arena", "deck"))).toBe(
      "Commander\n1 Captain Sisay (LTC) 285\n\nDeck\n1 Sol Ring (LTC) 285\n\nSideboard\n1 Duress (LTC) 285\n",
    );
  });

  it("writes a switched-on pile whose kind is maybe under Deck", () => {
    // Nothing anywhere may branch on a kind being `maybe`: the switch is the whole of what an
    // inactive pile means, so a Maybeboard the reader turned **on** counts toward the deck and
    // writes there. `KIND_SECTION` is what would silently reverse this.
    const cards = [card({ name: "Mox Amber", categoryName: "Maybeboard", categoryKind: "maybe" })];
    expect(formatExport(cards, "moxfield", defaultFields("moxfield", "deck"))).toBe(
      "Deck\n1 Mox Amber (LTC) 285\n",
    );
    expect(omittedCount(cards, "arena")).toBe(0);
  });

  it("puts a switched-off pile in Moxfield's maybeboard and leaves it out of Arena's", () => {
    const cards = [
      card({ name: "Sol Ring" }),
      card({ name: "Mox Amber", categoryName: "Ramp", categoryActive: false }),
    ];
    expect(formatExport(cards, "moxfield", defaultFields("moxfield", "deck"))).toContain(
      "Maybeboard\n1 Mox Amber",
    );
    expect(formatExport(cards, "arena", defaultFields("arena", "deck"))).not.toContain(
      "Mox Amber",
    );
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
    expect(formatExport(cards, "archidekt", defaultFields("archidekt", "deck"))).toBe(
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
    expect(formatExport(cards, "tcgplayer", defaultFields("tcgplayer", "deck"))).toBe(
      "1 Sol Ring [LTC] 285\n2 Lightning Bolt [LEA] 161\n",
    );
  });

  it("writes a switched-off pile into TCGplayer, and leaves nothing out", () => {
    // The one flat format that keeps a maybeboard: a Mass Entry list is a cart, and the pile a
    // reader switched off is usually exactly what they still have to buy. Arena and MTGO cut it.
    const cards = [card({ name: "Forest", quantity: 6, categoryActive: false })];
    expect(formatExport(cards, "tcgplayer", defaultFields("tcgplayer", "deck"))).toBe(
      "6 Forest [LTC] 285\n",
    );
    expect(omittedCount(cards, "tcgplayer")).toBe(0);
    expect(omittedCount(cards, "arena")).toBe(6);
  });

  it("writes no finish marker into TCGplayer", () => {
    // A printing's foil is chosen in the cart rather than named in the text, so `*F*` here would
    // be a word Mass Entry reads as part of the card's name.
    expect(
      formatExport([card({ finish: "foil" })], "tcgplayer", defaultFields("tcgplayer", "deck")),
    ).toBe("1 Sol Ring [LTC] 285\n");
    expect(formatExport([card({ finish: "foil" })], "plain", defaultFields("plain", "deck"))).toBe(
      "1 Sol Ring *F*\n",
    );
  });

  it("gives the CSV a category column", () => {
    expect(
      formatExport(
        [card({ name: "Sol Ring", categoryName: "Ramp" })],
        "csv",
        defaultFields("csv", "deck"),
      ),
    ).toBe("Quantity,Name,Set,Collector number,Category,Finish\n1,Sol Ring,LTC,285,Ramp,\n");
  });

  it("round-trips through this app's own importer", () => {
    // The only test here that matters in the field: what we write, we must be able to read.
    // `parseDecklist` (../import/parse.ts) returns `ParsedList { lines, issues, totalCards,
    // suggestedName }`, each `ParsedLine` carrying `name` and `quantity` -- confirmed against
    // that file rather than assumed, and it matches the brief's guess exactly.
    const text = formatExport([BOLT, PATHWAY], "plain", defaultFields("plain", "deck"));
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
    // **One format is write-only.** TCGplayer, because its line is aimed at a cart rather than
    // at us: `parse.ts`'s `BRACKET` is anchored to the end of the line, so a bracket with a
    // collector number after it is not a bracket to that parser and the whole tail lands in the
    // name — see the next test, which pins that rather than leaving it as a claim. Excluded **by
    // name** so the gap cannot read as an oversight. **CSV carried this label through Tasks 1–9
    // and stopped being true in Task 10** — `parse.ts` reads a CSV by its header row now, and
    // `decklists.test.ts` drives it over three real decklists — so it belongs in `readable`
    // beside everything else that round-trips.
    const readable = EXPORT_FORMATS.filter((f) => f !== "tcgplayer");
    expect(readable).toEqual(["plain", "mtgo", "arena", "moxfield", "archidekt", "csv"]);
    for (const f of readable) {
      const back = parseDecklist(formatExport(cards, f, defaultFields(f, "deck")));
      expect(back.issues, f).toEqual([]);
      expect(back.lines.map((l) => l.name).sort(), f).toEqual(cards.map((c) => c.name).sort());
      expect(back.totalCards, f).toBe(3);
    }
  });

  it("does not round-trip TCGplayer, and this is where that is measured", () => {
    // The reason TCGplayer is the one exclusion above, pinned rather than asserted in prose: the
    // copies survive and the **name does not**. If `parse.ts` ever learns to read an unanchored
    // bracket, this test fails and the exclusion is the thing to revisit.
    const back = parseDecklist(formatExport([BOLT], "tcgplayer", defaultFields("tcgplayer", "deck")));
    expect(back.lines.map((l) => l.name)).toEqual(["Lightning Bolt [LEA] 161"]);
    expect(back.lines.map((l) => l.quantity)).toEqual([2]);
  });

  it("round-trips the piles through the formats that carry them", () => {
    const cards = [
      card({ name: "Sol Ring", categoryName: "Ramp" }),
      card({ name: "Duress", categoryName: "Sideboard", categoryKind: "side" }),
    ];
    const archidekt = parseDecklist(
      formatExport(cards, "archidekt", defaultFields("archidekt", "deck")),
    );
    expect(archidekt.lines.map((l) => l.categoryName)).toEqual(["Ramp", null]);
    expect(archidekt.lines.map((l) => l.section)).toEqual(["deck", "sideboard"]);
    const moxfield = parseDecklist(
      formatExport(cards, "moxfield", defaultFields("moxfield", "deck")),
    );
    expect(moxfield.lines.map((l) => l.section)).toEqual(["deck", "sideboard"]);
  });

  it("round-trips a switched-off pile through Archidekt and nothing else", () => {
    // `{noDeck}` is the whole reason Archidekt is here: it is the one format that can say a pile
    // counts toward nothing, so it is the one export a reader can re-import without losing their
    // maybeboard. Moxfield keeps the cards under a heading and loses the switch.
    const cards = [card({ name: "Mox Amber", categoryName: "Cuts", categoryActive: false })];
    const archidekt = parseDecklist(
      formatExport(cards, "archidekt", defaultFields("archidekt", "deck")),
    );
    expect(archidekt.lines.map((l) => [l.categoryName, l.excluded])).toEqual([["Cuts", true]]);
    const moxfield = parseDecklist(
      formatExport(cards, "moxfield", defaultFields("moxfield", "deck")),
    );
    expect(moxfield.lines.map((l) => [l.section, l.excluded])).toEqual([["maybeboard", false]]);
  });
});

/**
 * The switched-off pile, asked about from **outside** the writer — issue #390's half of this
 * file.
 *
 * `formatExport` is unchanged by that issue and this section is why: the reader's own
 * `Include inactive categories` box is a **row filter applied in the dialog**, exactly as the
 * Arena one is, so the writer keeps its `(cards, format, fields) => string` shape, the golden
 * corpus needs no new bytes and `src-tauri/src/transfer/` needs no new port. What the dialog
 * needed instead was three answers this file already knew privately — is this format going to
 * decide for itself, is this row in a switched-off pile, and how many copies are — and the whole
 * of the change is that each is now a named export with a test under it.
 *
 * **The three are tested here rather than through the dialog because they are the part that can
 * be wrong quietly.** A checkbox drawn in the wrong place is visible; a count that describes a
 * different file than the one Copy puts on the clipboard is not.
 */
describe("the switched-off pile, from outside the writer", () => {
  /**
   * Exactly two formats answer this for themselves, and the pair is asserted **by name** rather
   * than by a count — `decklists.test.ts`'s `READABLE` pin, one directory over, for the same
   * reason. A format leaving or joining `ACTIVE_ONLY` is a decision about what a reader's file
   * contains, so it should arrive as a red build naming the format rather than as `3` where `2`
   * used to be, which reads as arithmetic and gets updated without being read.
   *
   * The consequence the dialog turns on: these two are the formats where the box is **not
   * drawn**. Arena and MTGO have no maybeboard, so writing one produces an illegal import at the
   * other end, and no preference may turn that back on — a checkbox that cannot move the file is
   * furniture.
   */
  it("names arena and mtgo as the formats that answer for themselves", () => {
    expect(EXPORT_FORMATS.filter(dropsInactive)).toEqual(["mtgo", "arena"]);
  });

  /**
   * `isActivePile` is `categoryActive !== false`, and the arm worth writing a test for is the
   * **`null`** one.
   *
   * `null` is not a third answer to "is this pile switched on" — it is a row from a surface that
   * has no piles at all, where the question was never asked. **`categoryActive === true` is the
   * spelling that looks equivalent and is not**, and the two are indistinguishable on the only
   * surface anybody would think to check: every deck row carries a real boolean, so both answer
   * identically on all of them.
   *
   * Where they differ is a collection or a wishlist, and the reader gets there without touching
   * a checkbox at all — `written` filters by this same predicate for Arena and MTGO, whatever
   * anybody asked, so the wrong spelling makes an Arena export of a collection the empty string
   * with every row silently gone. The last assertion here is that path rather than the
   * predicate, because it is the one that ships.
   */
  it("counts a pile-less row as active, because nothing there was ever switched off", () => {
    const pileless = card({ categoryName: null, categoryKind: null, categoryActive: null });
    expect(isActivePile(card({ categoryActive: true }))).toBe(true);
    expect(isActivePile(card({ categoryActive: false }))).toBe(false);
    expect(isActivePile(pileless)).toBe(true);
    expect(formatExport([pileless], "arena", defaultFields("arena", "collection"))).toBe(
      "1 Sol Ring (LTC) 285\n",
    );
  });

  /**
   * **Copies, never rows.** Six basic lands on one cut row are six cards that will not be in the
   * file, and "1 card" would be a true statement about the array and a false one about the deck
   * — which is the sentence the reader is actually owed, since they are about to paste this
   * somewhere and count it.
   *
   * Two rows carrying eight copies, so the two implementations answer different numbers: a
   * `reduce` over `quantity` says 8 and a `filter(...).length` says 2. A one-copy fixture would
   * pass under both, which is how this rule gets tidied away.
   */
  it("counts copies rather than rows", () => {
    const cards = [
      card({ name: "Forest", quantity: 6, categoryName: "Cuts", categoryActive: false }),
      card({ name: "Mox Amber", quantity: 2, categoryName: "Cuts", categoryActive: false }),
    ];
    expect(inactiveCopies(cards)).toBe(8);
  });

  it("answers zero over a list with nothing switched off", () => {
    expect(inactiveCopies([BOLT, PATHWAY, card({ quantity: 4 })])).toBe(0);
  });

  /** And zero over a surface that has no piles — the `null` arm above read at list scale. A
   *  collection export can never hold anything back this way, which is the same fact
   *  `SURFACE_HAS_PILES` states one file up and the reason the box is not drawn there. */
  it("answers zero over rows from a surface with no piles", () => {
    const rows = [
      card({ quantity: 4, categoryName: null, categoryKind: null, categoryActive: null }),
      card({ quantity: 9, categoryName: null, categoryKind: null, categoryActive: null }),
    ];
    expect(inactiveCopies(rows)).toBe(0);
  });

  /**
   * **`omittedCount` is `inactiveCopies` behind the `dropsInactive` gate, and that lifting is
   * the entire reason `inactiveCopies` is a function at all.**
   *
   * The dialog computes its own held-back count from `inactiveCopies` behind the *complementary*
   * half of the same gate — the reader's box is offered only where the format has not already
   * decided — so the two numbers are one piece of arithmetic read through two fences. Written
   * twice they could drift, and the failure would be a line under the format radios that
   * describes a different file from the one Copy puts on the clipboard: silent, plausible, and
   * wrong in exactly the direction a reader would not check.
   *
   * The expectation is spelled with the format **names** and a literal 8 rather than with
   * `dropsInactive` and `inactiveCopies` themselves. Reading the implementation's own two
   * expressions back at it would make this pass over any pair of broken halves that happened to
   * agree; the test above pins which formats those names are.
   */
  it("is inactiveCopies behind the dropsInactive gate, so the two cannot drift", () => {
    const cards = [
      card({ name: "Forest", quantity: 6, categoryName: "Cuts", categoryActive: false }),
      card({ name: "Mox Amber", quantity: 2, categoryName: "Cuts", categoryActive: false }),
      card({ name: "Sol Ring", quantity: 1 }),
    ];
    expect(inactiveCopies(cards)).toBe(8);
    for (const format of EXPORT_FORMATS) {
      expect(omittedCount(cards, format), format).toBe(
        format === "arena" || format === "mtgo" ? 8 : 0,
      );
    }
  });
});

/**
 * The field-selection layer: which fields land on the line, over the six formats' own shapes.
 *
 * **The whole point of `defaultOn`.** If the first test here goes red, a default moved and every
 * deck exported since shipped a different file — the property this task exists to guarantee.
 */
describe("field selection", () => {
  const DECK = "deck" as const;

  it("writes exactly what it wrote before, at every format's defaults", () => {
    expect(formatExport([BOLT], "plain", defaultFields("plain", DECK))).toBe(
      "2 Lightning Bolt\n",
    );
    expect(formatExport([card()], "moxfield", defaultFields("moxfield", DECK))).toBe(
      "Deck\n1 Sol Ring (LTC) 285\n",
    );
    expect(formatExport([card()], "archidekt", defaultFields("archidekt", DECK))).toBe(
      "Main deck\n1x Sol Ring (ltc) 285 [Main deck]\n",
    );
    expect(formatExport([card()], "tcgplayer", defaultFields("tcgplayer", DECK))).toBe(
      "1 Sol Ring [LTC] 285\n",
    );
  });

  it("drops the printing from a Moxfield line when the reader switches it off", () => {
    expect(formatExport([card()], "moxfield", ["quantity", "name"])).toBe("Deck\n1 Sol Ring\n");
  });

  it("drops the bracket from an Archidekt line when the category is switched off", () => {
    expect(
      formatExport([card()], "archidekt", ["quantity", "name", "setCode", "collectorNumber"]),
    ).toBe("Main deck\n1x Sol Ring (ltc) 285\n");
  });

  it("writes the finish mark only when the finish is on", () => {
    const foil = card({ finish: "foil" });
    expect(formatExport([foil], "plain", ["quantity", "name", "finish"])).toBe(
      "1 Sol Ring *F*\n",
    );
    expect(formatExport([foil], "plain", ["quantity", "name"])).toBe("1 Sol Ring\n");
  });

  it("makes CSV's columns the chosen fields, header and all", () => {
    expect(formatExport([card()], "csv", ["quantity", "name", "condition"])).toBe(
      "Quantity,Name,Condition\n1,Sol Ring,\n",
    );
  });

  /**
   * The deck label, out — Archidekt's `^Keeper,#4aab08^`.
   *
   * The test above still passes over `card()`, which wears none, so it says nothing about this
   * even though `label` is now among Archidekt's defaults. That is the vacuous half, and these
   * are
   * what close it.
   */
  it("writes an Archidekt label at that format's defaults, colour and all", () => {
    const keeper = card({ labelName: "Keeper", labelColor: "#4aab08" });
    expect(formatExport([keeper], "archidekt", defaultFields("archidekt", DECK))).toBe(
      "Main deck\n1x Sol Ring (ltc) 285 [Main deck] ^Keeper,#4aab08^\n",
    );
  });

  it("writes no group at all for a card wearing no label", () => {
    expect(formatExport([card()], "archidekt", defaultFields("archidekt", DECK))).toBe(
      "Main deck\n1x Sol Ring (ltc) 285 [Main deck]\n",
    );
  });

  it("drops the label when the reader unticks Label", () => {
    const keeper = card({ labelName: "Keeper", labelColor: "#4aab08" });
    expect(formatExport([keeper], "archidekt", ["quantity", "name", "category"])).toBe(
      "Main deck\n1x Sol Ring [Main deck]\n",
    );
  });

  /** A colour this build cannot read is not a reason to lose the name — and the parser reads the
   *  group straight back as a label with no colour. */
  it("writes the name alone when the label has no colour", () => {
    const keeper = card({ labelName: "Keeper", labelColor: null });
    expect(formatExport([keeper], "archidekt", ["quantity", "name", "label"])).toBe(
      "Main deck\n1x Sol Ring ^Keeper^\n",
    );
  });

  /** **The label goes last on the line**, after the bracket and after `*F*`, which is where
   *  Archidekt puts it and the order `stripDecorations` peels from the end. */
  it("puts the label after every other decoration", () => {
    const keeper = card({ finish: "foil", labelName: "Keeper", labelColor: "#4aab08" });
    expect(formatExport([keeper], "archidekt", defaultFields("archidekt", DECK))).toBe(
      "Main deck\n1x Sol Ring (ltc) 285 [Main deck] *F* ^Keeper,#4aab08^\n",
    );
  });

  /** A CSV spends a column per value, so the colour is its own field there — and its own
   *  checkbox, off by default. */
  it("gives CSV a column each for the label and its colour", () => {
    const keeper = card({ labelName: "Keeper", labelColor: "#4aab08" });
    expect(formatExport([keeper], "csv", ["quantity", "name", "label", "labelColor"])).toBe(
      "Quantity,Name,Label,Label colour\n1,Sol Ring,Keeper,#4aab08\n",
    );
    // Ticking one and not the other is the reader's business; neither implies the other.
    expect(formatExport([keeper], "csv", ["quantity", "name", "label"])).toBe(
      "Quantity,Name,Label\n1,Sol Ring,Keeper\n",
    );
  });

  it("writes one flat list on a surface with no categories", () => {
    // A collection row has `categoryKind: null`, so there is no section to head.
    const row = card({ categoryName: null, categoryKind: null, categoryActive: null });
    expect(formatExport([row], "moxfield", ["quantity", "name"])).toBe("1 Sol Ring\n");
  });

  it("folds two rows a field set cannot tell apart before writing them", () => {
    const nm = card({ name: "Bolt", quantity: 2, condition: "NM", categoryKind: null,
      categoryName: null, categoryActive: null });
    const lp = card({ name: "Bolt", quantity: 1, condition: "LP", categoryKind: null,
      categoryName: null, categoryActive: null });
    expect(formatExport([nm, lp], "plain", ["quantity", "name"])).toBe("3 Bolt\n");
  });

  /**
   * The label is an ordinary keyed field in the fold, and it needs no `DISCRIMINATOR` entry
   * because it is not structural: with Label on, two differently-labelled rows are two lines;
   * with it off, the file cannot tell them apart and folding them is the fold doing its job.
   *
   * The pair really is one grain in a deck — one printing, one pile, one finish, two labels —
   * which
   * `deck_cards` cannot hold, but a *collection* can and a caller can hand this function
   * anything. Asserted rather than assumed, because "it cannot happen" is how a fold key goes
   * missing.
   */
  it("keeps two labels apart while Label is on, and folds them when it is off", () => {
    const keeper = card({ name: "Bolt", quantity: 2, labelName: "Keeper", labelColor: "#4aab08" });
    const cut = card({ name: "Bolt", quantity: 1, labelName: "Cut", labelColor: "#d3202a" });
    expect(formatExport([keeper, cut], "archidekt", ["quantity", "name", "label"])).toBe(
      "Main deck\n2x Bolt ^Keeper,#4aab08^\n1x Bolt ^Cut,#d3202a^\n",
    );
    expect(formatExport([keeper, cut], "archidekt", ["quantity", "name"])).toBe(
      "Main deck\n3x Bolt\n",
    );
  });
});

/**
 * **A fold may only merge rows the file itself cannot tell apart.** `fields` is what the reader
 * switched on, but a format's own structure — which section a line lands under, whether a
 * bracket carries `{noDeck}` — is not something the reader can switch off, and folding on
 * `fields` alone can merge across it. Every card here is deck-shaped (a real `categoryKind`,
 * never `null`), because the bug this section pins only exists where a section is real.
 */
describe("fold discriminators", () => {
  const DECK = "deck" as const;

  it("keeps a printing in Main deck and the same printing in Sideboard as two rows, under their own headings", () => {
    const main = card({ name: "Lightning Bolt", setCode: "LEA", collectorNumber: "161" });
    const side = card({
      name: "Lightning Bolt",
      setCode: "LEA",
      collectorNumber: "161",
      categoryName: "Sideboard",
      categoryKind: "side",
    });

    expect(formatExport([main, side], "arena", defaultFields("arena", DECK))).toBe(
      "Deck\n1 Lightning Bolt (LEA) 161\n\nSideboard\n1 Lightning Bolt (LEA) 161\n",
    );
    expect(formatExport([main, side], "moxfield", defaultFields("moxfield", DECK))).toBe(
      "Deck\n1 Lightning Bolt (LEA) 161\n\nSideboard\n1 Lightning Bolt (LEA) 161\n",
    );
  });

  it("keeps a printing in Main deck and the same printing in Sideboard as two MTGO lines, one SB:", () => {
    const main = card({ name: "Lightning Bolt" });
    const side = card({ name: "Lightning Bolt", categoryName: "Sideboard", categoryKind: "side" });

    expect(formatExport([main, side], "mtgo", defaultFields("mtgo", DECK))).toBe(
      "1 Lightning Bolt\nSB: 1 Lightning Bolt\n",
    );
  });

  it("folds a foil and a regular copy in one category for Arena, which has no finish channel, and keeps them apart in Moxfield, which has one", () => {
    const regular = card({ name: "Lightning Bolt", setCode: "LEA", collectorNumber: "161" });
    const foil = card({
      name: "Lightning Bolt",
      setCode: "LEA",
      collectorNumber: "161",
      finish: "foil",
    });

    expect(formatExport([regular, foil], "arena", defaultFields("arena", DECK))).toBe(
      "Deck\n2 Lightning Bolt (LEA) 161\n",
    );
    expect(formatExport([regular, foil], "moxfield", defaultFields("moxfield", DECK))).toBe(
      "Deck\n1 Lightning Bolt (LEA) 161\n1 Lightning Bolt (LEA) 161 *F*\n",
    );
  });

  it("keeps a switched-on and a switched-off row of one pile as two Archidekt lines, only one carrying {noDeck}", () => {
    const on = card({ name: "Mox Amber", categoryName: "Ramp" });
    const off = card({ name: "Mox Amber", categoryName: "Ramp", categoryActive: false });

    expect(formatExport([on, off], "archidekt", defaultFields("archidekt", DECK))).toBe(
      "Ramp\n1x Mox Amber (ltc) 285 [Ramp]\n1x Mox Amber (ltc) 285 [Ramp{noDeck}]\n",
    );
  });

  it("keeps two different printings of one card as two Arena rows and folds them to one in plain text, which has no printing channel", () => {
    const lea = card({ name: "Forest", setCode: "LEA", collectorNumber: "1" });
    const unf = card({ name: "Forest", setCode: "UNF", collectorNumber: "239" });

    expect(formatExport([lea, unf], "arena", defaultFields("arena", DECK))).toBe(
      "Deck\n1 Forest (LEA) 1\n1 Forest (UNF) 239\n",
    );
    expect(formatExport([lea, unf], "plain", defaultFields("plain", DECK))).toBe("2 Forest\n");
  });
});
