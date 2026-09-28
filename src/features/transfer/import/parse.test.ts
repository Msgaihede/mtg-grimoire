import { describe, expect, it } from "vitest";
import FORMULA_CELLS_CSV from "../__golden__/formulaCells.csv.all.txt?raw";
import { parseDecklist } from "./parse";
import {
  ARCHIDEKT_FLAT,
  ARCHIDEKT_LABELLED,
  ARCHIDEKT_SECTIONED,
  ARENA_LIST,
  EMPTY_HINT_LIST,
  MOXFIELD_LIST,
  MTGO_LIST,
  REFERENCE_LIST,
} from "./fixtures";

describe("parseDecklist", () => {
  it("reads the reference list whole", () => {
    const out = parseDecklist(REFERENCE_LIST);
    expect(out.issues).toEqual([]);
    expect(out.lines).toHaveLength(105);
    expect(out.totalCards).toBe(117);
    expect(out.lines.every((l) => l.section === "deck")).toBe(true);
  });

  it("keeps a `//` split name whole", () => {
    const out = parseDecklist(REFERENCE_LIST);
    const split = out.lines.filter((l) => l.name.includes(" // "));
    expect(split).toHaveLength(7);
    expect(split.map((l) => l.name)).toContain("Branchloft Pathway // Boulderloft Pathway");
    expect(split.map((l) => l.name)).toContain("Kolvori, God of Kinship // The Ringhart Crest");
  });

  it("reads a comment only when the slashes open the line", () => {
    const out = parseDecklist("// my deck\n#notes\n1 Fire // Ice");
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].name).toBe("Fire // Ice");
  });

  it("takes a count with or without an x, and defaults to one", () => {
    const out = parseDecklist("4 Bolt\n4x Shock\n2 X Marks the Spot\nSol Ring");
    expect(out.lines.map((l) => [l.quantity, l.name])).toEqual([
      [4, "Bolt"],
      [4, "Shock"],
      [2, "X Marks the Spot"],
      [1, "Sol Ring"],
    ]);
  });

  /** The pair is a real one — `ltc` 284 *is* Sol Ring — for `MOXFIELD_LIST`'s reason: a made-up
   *  hint in this repo teaches a false shape even where only the parsing is under test. (`ltc`
   *  285 is Talisman of Conviction, which is what this line used to say.) */
  it("takes a printing hint and uppercases the set", () => {
    const out = parseDecklist("1 Sol Ring (ltc) 284\n1 Arcane Signet (eld)");
    expect(out.lines[0]).toMatchObject({ setCode: "LTC", collectorNumber: "284" });
    expect(out.lines[1]).toMatchObject({ setCode: "ELD", collectorNumber: null });
  });

  it("keeps a collector number that is not a number", () => {
    const out = parseDecklist("1 Sol Ring (SLD) 123★\n1 Shock (PLST) A-45");
    expect(out.lines.map((l) => l.collectorNumber)).toEqual(["123★", "A-45"]);
  });

  it("does not mistake parentheses inside a name for a hint", () => {
    const out = parseDecklist("1 Erase (Not the Urza's Legacy One)");
    expect(out.lines[0].name).toBe("Erase (Not the Urza's Legacy One)");
    expect(out.lines[0].setCode).toBeNull();
  });

  it("switches section on a header, however it is spelled", () => {
    const out = parseDecklist(MOXFIELD_LIST);
    const bySection = (s: string) => out.lines.filter((l) => l.section === s).map((l) => l.name);
    expect(bySection("commander")).toEqual(["Captain Sisay"]);
    expect(bySection("sideboard")).toEqual(["Path to Exile"]);
    expect(bySection("deck")).toEqual(["Captain Sisay", "Sol Ring", "Arcane Signet", "Forest"]);
  });

  it("reads every header spelling", () => {
    for (const [header, section] of [
      ["Deck", "deck"],
      ["Deck (99)", "deck"],
      ["Mainboard", "deck"],
      ["Main Deck", "deck"],
      ["Commander", "commander"],
      ["Commander (1)", "commander"],
      ["COMMANDERS", "commander"],
      ["Sideboard", "sideboard"],
      ["Sideboard: ", "sideboard"],
      ["SB", "sideboard"],
      ["Companion", "companion"],
      ["Maybeboard", "maybeboard"],
      ["Considering", "maybeboard"],
    ] as const) {
      const out = parseDecklist(`${header}\n1 Sol Ring`);
      expect(out.lines[0].section, header).toBe(section);
    }
  });

  it("takes an SB: prefix as a one-line override", () => {
    const out = parseDecklist(MTGO_LIST);
    expect(out.lines.filter((l) => l.section === "sideboard").map((l) => l.name)).toEqual([
      "Duress",
      "Path to Exile",
    ]);
    expect(out.lines.filter((l) => l.section === "deck")).toHaveLength(2);
  });

  it("does not end a section on a blank line", () => {
    const out = parseDecklist("Sideboard\n\n1 Duress");
    expect(out.lines[0].section).toBe("sideboard");
  });

  it("reads Arena's About block for a name and imports nothing from it", () => {
    const out = parseDecklist(ARENA_LIST);
    expect(out.suggestedName).toBe("Bant Ramp");
    expect(out.lines.map((l) => l.name)).toEqual(["Llanowar Elves", "Lightning Bolt", "Duress"]);
  });

  it("strips a foil marker and a trailing hashtag off the name", () => {
    const out = parseDecklist("1 Sol Ring *F*\n1 Shock [Foil]\n1 Bolt #Removal");
    expect(out.lines.map((l) => l.name)).toEqual(["Sol Ring", "Shock", "Bolt"]);
  });

  it("strips every marker on a line, not just the last one", () => {
    // The marker patterns are all anchored to the end, so `*F*` is only reachable once
    // `#Ramp` has gone — which makes the strip a loop rather than a pass. One pass leaves
    // `Sol Ring *F*`, a name nothing resolves, and the test above cannot see it because each
    // of its lines carries exactly one marker.
    const out = parseDecklist("1 Sol Ring *F* #Ramp\n2 Shock *E* [Foil]");
    expect(out.lines.map((l) => l.name)).toEqual(["Sol Ring", "Shock"]);
  });

  it("survives CRLF and a byte-order mark", () => {
    // `\uFEFF` rather than a pasted BOM. The character is the same either way; the escape is
    // the only form the next reader can see, and a literal one is exactly the kind of
    // invisible thing a reformat or a copy-paste silently eats — taking the test with it.
    const out = parseDecklist("\uFEFF1 Sol Ring\r\n2 Shock\r\n");
    expect(out.lines.map((l) => l.name)).toEqual(["Sol Ring", "Shock"]);
  });

  it("splits on a lone carriage return", () => {
    // `/\r?\n/` \u2014 the obvious splitter \u2014 reads a CR-only paste as one enormous line that
    // matches nothing, so the entire decklist comes back as a single issue. Measured before
    // the fix: 0 lines, 1 issue quoting the whole text.
    const out = parseDecklist("1 Sol Ring\r2 Shock");
    expect(out.issues).toEqual([]);
    expect(out.lines.map((l) => [l.quantity, l.name])).toEqual([
      [1, "Sol Ring"],
      [2, "Shock"],
    ]);
  });

  it("quotes a line it cannot read instead of dropping it", () => {
    const out = parseDecklist("1 Sol Ring\n???\n2 Shock");
    expect(out.lines).toHaveLength(3); // "???" is a nameable card as far as this parser knows
    const junk = parseDecklist("1 Sol Ring\n0 Shock");
    expect(junk.issues).toEqual([
      { lineNumber: 2, raw: "0 Shock", reason: "A count of zero is not an import." },
    ]);
    expect(junk.lines).toHaveLength(1);
  });

  it("reads an empty printing hint as no set and keeps the collector number", () => {
    const { lines } = parseDecklist("1 Aerith, Last Ancient () 76");
    expect(lines[0]).toMatchObject({
      name: "Aerith, Last Ancient",
      setCode: null,
      collectorNumber: "76",
      quantity: 1,
    });
  });

  it("still refuses to read a parenthesised phrase as a set", () => {
    // The hint is anchored to the end and a set code holds no spaces, so widening the count to
    // zero cannot make this one match.
    const { lines } = parseDecklist("1 Erase (Not the Urza's Legacy One)");
    expect(lines[0]).toMatchObject({ name: "Erase (Not the Urza's Legacy One)", setCode: null });
  });

  it("strips an Archidekt label whose hash follows a comma", () => {
    // `MARKERS`' `#` arm needs whitespace in front of the hash; this one has a comma, which is
    // why the whole tail used to stay inside the name.
    const { lines } = parseDecklist("1x Sol Ring (fic) 358 [Ramp] ^Keeper,#4aab08^");
    expect(lines[0]).toMatchObject({ name: "Sol Ring", setCode: "FIC", collectorNumber: "358" });
  });

  it("strips a label whose own text has spaces and parentheses", () => {
    const { lines } = parseDecklist(
      "1x Mona Lisa, Science Geek (tmt) 123 ^Fence (flavor),#fa890d^",
    );
    expect(lines[0]!.name).toBe("Mona Lisa, Science Geek");
  });

  it("reads an Archidekt label's name and colour, not just strips them", () => {
    const { lines } = parseDecklist("1x Sol Ring (fic) 358 [Ramp] ^Keeper,#4aab08^");
    expect(lines[0]).toMatchObject({ labelName: "Keeper", labelColor: "#4aab08" });
  });

  it("splits a label at its LAST comma, so a comma in the name survives", () => {
    // `/^([^,]+),(#.+)$/` — the obvious spelling — would answer `Cut` here and lose the rest.
    const { lines } = parseDecklist("1x Sol Ring ^Cut, maybe,#d00dfa^");
    expect(lines[0]).toMatchObject({ labelName: "Cut, maybe", labelColor: "#d00dfa" });
  });

  it("keeps the name when the group carries no colour", () => {
    // Not a shape Archidekt writes; a hand-edited list is what this parser exists to keep
    // reading, and a label with no colour is still a label.
    const { lines } = parseDecklist("1x Sol Ring ^Keeper^");
    expect(lines[0]).toMatchObject({ labelName: "Keeper", labelColor: null });
  });

  it("reads a tail that is not a hex as part of the name", () => {
    const { lines } = parseDecklist("1x Sol Ring ^Buy, later^");
    expect(lines[0]).toMatchObject({ labelName: "Buy, later", labelColor: null });
  });

  it("expands a three-digit colour, so one colour has one spelling", () => {
    const { lines } = parseDecklist("1x Sol Ring ^Keeper,#F00^");
    expect(lines[0]!.labelColor).toBe("#ff0000");
  });

  it("carries no label on a line that has none, and on every other format", () => {
    expect(parseDecklist("1x Sol Ring (fic) 358 [Ramp]").lines[0]).toMatchObject({
      labelName: null,
      labelColor: null,
    });
    expect(parseDecklist(ARENA_LIST).lines.every((l) => l.labelName === null)).toBe(true);
  });

  it("keeps the rightmost label when a line writes two", () => {
    // `deck_cards.label_id` holds one label, so a choice has to be made; the nearer naming is the
    // one on the line, exactly as it is for the bracket.
    const { lines } = parseDecklist("1x Sol Ring ^Fence,#fffc19^ ^Keeper,#4aab08^");
    expect(lines[0]).toMatchObject({ name: "Sol Ring", labelName: "Keeper" });
  });

  it("reads the labelled export's five distinct labels, on the right lines", () => {
    const { lines, issues, totalCards } = parseDecklist(ARCHIDEKT_LABELLED);
    expect(issues).toEqual([]);
    expect(lines).toHaveLength(19);
    expect(totalCards).toBe(46);
    const labelled = lines.filter((l) => l.labelName !== null);
    expect(labelled).toHaveLength(13);
    expect([...new Set(labelled.map((l) => `${l.labelName}${l.labelColor}`))]).toEqual([
      "Keeper#4aab08",
      "Fence#fffc19",
      "Replace Art#d00dfa",
      "Getting#2ccce4",
      "Fence (flavor)#fa890d",
    ]);
    // The commander line keeps its label through the bracket and the `*F*` beside it.
    expect(lines[0]).toMatchObject({
      name: "Bruna, the Fading Light",
      section: "commander",
      finish: "foil",
      labelName: "Keeper",
    });
    // And a `{noDeck}` line does too: a pile that counts toward nothing still holds labelled
    // cards.
    const arkenstone = lines.find((l) => l.name.startsWith("The Arkenstone"));
    expect(arkenstone).toMatchObject({ excluded: true, labelName: "Getting" });
  });

  it("reads a bracket as the line's category", () => {
    const { lines } = parseDecklist("1x Gandalf the White (ltr) 305 [Flash Enabler]");
    expect(lines[0]).toMatchObject({ name: "Gandalf the White", categoryName: "Flash Enabler" });
  });

  it("takes the first bracket entry and drops its flags", () => {
    const { lines } = parseDecklist(
      "1x Lush Portico (mkm) 263 [Land,Maybe (New){noDeck}{noPrice}]",
    );
    // The first entry is the pile the card is in; a `{noDeck}` on a *later* entry says only that
    // the card is also filed in some maybeboard.
    expect(lines[0]).toMatchObject({ categoryName: "Land", excluded: false });
  });

  it("marks a line excluded when its first bracket entry says noDeck", () => {
    const { lines } = parseDecklist(
      "1x Aerith Gainsborough (fin) 4 [(New) Maybeboard{noDeck}{noPrice},Creature]",
    );
    expect(lines[0]).toMatchObject({ categoryName: "(New) Maybeboard", excluded: true });
  });

  it("reads a bracket naming a known section as that section, not as a category", () => {
    // `[Commander{top}]` has to reach the command zone through the one mechanism the four seeded
    // piles already use, not through a second one.
    const commander = parseDecklist(
      "1x Serah Farron // Crystallized Serah (fin) 506 [Commander{top}]",
    );
    expect(commander.lines[0]).toMatchObject({
      name: "Serah Farron // Crystallized Serah",
      section: "commander",
      categoryName: null,
    });
    const maybe = parseDecklist("1x Tataru Taru (fic) 30 [Maybeboard{noDeck}{noPrice},Creature]");
    expect(maybe.lines[0]).toMatchObject({
      section: "maybeboard",
      categoryName: null,
      excluded: true,
    });
  });

  it("treats a finish word in a bracket as decoration and never as a pile", () => {
    const { lines } = parseDecklist("1 Sol Ring [Foil]");
    expect(lines[0]).toMatchObject({ name: "Sol Ring", categoryName: null });
  });

  it("peels a bracket, a foil marker and a label off one line", () => {
    const { lines } = parseDecklist(
      "1x Skrelv, Defector Mite (one) 33 *F* [Protection] ^Keeper,#4aab08^",
    );
    expect(lines[0]).toMatchObject({
      name: "Skrelv, Defector Mite",
      setCode: "ONE",
      collectorNumber: "33",
      categoryName: "Protection",
    });
  });

  it("reads the flat Archidekt export whole", () => {
    const { lines, issues, totalCards } = parseDecklist(ARCHIDEKT_FLAT);
    expect(issues).toEqual([]);
    expect(lines).toHaveLength(88);
    expect(totalCards).toBe(100);
    // 12 distinct first-bracket names, one of which is `Commander` — a section word, so it sets
    // the section and leaves this line's name `null`, which is why the count of *names* is 11.
    expect(new Set(lines.map((l) => l.categoryName).filter((n) => n !== null)).size).toBe(11);
    // Every line but the commander's names a category; the commander's names a section.
    expect(lines.filter((l) => l.categoryName === null)).toHaveLength(1);
    expect(lines.filter((l) => l.section === "commander")).toHaveLength(1);
    expect(lines.filter((l) => l.excluded)).toHaveLength(0);
  });

  it("reads the empty-hint export whole", () => {
    const { lines, issues, totalCards } = parseDecklist(EMPTY_HINT_LIST);
    expect(issues).toEqual([]);
    expect(lines).toHaveLength(88);
    expect(totalCards).toBe(100);
    expect(lines.filter((l) => l.setCode === null)).toHaveLength(33);
    expect(lines.every((l) => l.collectorNumber !== null)).toBe(true);
  });

  it("reads an unknown heading as the pile its cards are in", () => {
    const { lines, issues } = parseDecklist("Flash Enabler\n\n\nRamp\n1x Sol Ring (fic) 358");
    expect(issues).toEqual([]);
    // Only the second is a heading: the first is followed by a blank and then a line with no
    // quantity, so the lookahead refuses it.
    expect(lines.map((l) => l.name)).toEqual(["Flash Enabler", "Sol Ring"]);
  });

  it("opens a section on an unknown heading and closes it on the next", () => {
    const { lines } = parseDecklist(
      "Deck\n1 Sol Ring\n\nRamp\n1 Arcane Signet\n\nRemoval\n1 Path to Exile",
    );
    expect(lines.map((l) => [l.name, l.categoryName])).toEqual([
      ["Sol Ring", null],
      ["Arcane Signet", "Ramp"],
      ["Path to Exile", "Removal"],
    ]);
  });

  it("puts an unknown heading back in the deck proper", () => {
    // A `Ramp` heading after `Commander` is a pile, not still the command zone — which is the
    // whole of why the heading arm assigns `section` as well as the name.
    const { lines } = parseDecklist("Commander\n1 Captain Sisay\n\nRamp\n1 Sol Ring");
    expect(lines.map((l) => [l.section, l.categoryName])).toEqual([
      ["commander", null],
      ["deck", "Ramp"],
    ]);
  });

  it("leaves a list of bare names alone", () => {
    // The lookahead is what does this: `Sol Ring` is followed by a line with no quantity, so it
    // is a card and not a heading.
    const { lines } = parseDecklist("Sol Ring\nArcane Signet\nPath to Exile");
    expect(lines.map((l) => l.name)).toEqual(["Sol Ring", "Arcane Signet", "Path to Exile"]);
  });

  it("does not eat the first card of a hand-written list that mixes counts in", () => {
    const { lines } = parseDecklist("Sol Ring\n4 Shock\n2 Duress");
    expect(lines.map((l) => l.name)).toEqual(["Sol Ring", "Shock", "Duress"]);
  });

  it("reads an unknown heading on the first line only when the cards carry brackets", () => {
    // An Archidekt deck with no commander opens on a category heading with nothing above it, and
    // Archidekt writes a bracket on every line — which is what tells it from the list above.
    const archidekt = parseDecklist("Anthem\n1x Day of Destiny (dmc) 99 [Anthem]");
    expect(archidekt.lines.map((l) => l.name)).toEqual(["Day of Destiny"]);
    const handwritten = parseDecklist("Anthem\n4 Shock");
    expect(handwritten.lines.map((l) => l.name)).toEqual(["Anthem", "Shock"]);
  });

  it("never lets a heading open a section with no cards in it", () => {
    // The lookahead requires a counted line *after* the candidate, so a heading with nothing
    // under it has nothing to open: it stays a card line and is resolved or quoted rather than
    // silently swallowed. `Ramp` opens a section here — the bracket on the line below is what
    // admits a heading on the first row — and `Removal`, at the foot of the text, does not.
    const { lines } = parseDecklist("Ramp\n1x Sol Ring (fic) 358 [Ramp]\n\nRemoval");
    expect(lines.map((l) => l.name)).toEqual(["Sol Ring", "Removal"]);
  });

  it("reads the sectioned Archidekt export whole", () => {
    const { lines, issues, totalCards } = parseDecklist(ARCHIDEKT_SECTIONED);
    expect(issues).toEqual([]);
    expect(lines).toHaveLength(105);
    expect(totalCards).toBe(117);
    expect(lines.filter((l) => l.excluded)).toHaveLength(17);
    expect(lines.filter((l) => l.section === "commander")).toHaveLength(1);
    // The 10 cards under the `Maybeboard` heading reach the seeded pile through the section, so
    // they carry no free-form name; the 7 under `(New) Maybeboard` do.
    expect(lines.filter((l) => l.section === "maybeboard")).toHaveLength(10);
    expect(lines.filter((l) => l.categoryName === "(New) Maybeboard")).toHaveLength(7);
  });

  it("agrees with the flat export about the same deck", () => {
    const sectioned = parseDecklist(ARCHIDEKT_SECTIONED);
    const flat = parseDecklist(ARCHIDEKT_FLAT);
    const counted = (l: { excluded: boolean }) => !l.excluded;
    expect(sectioned.lines.filter(counted)).toHaveLength(flat.lines.length);
    expect(sectioned.lines.filter(counted).reduce((n, l) => n + l.quantity, 0)).toBe(
      flat.totalCards,
    );
  });

  it("is empty for empty input", () => {
    expect(parseDecklist("")).toEqual({
      lines: [],
      issues: [],
      totalCards: 0,
      suggestedName: null,
    });
  });
});

