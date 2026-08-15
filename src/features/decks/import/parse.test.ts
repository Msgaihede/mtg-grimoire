import { describe, expect, it } from "vitest";
import { parseDecklist } from "./parse";
import {
  ARCHIDEKT_FLAT,
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

  it("strips a foil marker and a trailing tag off the name", () => {
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

  it("strips an Archidekt tag whose hash follows a comma", () => {
    // `MARKERS`' `#` arm needs whitespace in front of the hash; this one has a comma, which is
    // why the whole tail used to stay inside the name.
    const { lines } = parseDecklist("1x Sol Ring (fic) 358 [Ramp] ^Keeper,#4aab08^");
    expect(lines[0]).toMatchObject({ name: "Sol Ring", setCode: "FIC", collectorNumber: "358" });
  });

  it("strips a tag whose own text has spaces and parentheses", () => {
    const { lines } = parseDecklist(
      "1x Mona Lisa, Science Geek (tmt) 123 ^Fence (flavor),#fa890d^",
    );
    expect(lines[0]!.name).toBe("Mona Lisa, Science Geek");
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

  it("peels a bracket, a foil marker and a tag off one line", () => {
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