describe("the format fixtures", () => {
  const rowsOf = (text: string) => text.split("\n");
  const cardish = (text: string) => rowsOf(text).filter((r) => /^\d{1,4}x?\s/.test(r.trim()));
  const copies = (text: string) =>
    cardish(text).reduce((n, r) => n + Number(/^(\d{1,4})/.exec(r.trim())![1]), 0);

  it("holds three exports of one deck, counted", () => {
    expect(rowsOf(ARCHIDEKT_SECTIONED).length).toBe(132);
    expect(cardish(ARCHIDEKT_SECTIONED).length).toBe(105);
    expect(copies(ARCHIDEKT_SECTIONED)).toBe(117);

    expect(cardish(ARCHIDEKT_FLAT).length).toBe(88);
    expect(copies(ARCHIDEKT_FLAT)).toBe(100);

    expect(cardish(EMPTY_HINT_LIST).length).toBe(88);
    expect(copies(EMPTY_HINT_LIST)).toBe(100);
  });

  it("is the reference list's deck, so the two fixtures check each other", () => {
    // 105 lines and 117 copies in both, which is what makes a mistyped fixture visible.
    expect(cardish(REFERENCE_LIST).length).toBe(cardish(ARCHIDEKT_SECTIONED).length);
    expect(copies(REFERENCE_LIST)).toBe(copies(ARCHIDEKT_SECTIONED));
  });

  it("is the sectioned list less its 17 {noDeck} cards", () => {
    const noDeckFirst = cardish(ARCHIDEKT_SECTIONED).filter((r) => {
      const bracket = /\[([^\]]+)\]/.exec(r);
      return bracket !== null && bracket[1].split(",")[0].includes("{noDeck}");
    });
    expect(noDeckFirst.length).toBe(17);
    expect(cardish(ARCHIDEKT_SECTIONED).length - noDeckFirst.length).toBe(88);
    expect(copies(ARCHIDEKT_SECTIONED) - noDeckFirst.length).toBe(100);
  });

  it("counts the decorations each fixture exists to exercise", () => {
    const count = (text: string, re: RegExp) => cardish(text).filter((r) => re.test(r)).length;
    expect(count(ARCHIDEKT_SECTIONED, /\^[^^]*\^\s*$/)).toBe(44);
    expect(count(ARCHIDEKT_SECTIONED, /\s\*[A-Z]\*[\s]/)).toBe(3);
    expect(count(ARCHIDEKT_SECTIONED, / \/\/ /)).toBe(7);
    expect(count(ARCHIDEKT_FLAT, /\^[^^]*\^\s*$/)).toBe(43);
    expect(count(EMPTY_HINT_LIST, /\(\)\s/)).toBe(33);
    expect(count(EMPTY_HINT_LIST, / \/\/ /)).toBe(0);
  });
});

describe("a CSV", () => {
  it("is recognised by its header row and read by column", () => {
    const list = parseDecklist("Quantity,Name,Set,Collector number\n2,Lightning Bolt,LEA,161\n");
    expect(list.lines).toHaveLength(1);
    expect(list.lines[0]).toMatchObject({
      quantity: 2,
      name: "Lightning Bolt",
      setCode: "LEA",
      collectorNumber: "161",
    });
  });

  it("carries the columns no decklist format has, for a destination that wants them", () => {
    const list = parseDecklist("Quantity,Name,Condition,Purchase price\n1,Sol Ring,LP,2.5\n");
    expect(list.lines[0].extra).toMatchObject({ condition: "LP", purchasePrice: "2.5" });
  });

  it("matches a header regardless of case and surrounding space", () => {
    const list = parseDecklist(" quantity , NAME \n3,Forest\n");
    expect(list.lines[0]).toMatchObject({ quantity: 3, name: "Forest" });
  });

  it("ignores a column it does not know, rather than refusing the file", () => {
    const list = parseDecklist("Quantity,Name,Scryfall ID\n1,Sol Ring,abc-123\n");
    expect(list.lines).toHaveLength(1);
    expect(list.issues).toHaveLength(0);
  });

  it("refuses a file with no name column, in one sentence rather than 400", () => {
    const list = parseDecklist("Quantity,Set\n1,LEA\n2,LTC\n");
    expect(list.lines).toHaveLength(0);
    expect(list.issues).toHaveLength(1);
    expect(list.issues[0].reason).toMatch(/name/i);
  });

  it("reads the finish column as the marker every other format spells *F*", () => {
    const list = parseDecklist("Quantity,Name,Finish\n1,Sol Ring,foil\n");
    expect(list.lines[0].finish).toBe("foil");
  });

  /** A CSV says a label in two columns where Archidekt says it in one group — and both are
   *  read, because a column this app writes and cannot read back loses something silently. */
  it("reads the label out of its own two columns", () => {
    const list = parseDecklist("Quantity,Name,Label,Label colour\n1,Sol Ring,Keeper,#4aab08\n");
    expect(list.lines[0]).toMatchObject({ labelName: "Keeper", labelColor: "#4aab08" });
  });

  it("takes a colour cell with or without its hash, and expands a short one", () => {
    // Looser than the `^…^` arm on purpose: inside a caret group the hash is what tells the
    // colour from the name, and a column has nothing to disambiguate from.
    const bare = parseDecklist("Quantity,Name,Label,Label colour\n1,Sol Ring,Keeper,4aab08\n");
    expect(bare.lines[0].labelColor).toBe("#4aab08");
    const short = parseDecklist("Quantity,Name,Label,Label colour\n1,Sol Ring,Keeper,#F00\n");
    expect(short.lines[0].labelColor).toBe("#ff0000");
  });

  it("keeps the label when the colour cell is empty or unreadable", () => {
    const blank = parseDecklist("Quantity,Name,Label,Label colour\n1,Sol Ring,Keeper,\n");
    expect(blank.lines[0]).toMatchObject({ labelName: "Keeper", labelColor: null });
    const junk = parseDecklist("Quantity,Name,Label,Label colour\n1,Sol Ring,Keeper,greenish\n");
    expect(junk.lines[0]).toMatchObject({ labelName: "Keeper", labelColor: null });
  });

  /**
   * **A deck CSV an older build wrote still reads its labels back.** That build's columns said
   * `Tag` and `Tag colour`; the registry's say `Label` and `Label colour`, so without
   * `LEGACY_CSV_HEADERS` those two columns would map to nothing at all — the cards would come
   * back and the labels would silently not, which is the one thing a round trip may never do.
   *
   * The second parse is the same file shouted, because the alias goes through `normalizeHeader`
   * like every other header and is not a second matching rule.
   */
  it("still reads a label out of an older build's Tag columns", () => {
    const list = parseDecklist("Quantity,Name,Tag,Tag colour\n1,Sol Ring,Keeper,#4aab08\n");
    expect(list.lines[0]).toMatchObject({ labelName: "Keeper", labelColor: "#4aab08" });

    const shouted = parseDecklist("Quantity,Name,TAG,TAG COLOUR\n1,Sol Ring,Keeper,#4aab08\n");
    expect(shouted.lines[0]).toMatchObject({ labelName: "Keeper", labelColor: "#4aab08" });
  });

  /** `Label` and the collection's `Tags` are two different columns for two different facts, and
   *  `HEADER_TO_FIELD` matches the whole header — so neither can be read as the other. **Nor can
   *  the `Tag` alias reach this one**: `normalizeHeader` lowercases and collapses whitespace and
   *  does nothing else, so `tag` and `tags` are two keys and the alias shadows nothing. */
  it("does not read the collection's Tags column as a deck label", () => {
    const list = parseDecklist("Quantity,Name,Tags\n1,Sol Ring,traded from Ada\n");
    expect(list.lines[0].labelName).toBeNull();
    expect(list.lines[0].extra).toMatchObject({ tags: "traded from Ada" });
  });

  it("leaves a list whose first line is not a header exactly as it was", () => {
    // The one file-level judgement this parser makes, and it is made on the header alone.
    const list = parseDecklist("2 Lightning Bolt\n1 Sol Ring\n");
    expect(list.lines.map((l) => l.name)).toEqual(["Lightning Bolt", "Sol Ring"]);
  });

  it("does not mistake a one-column list for a header", () => {
    // `Name` alone maps to one known header; two are required, one of which is the name.
    const list = parseDecklist("Name\nSol Ring\n");
    expect(list.lines.map((l) => l.name)).toEqual(["Name", "Sol Ring"]);
  });

  it("sets the section rather than a category name for a bracket-style pile word", () => {
    // parse.ts's own correction: `Sideboard` in a Category column names one of the four seeded
    // zones, so it must set `section`, not become a category called "Sideboard".
    const list = parseDecklist("Quantity,Name,Category\n1,Path to Exile,Sideboard\n");
    expect(list.lines[0]).toMatchObject({ section: "sideboard", categoryName: null });
  });

  it("keeps a free-form category name in the deck section", () => {
    const list = parseDecklist("Quantity,Name,Category\n1,Sol Ring,Ramp\n");
    expect(list.lines[0]).toMatchObject({ section: "deck", categoryName: "Ramp" });
  });

  it("does not mistake a plain list's first line for a header when the data row's shape disagrees", () => {
    // `parseCsv` splits "Quantity, Name" into two cells that both name a known column — quantity
    // and name — which is enough to satisfy `csvHeaderOf` on its own. What tells the two apart is
    // shape: a real CSV's first data row has the same field count as its header, and "1 Sol Ring"
    // is one field against the header's two. Read as a plain list instead: a card called
    // "Quantity, Name" (one word with a comma in it, same as any other decklist line this parser
    // has never split on a comma) and then Sol Ring.
    const list = parseDecklist("Quantity, Name\n1 Sol Ring\n");
    expect(list.lines.map((l) => [l.quantity, l.name])).toEqual([
      [1, "Quantity, Name"],
      [1, "Sol Ring"],
    ]);
    expect(list.issues).toEqual([]);

    // The no-space variant reads identically — the space around the comma is not what matters.
    // The per-line reader never splits on a comma at all, so the whole first line is one name.
    const tight = parseDecklist("Quantity,Name\n1 Sol Ring\n");
    expect(tight.lines.map((l) => [l.quantity, l.name])).toEqual([
      [1, "Quantity,Name"],
      [1, "Sol Ring"],
    ]);
  });

  it("reads a header with no data rows as an empty import, not as a card", () => {
    const list = parseDecklist("Quantity,Name");
    expect(list.lines).toEqual([]);
    expect(list.issues).toEqual([]);
    expect(list.totalCards).toBe(0);
  });

  /** The same guard with Excel's EU separator: the header line votes for `;`, the row under it
   *  is one cell against two, and the shapes disagree exactly as they do for the comma. */
  it("keeps the shape guard for a semicolon line over a decklist", () => {
    const list = parseDecklist("Quantity; Name\n1 Sol Ring\n");
    expect(list.lines.map((l) => [l.quantity, l.name])).toEqual([
      [1, "Quantity; Name"],
      [1, "Sol Ring"],
    ]);
    expect(list.csv).toBeUndefined();
  });

  /** A tab-separated decklist with no header is still a decklist — the tab is the `\s` the
   *  line grammar already reads after a count. */
  it("reads a headerless tab-separated list line by line, as it always did", () => {
    const list = parseDecklist("4\tLightning Bolt\n2\tShock\n");
    expect(list.lines.map((l) => [l.quantity, l.name])).toEqual([
      [4, "Lightning Bolt"],
      [2, "Shock"],
    ]);
    expect(list.csv).toBeUndefined();
  });

  it("says nothing about a CSV shape for a decklist, or for a file it would not read", () => {
    expect(parseDecklist("4 Lightning Bolt").csv).toBeUndefined();
    expect(parseDecklist("Quantity,Set\n1,LEA\n").csv).toBeUndefined();
  });
});

/**
 * Other apps' collection exports (issue #555). Each fixture is **cut from a real export** — the
 * header row verbatim and the data rows real rows from it, a handful rather than all forty — taken
 * from the sample exports `StepKie/MtgCsvHelper` keeps under `Resources/SampleCsvs` and checked
 * against the research doc's verbatim header lists on 2026-09-28. A made-up header teaches the
 * parser a spelling nobody writes.
 */
const DECKBOX_EXPORT = `Count,Tradelist Count,Name,Edition,Edition Code,Card Number,Condition,Language,Foil,Signed,Artist Proof,Altered Art,Misprint,Promo,Textless,Printing Id,Printing Note,Tags,My Price,Cost,Rarity,Price,TcgPlayer ID,Scryfall ID
1,0,"Aragorn, the Uniter",The Lord of the Rings: Tales of Middle-earth,ltr,741,Near Mint,English,foil,,,,,,,85601,,"",$0.00,{R}{G}{W}{U},MythicRare,$85.08,517446,5f092adf-a06e-47c1-9400-2eebf9ef719d
1,0,Brazen Borrower // Petty Theft,Throne of Eldraine,eld,39,Near Mint,English,,,,,,,,46095,,"",$0.00,{1}{U}{U} // {1}{U},MythicRare,$3.94,199387,c2089ec9-0665-448f-bfe9-d181de127814
1,0,Lightning Bolt,Magic 2011,m11,149,Good (Lightly Played),English,,,,,,,,17427,,"",$0.00,{R},Common,$1.54,35427,e768c957-3a1f-42f5-853a-96942f645df5
2,0,Lightning Bolt,Magic 2011,m11,149,Heavily Played,English,,,,,,,,17427,,"",$0.00,{R},Common,$1.54,35427,e768c957-3a1f-42f5-853a-96942f645df5
`;

const MOXFIELD_EXPORT = `"Count","Tradelist Count","Name","Edition","Condition","Language","Foil","Tags","Last Modified","Collector Number","Alter","Proxy","Purchase Price"
"1","1","Aragorn, the Uniter","ltr","Near Mint","English","foil","","2026-05-15 13:52:30.943000","741z","False","False",""
"1","1","Aragorn, the Uniter","ltr","Near Mint","English","","","2026-05-15 13:51:43.373000","192","False","False","12.00"
"1","1","Demonic Tutor","cmm","Near Mint","English","etched","","2026-05-15 13:51:43.373000","509","False","False","40.00"
"1","1","Lightning Bolt","m11","Played","English","","","2026-05-15 13:51:43.373000","149","False","False","0.20"
`;

/** CRLF on purpose: the research doc records that Dragon Shield's own import requires it. */
const DRAGON_SHIELD_EXPORT = [
  '"sep=,"',
  "Folder Name,Quantity,Trade Quantity,Card Name,Set Code,Set Name,Card Number,Condition,Printing,Language,Price Bought,Date Bought,LOW,MID,MARKET",
  'Test,1,1,"Aragorn, the Uniter",LTR,The Lord of the Rings: Tales of Middle-earth,741z,NearMint,Double Rainbow Foil,English,0.00,2026-05-15,,,',
  "Test,1,1,Disciplined Duelist,SNC,Streets of New Capenna,369,NearMint,Gilded Foil,English,0.00,2026-05-15,0.09,0.40,0.32",
  "Test,1,1,Lightning Bolt,M11,Magic 2011,149,Played,Normal,English,0.00,2026-05-15,0.97,1.55,1.50",
  "",
].join("\r\n");

const MANABOX_EXPORT = `Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency
"Aragorn, the Uniter",LTR,The Lord of the Rings: Tales of Middle-earth,741z,foil,mythic,1,89216,9d481911-48a9-4cd7-a3b4-14c058dcac19,4599.99,false,false,near_mint,en,USD
Brazen Borrower // Petty Theft,ELD,Throne of Eldraine,39,normal,mythic,1,46299,c2089ec9-0665-448f-bfe9-d181de127814,1.5,false,false,near_mint,en,USD
`;

/** TCGplayer's `Name` is the product's title; 111 of the real export's 1,010 rows carry a
 *  treatment in it, and `Simple Name` beside it is the card. */
const TCGPLAYER_EXPORT = `Quantity,Name,Simple Name,Set,Card Number,Set Code,Printing,Condition,Language,Rarity,Product ID,SKU
1,Abuelo's Awakening,Abuelo's Awakening,The Lost Caverns of Ixalan,1,LCI,Normal,Near Mint,English,Rare,526193,7543277
1,Accursed Marauder (Retro Frame),Accursed Marauder,Modern Horizons 3,405,MH3,Normal,Near Mint,English,Common,553206,7958459
1,Herd Migration (DMU Bundle),Herd Migration,Unique and Miscellaneous Promos,429,UMP,Foil,Near Mint,English,Rare,282802,5746441
`;

/** **One cell is not the export's**: the sample holds no premium card, so `Stone Rain`'s
 *  `Premium` is flipped from `No` to `Yes` to give the column something to say. */
const MTGO_EXPORT = `Card Name,Quantity,ID #,Rarity,Set,Collector #,Premium,Sideboarded,Annotation
"Dark Ritual",1,6893,Common,MI,116/350,No,No,0
"Stone Rain",4,7333,Common,MI,194/350,Yes,No,0
`;

describe("a CSV another app wrote", () => {
  it("reads a Deckbox export by its own column names", () => {
    const list = parseDecklist(DECKBOX_EXPORT);
    expect(list.issues).toEqual([]);
    expect(list.lines).toHaveLength(4);
    expect(list.totalCards).toBe(5);
    expect(list.lines[0]).toMatchObject({
      lineNumber: 2,
      quantity: 1,
      name: "Aragorn, the Uniter",
      // `Edition Code`, and never `Edition` — that column is the set's *name* in Deckbox's file.
      setCode: "LTR",
      collectorNumber: "741",
      finish: "foil",
      extra: { condition: "Near Mint", lang: "English", tradelistQuantity: "0" },
    });
    expect(list.lines[1]).toMatchObject({ name: "Brazen Borrower // Petty Theft", finish: null });
    expect(list.lines[3]).toMatchObject({ quantity: 2, extra: { condition: "Heavily Played" } });
    // Nothing in the row went to a price: `My Price` is a Deckbox seller's asking price.
    expect(list.lines[0].extra.purchasePrice).toBeUndefined();
  });

  /** Every column nothing reads is named, in the file's own words and order: the unmapped ones,
   *  the two this app never takes back (`Rarity`, `Price`), and `Edition`, which lost its field
   *  to `Edition Code`. */
  it("lists every Deckbox column it did not read", () => {
    expect(parseDecklist(DECKBOX_EXPORT).csv).toEqual({
      delimiter: ",",
      hasQuantity: true,
      ignoredColumns: [
        "Edition",
        "Artist Proof",
        "Promo",
        "Textless",
        "Printing Id",
        "Printing Note",
        "My Price",
        "Cost",
        "Rarity",
        "Price",
        "TcgPlayer ID",
        "Scryfall ID",
      ],
    });
  });

  it("reads a Moxfield export, every cell quoted, with its finish words", () => {
    const list = parseDecklist(MOXFIELD_EXPORT);
    expect(list.issues).toEqual([]);
    expect(list.lines.map((l) => [l.name, l.setCode, l.collectorNumber, l.finish])).toEqual([
      ["Aragorn, the Uniter", "LTR", "741z", "foil"],
      ["Aragorn, the Uniter", "LTR", "192", null],
      ["Demonic Tutor", "CMM", "509", "etched"],
      ["Lightning Bolt", "M11", "149", null],
    ]);
    expect(list.lines[1].extra).toMatchObject({
      purchasePrice: "12.00",
      altered: "False",
      proxy: "False",
      tradelistQuantity: "1",
      condition: "Near Mint",
    });
    expect(list.csv).toEqual({
      delimiter: ",",
      hasQuantity: true,
      ignoredColumns: ["Last Modified"],
    });
  });

  it("reads a Dragon Shield export past its sep= line, and counts its lines from the top", () => {
    const list = parseDecklist(DRAGON_SHIELD_EXPORT);
    expect(list.issues).toEqual([]);
    expect(list.lines.map((l) => [l.lineNumber, l.name, l.setCode, l.finish])).toEqual([
      [3, "Aragorn, the Uniter", "LTR", "foil"],
      [4, "Disciplined Duelist", "SNC", "foil"],
      [5, "Lightning Bolt", "M11", null],
    ]);
    expect(list.lines[0].extra).toMatchObject({
      tradelistQuantity: "1",
      purchasePrice: "0.00",
      acquiredAt: "2026-05-15",
      condition: "NearMint",
    });
    // A code column exists, so the set's name is read by nothing and says so.
    expect(list.csv?.ignoredColumns).toEqual(["Folder Name", "Set Name", "LOW", "MID", "MARKET"]);
  });

  it("reads a ManaBox export, currency and all", () => {
    const list = parseDecklist(MANABOX_EXPORT);
    expect(list.lines[0]).toMatchObject({
      setCode: "LTR",
      collectorNumber: "741z",
      finish: "foil",
      extra: { purchasePrice: "4599.99", purchaseCurrency: "USD", condition: "near_mint" },
    });
    expect(list.lines[1].finish).toBeNull();
    expect(list.csv?.ignoredColumns).toEqual(["Set name", "Rarity", "ManaBox ID", "Scryfall ID"]);
  });

  /** The two places `SPECIFIC` outranks this app's own spelling: TCGplayer's `Set` is a set's
   *  name with the code beside it, and its `Name` is a product title with the card beside it. */
  it("reads TCGplayer's card and code columns over its title and set name", () => {
    const list = parseDecklist(TCGPLAYER_EXPORT);
    expect(list.lines.map((l) => [l.name, l.setCode, l.collectorNumber, l.finish])).toEqual([
      ["Abuelo's Awakening", "LCI", "1", null],
      ["Accursed Marauder", "MH3", "405", null],
      ["Herd Migration", "UMP", "429", "foil"],
    ]);
    expect(list.csv?.ignoredColumns).toEqual(["Name", "Set", "Rarity", "Product ID", "SKU"]);
  });

  it("reads MTGO's Premium column as the finish", () => {
    const list = parseDecklist(MTGO_EXPORT);
    expect(list.lines.map((l) => [l.name, l.quantity, l.collectorNumber, l.finish])).toEqual([
      ["Dark Ritual", 1, "116/350", null],
      ["Stone Rain", 4, "194/350", "foil"],
    ]);
  });

  /** Only a file with **no** code column lends its set name to the hint, verbatim — a name is not
   *  a code, and the resolver reads a hint that names no set code as a set's name. */
  it("uses a set name as the hint only when the file has no code column", () => {
    const named = parseDecklist("Quantity,Card Name,Set Name\n1,Sol Ring,Commander 2021\n");
    expect(named.lines[0].setCode).toBe("Commander 2021");
    expect(named.csv?.ignoredColumns).toEqual([]);

    const coded = parseDecklist(
      "Quantity,Card Name,Set Code,Set Name\n1,Sol Ring,,Commander 2021\n",
    );
    expect(coded.lines[0].setCode).toBeNull();
    expect(coded.csv?.ignoredColumns).toEqual(["Set Name"]);
  });

  /** Moxfield's `Edition` is a code; with nothing better beside it, it is read as one. */
  it("reads Edition as the set only when no code column outranks it", () => {
    expect(parseDecklist("Count,Name,Edition\n1,Sol Ring,c21\n").lines[0].setCode).toBe("C21");
  });

  it("keeps this app's own header over an alias for the same field", () => {
    const list = parseDecklist("Quantity,Count,Name\n2,5,Lightning Bolt\n");
    expect(list.lines[0].quantity).toBe(2);
    expect(list.csv?.ignoredColumns).toEqual(["Count"]);
  });

  /** The app's own export writes these for a reader's spreadsheet and never takes them back —
   *  the card's rarity, type and price are the corpus's to answer. */
  it("names this app's own write-only columns as not read", () => {
    const list = parseDecklist(
      "Quantity,Name,Set,Set name,Rarity,Type line,Price\n" +
        "1,Sol Ring,LTC,Tales of Middle-earth Commander,Uncommon,Artifact,1.20\n",
    );
    expect(list.csv?.ignoredColumns).toEqual(["Set name", "Rarity", "Type line", "Price"]);
  });

  /** Cardmarket's export is semicolon-separated and names no card at all — the one sentence.
   *  Cut to the real export's first nine columns; the five after them are more `is…` flags. */
  it("refuses Cardmarket's nameless export in one sentence", () => {
    const list = parseDecklist(
      "idProduct;groupCount;price;idLanguage;condition;isFoil;isSigned;isAltered;isPlayset\n" +
        "743311;1;;1;2;1;;;\n715954;1;12.00;1;2;;;;\n",
    );
    expect(list.lines).toEqual([]);
    expect(list.issues).toHaveLength(1);
    expect(list.issues[0]).toMatchObject({ lineNumber: 1, reason: expect.stringMatching(/name/) });
  });
});

describe("a CSV's finish column", () => {
  const finishOf = (cell: string) =>
    parseDecklist(`Quantity,Name,Finish\n1,Sol Ring,${cell}\n`).lines[0].finish;

  it("reads every word for foil as foil, and any treatment named a foil", () => {
    const foil = ["foil", "Foil", "yes", "Y", "TRUE", "1", "x", "Surge Foil", "Gilded Foil"];
    for (const cell of foil) expect(finishOf(cell), cell).toBe("foil");
  });

  /** Asked before foil, because `Foil Etched` and MTGGoldfish's `foil_etched` carry both. */
  it("reads anything etched as etched, before it can read as foil", () => {
    for (const cell of ["etched", "Etched", "Foil Etched", "foil_etched"]) {
      expect(finishOf(cell), cell).toBe("etched");
    }
  });

  /** `nonfoil` and `non-foil` both contain `foil`, which is why these are asked first. */
  it("reads every word for the regular copy as the regular copy", () => {
    const regular = ["", "normal", "Normal", "nonfoil", "non-foil", "regular", "no", "false", "0"];
    for (const cell of regular) expect(finishOf(cell), JSON.stringify(cell)).toBeNull();
  });

  it("reads Foil, Printing and Premium columns by the same words", () => {
    for (const header of ["Foil", "Printing", "Premium"]) {
      const list = parseDecklist(`Quantity,Name,${header}\n1,Sol Ring,Yes\n1,Shock,Normal\n`);
      expect(list.lines.map((l) => l.finish), header).toEqual(["foil", null]);
    }
  });
});

describe("a CSV's quantity column", () => {
  /** `Number.parseInt` read a prefix, so each of these used to import — `1.5` as one copy and
   *  `3 copies` as three — and none of them said anything. */
  it("refuses anything but a whole number from 1 to 9999, with a sentence each", () => {
    const list = parseDecklist(
      "Quantity,Name\n1.5,Sol Ring\n3 copies,Shock\n0,Duress\n12345,Forest\n-1,Island\n+3,Swamp\n",
    );
    expect(list.lines).toEqual([]);
    expect(list.issues.map((i) => [i.lineNumber, i.reason])).toEqual([
      [2, "`1.5` is not a whole number of copies"],
      [3, "`3 copies` is not a whole number of copies"],
      [4, "A count of zero is not an import."],
      [5, "`12345` is more than the 9999 copies one row can hold"],
      [6, "`-1` is not a whole number of copies"],
      [7, "`+3` is not a whole number of copies"],
    ]);
  });

  it("takes the whole range, a leading zero, and a blank cell as one copy", () => {
    const list = parseDecklist("Quantity,Name\n9999,Sol Ring\n03,Shock\n,Duress\n");
    expect(list.issues).toEqual([]);
    expect(list.lines.map((l) => l.quantity)).toEqual([9999, 3, 1]);
  });

  it("reads every row as one copy when no column counts them, and says so", () => {
    const list = parseDecklist("Name,Set\nSol Ring,LTC\nShock,M19\n");
    expect(list.lines.map((l) => l.quantity)).toEqual([1, 1]);
    expect(list.csv).toMatchObject({ hasQuantity: false });
  });
});

describe("a CSV, read as a file", () => {
  /** A note written in three lines used to cost every later row two lines of its number, so a
   *  preview quoting "line 3" sent the reader to the middle of somebody else's note. */
  it("numbers every row by the line it starts on, past a cell that spans three", () => {
    const list = parseDecklist(
      'Quantity,Name,Notes\n1,Sol Ring,"first\nsecond\nthird"\n0,Shock,\n1,Lightning Bolt,\n',
    );
    expect(list.lines.map((l) => [l.lineNumber, l.name])).toEqual([
      [2, "Sol Ring"],
      [6, "Lightning Bolt"],
    ]);
    expect(list.lines[0].extra.notes).toBe("first\nsecond\nthird");
    expect(list.issues).toEqual([
      { lineNumber: 5, raw: "0,Shock,", reason: "A count of zero is not an import." },
    ]);
  });

  /** Excel in a comma-decimal locale writes `;` between cells — and `4,50` inside one. */
  it("reads a semicolon file, a comma inside a cell and all", () => {
    const list = parseDecklist(
      "Quantity;Name;Purchase price\n2;Aragorn, the Uniter;4,50\n1;Lightning Bolt;0,20\n",
    );
    expect(list.issues).toEqual([]);
    expect(list.lines[0]).toMatchObject({
      quantity: 2,
      name: "Aragorn, the Uniter",
      extra: { purchasePrice: "4,50" },
    });
    expect(list.csv?.delimiter).toBe(";");
  });

  it("reads a tab-separated file with a header", () => {
    const list = parseDecklist("Quantity\tName\tSet\n2\tLightning Bolt\tM11\n");
    expect(list.lines[0]).toMatchObject({ quantity: 2, name: "Lightning Bolt", setCode: "M11" });
    expect(list.csv?.delimiter).toBe("\t");
  });

  it("strips a declared separator line and reads what it declares", () => {
    const list = parseDecklist("sep=;\r\nQuantity;Name\r\n3;Forest\r\n");
    expect(list.lines[0]).toMatchObject({ lineNumber: 3, quantity: 3, name: "Forest" });
    expect(list.csv?.delimiter).toBe(";");
  });

  /** The writer escapes a cell a spreadsheet would evaluate; the reader takes it back off, so a
   *  note that starts `-2 lent to Sam` round-trips as itself. */
  it("undoes the formula escape on every cell it reads", () => {
    const list = parseDecklist("Quantity,Name,Notes\n1,Sol Ring,'-2 lent to Sam\n1,Shock,'hi\n");
    expect(list.lines.map((l) => l.extra.notes)).toEqual(["-2 lent to Sam", "'hi"]);
  });

  /**
   * **The golden fence, read back.** Both writers — `format.ts` and the mirror's `csv.rs` — must
   * produce this file byte for byte, apostrophes and all; this is the reader's half of the same
   * promise: every escaped cell comes back as the corpus spelled it, including a note that
   * already opened on an apostrophe and a quoted cell carrying a comma after its escape.
   */
  it("reads the golden formula-cells CSV back to the corpus's own words", () => {
    const { lines, issues } = parseDecklist(FORMULA_CELLS_CSV);
    expect(issues).toEqual([]);
    expect(lines[0]).toMatchObject({
      name: "+2 Mace",
      extra: { acquisitionSource: "@shop", tags: "=binder, trade", notes: "-2 lent" },
    });
    expect(lines[1].extra.notes).toBe("'=already escaped");
  });

  it("quotes a refused row as the file wrote it, quotes and all", () => {
    const list = parseDecklist('Quantity,Name\n1.5,"Aragorn, the Uniter"\n');
    expect(list.issues[0].raw).toBe('1.5,"Aragorn, the Uniter"');
  });
});
