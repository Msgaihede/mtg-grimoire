/**
 * The three real decklist exports, driven all the way through this app and back out again.
 *
 * `import/parse.test.ts` pins what the **parser** makes of these, and `export/format.test.ts`
 * pins what each **writer** emits from a hand-built row or two. Neither answers the question a
 * reader actually has: paste the export you are holding, and does the deck that comes out still
 * hold your cards, in your piles, with your maybeboard still counting toward nothing? Every
 * round-trip assertion in this tree before this file ran over two or three hand-built cards, and
 * a format is exactly the kind of thing that works on three cards and fails on a corpus.
 *
 * **The matrix is three real decklists × six formats**, not one representative format. The
 * writers disagree deliberately — uppercase against lowercase set codes, headings against `SB:`
 * prefixes, who keeps a maybeboard and who leaves it out — so a per-format table is the only
 * shape that shows a writer drifting from the parser that has to read it back.
 */
import { describe, expect, it } from "vitest";
import type { CategoryKind, ImportItem, ImportResolveRow } from "@/lib/ipc";
import {
  EXPORT_FORMATS,
  formatExport,
  omittedCount,
  type ExportCard,
  type ExportFormat,
} from "./export/format";
import { ARCHIDEKT_FLAT, ARCHIDEKT_SECTIONED, EMPTY_HINT_LIST, match } from "./import/fixtures";
import { parseDecklist, type ParsedList } from "./import/parse";
import { buildImportPlan, tallyOf, toImportItems, type ImportPlan } from "./import/plan";

/**
 * The resolver, stubbed — and the stub claims **only that a printing answered this line**.
 *
 * `deck_import_resolve` is Rust asking 116 k rows which printing a name and a `(SET) 123` hint
 * name, and no TypeScript test can answer that. So: where a line carried a printing hint this
 * echoes the hint straight back, and **where it carried none it says so** — `""` for a set code
 * the line never named, never a plausible-looking three letters. A fixture that taught a false
 * set code, collector number or type line would be worse than no fixture, because everything
 * downstream would go green about a deck this app never builds.
 *
 * Two consequences worth naming rather than discovering:
 *
 * * **Every card's `typeLine` is `null`**, so any line that named no pile of its own falls to
 *   `autoCategoryFor`'s last rung and lands in `Uncategorized`. That is honest — this file knows
 *   what a decklist *says*, not what a card *is* — and it is why every pile assertion below is
 *   made against `ARCHIDEKT_SECTIONED`, whose 105 lines each name their own pile. The other two
 *   fixtures are asserted on counts, which the type line cannot reach.
 * * **`hintMissed` is always `false`.** Whether a hint missed is `resolve_lines`' finding about
 *   real data; claiming one here would be inventing the very answer the stub refuses to give.
 */
function resolvedRows(parsed: ParsedList): ImportResolveRow[] {
  return parsed.lines.map((line, index) => ({
    index,
    matched: match({
      name: line.name,
      setCode: line.setCode ?? "",
      collectorNumber: line.collectorNumber ?? "",
    }),
    hintMissed: false,
  }));
}

/** A pasted export, planned — `spec: null`, so no commander question is asked and a line under a
 *  `Commander` heading reaches the command zone through its section, as it does in the app. */
function planOf(text: string): ImportPlan {
  const parsed = parseDecklist(text);
  return buildImportPlan(parsed, resolvedRows(parsed), null);
}

/** What `deck_import_commit` would be sent. Nothing is confirmed as a commander, because these
 *  three exports each name their own. */
function itemsOf(text: string): ImportItem[] {
  return toImportItems(planOf(text), []);
}

/** The piles a paste lands in: pile name → **copies**, which is what a reader counts. Order-free
 *  on purpose — `tallyOf`'s ordering is `plan.test.ts`'s subject, not this file's. */
function pilesOf(text: string): Record<string, number> {
  return Object.fromEntries(tallyOf(itemsOf(text)).map((pile) => [pile.name, pile.cards]));
}

/**
 * What `deck_categories` really holds for a pile an import named.
 *
 * The four seeded zones are found by name (`category_for_name` finds before it creates), so a
 * line filed into `Sideboard` lands on the deck's `side` row rather than making a `main` pile
 * spelled the same way. Everything else an import names is a `main` pile it creates.
 */
const SEEDED_KIND: Record<string, CategoryKind> = {
  Commander: "commander",
  Sideboard: "side",
  Companion: "companion",
  Maybeboard: "maybe",
};

/**
 * A pasted export as the rows a deck export writes — the deck this app would be holding.
 *
 * The switch is `tallyOf`'s answer rather than a fourth spelling of it: a pile is switched off
 * when the file said `{noDeck}` **or** when it is the seeded Maybeboard, which arrives switched
 * off with every deck. Reading only the file's flag would export a Moxfield maybeboard as part
 * of the deck, which is the round trip this file exists to catch.
 */
function exportCardsFor(text: string): ExportCard[] {
  const plan = planOf(text);
  const inactive = new Set(
    tallyOf(toImportItems(plan, []))
      .filter((pile) => pile.inactive)
      .map((pile) => pile.name),
  );
  return plan.cards.map((card) => ({
    name: card.match.name,
    quantity: card.quantity,
    setCode: card.match.setCode,
    collectorNumber: card.match.collectorNumber,
    // Straight off the parsed line, which is what makes the finish part of the round trip this
    // file measures rather than a constant it asserts about.
    finish: card.finish,
    categoryName: card.categoryName,
    categoryKind: SEEDED_KIND[card.categoryName] ?? "main",
    categoryActive: !inactive.has(card.categoryName),
  }));
}

/**
 * The two formats with no maybeboard, so that the expectations below can say *which* cards a
 * format was handed rather than only how many.
 *
 * `format.ts` owns the rule; this is a mirror of it, and the mirror is checked rather than
 * trusted — "drops exactly the switched-off piles" asserts `omittedCount` against this same
 * pair, so the two drifting apart is a failure rather than a silent agreement to be wrong.
 */
const DROPS_INACTIVE: ReadonlySet<ExportFormat> = new Set<ExportFormat>(["arena", "mtgo"]);

/** The cards a format was given to write. */
function given(cards: readonly ExportCard[], format: ExportFormat): ExportCard[] {
  if (!DROPS_INACTIVE.has(format)) return [...cards];
  return cards.filter((card) => card.categoryActive);
}

/**
 * The copies a rendered file claims, counted off the text and **deliberately dumb** — a second
 * parser here would be a second thing to be wrong.
 *
 * Two shapes, because there are two. CSV puts the quantity in the first field and never quotes
 * it (`csvField` quotes only a value carrying a comma, a quote or a newline), so everything
 * before the first comma is the whole count; its header row is dropped by position. Every other
 * writer opens a card line with the count, behind at most MTGO's `SB: `, and a heading opens
 * with a letter — which is the entire test, and why a heading needs no list here.
 */
function copiesIn(text: string, format: ExportFormat): number {
  const rows = text.split("\n").filter((row) => row !== "");
  const cardRows = format === "csv" ? rows.slice(1) : rows;
  return cardRows.reduce((total, row) => {
    const counted = format === "csv" ? /^(\d+),/.exec(row) : /^(?:SB:\s*)?(\d+)x?\s/.exec(row);
    return counted === null ? total : total + Number(counted[1]);
  }, 0);
}

/**
 * The three exports through the import pipeline — text, parser, planner, items.
 *
 * `parse.test.ts` pins what the parser makes of the same three; this pins what the **deck**
 * does, which is the question the reader has.
 */
describe("importing a real decklist", () => {
  const CORPUS: [name: string, text: string, lines: number, copies: number, excluded: number][] = [
    ["Archidekt, sectioned", ARCHIDEKT_SECTIONED, 105, 117, 17],
    ["Archidekt, flat", ARCHIDEKT_FLAT, 88, 100, 0],
    ["empty-() hints", EMPTY_HINT_LIST, 88, 100, 0],
  ];

  it.each(CORPUS)("plans %s as %i lines and %i copies", (name, text, lines, copies, excluded) => {
    const plan = planOf(text);

    expect(plan.parseIssues, name).toEqual([]);
    expect(plan.unmatched, name).toEqual([]);
    expect(plan.cards, name).toHaveLength(lines);
    expect(plan.totalCards, name).toBe(copies);
    expect(
      itemsOf(text).filter((item) => item.inactive === true),
      name,
    ).toHaveLength(excluded);
  });

  /**
   * **The assertion the whole corpus was chosen for.** The two flat lists are the sectioned one
   * less its 17 `{noDeck}` cards, so the counted deck has to come out identical from all three —
   * one deck, three exports, one answer. A parser rule that read one shape and mis-read another
   * shows up here as a number and nowhere else.
   */
  it("puts the same 100 counted cards in the deck whichever of the three was pasted", () => {
    const counted = (text: string) =>
      itemsOf(text)
        .filter((item) => item.inactive !== true)
        .reduce((total, item) => total + item.quantity, 0);

    expect(counted(ARCHIDEKT_SECTIONED)).toBe(100);
    expect(counted(ARCHIDEKT_FLAT)).toBe(100);
    expect(counted(EMPTY_HINT_LIST)).toBe(100);
  });

  /**
   * The 14 piles, by name and by copies — the fact this branch exists to preserve, and the one
   * no count above would notice losing. `Flash Enabler`, `Counters` and `Stax` are the reader's
   * own words and reach the deck only because a file naming a pile is the reader naming one;
   * before this branch every one of these landed under whatever the card's type line said.
   */
  it("lands the sectioned export in the 14 piles it names", () => {
    expect(pilesOf(ARCHIDEKT_SECTIONED)).toEqual({
      Commander: 1,
      Anthem: 4,
      Counters: 2,
      Creature: 10,
      Draw: 7,
      "Flash Enabler": 2,
      Land: 37,
      Protection: 8,
      Ramp: 15,
      Removal: 9,
      Stax: 2,
      Tutor: 3,
      Maybeboard: 10,
      "(New) Maybeboard": 7,
    });
  });

  /**
   * Both maybeboards count toward nothing, and they get there by two different routes — which is
   * the point of asserting them together. `Maybeboard` is the seeded pile every deck already has
   * switched off, reached through the section vocabulary; `(New) Maybeboard` is a pile this
   * import will have to make, and it is `{noDeck}` on the line that says so.
   */
  it("marks both maybeboards as counting toward nothing, and nothing else", () => {
    const off = tallyOf(itemsOf(ARCHIDEKT_SECTIONED)).filter((pile) => pile.inactive);

    expect(off).toEqual([
      { name: "Maybeboard", cards: 10, inactive: true },
      { name: "(New) Maybeboard", cards: 7, inactive: true },
    ]);
  });
});

/**
 * Every writer, over a real 105-line deck with 14 piles and 17 cards switched off.
 *
 * What is asserted is the **shape** of each file: that it ends in one newline and starts with a
 * card or a heading rather than a blank, that every copy is either written or declared missing,
 * and that only the two maybeboard-less formats declare anything missing at all.
 */
describe("exporting a real deck", () => {
  const cards = exportCardsFor(ARCHIDEKT_SECTIONED);

  it("is the sectioned export's own deck: 105 rows, 117 copies, 17 switched off", () => {
    expect(cards).toHaveLength(105);
    expect(cards.reduce((total, card) => total + card.quantity, 0)).toBe(117);
    expect(cards.filter((card) => !card.categoryActive)).toHaveLength(17);
    expect(new Set(cards.map((card) => card.categoryName)).size).toBe(14);
  });

  it.each([...EXPORT_FORMATS])("writes every counted card in %s", (format) => {
    const text = formatExport(cards, format);

    expect(text.endsWith("\n"), format).toBe(true);
    expect(text.startsWith("\n"), format).toBe(false);
    // Copies the format wrote, plus the copies it says it left out, is the whole deck.
    expect(copiesIn(text, format) + omittedCount(cards, format), format).toBe(117);
  });

  it("drops exactly the switched-off piles from Arena and MTGO, and nothing from the rest", () => {
    for (const format of EXPORT_FORMATS) {
      expect(omittedCount(cards, format), format).toBe(DROPS_INACTIVE.has(format) ? 17 : 0);
    }
  });

  /** Arena and MTGO have no maybeboard, so a deck that is entirely maybeboard is an empty file
   *  in those two rather than a heading over nothing — and `omittedCount` is what says so. */
  it("writes nothing at all when a format's own filter empties the list", () => {
    const maybeboard = cards.filter((card) => !card.categoryActive);

    expect(formatExport(maybeboard, "arena")).toBe("");
    expect(formatExport(maybeboard, "mtgo")).toBe("");
    expect(omittedCount(maybeboard, "arena")).toBe(17);
    expect(formatExport(maybeboard, "archidekt")).not.toBe("");
  });
});

/**
 * Text in, deck out, text out, deck in — over a real 105-line decklist rather than three cards.
 *
 * **CSV is write-only and is excluded by name**, not by omission: nothing in `parse.ts` reads a
 * comma-separated decklist, and adding one would be a second grammar rather than a rule inside
 * the one there is. The exclusion is asserted, so dropping a format out of this table by
 * accident is a failure rather than a quietly smaller matrix.
 */
describe("a real decklist round-trips through every format this app can read", () => {
  const READABLE = EXPORT_FORMATS.filter((format) => format !== "csv");

  it("excludes only CSV", () => {
    expect(READABLE).toEqual(["plain", "mtgo", "arena", "moxfield", "archidekt"]);
  });

  it.each(READABLE)("keeps every card and copy through %s", (format) => {
    const cards = exportCardsFor(ARCHIDEKT_SECTIONED);
    const back = parseDecklist(formatExport(cards, format));
    const written = given(cards, format);

    expect(back.issues, format).toEqual([]);
    expect(back.totalCards, format).toBe(117 - omittedCount(cards, format));
    expect(back.lines, format).toHaveLength(written.length);
    // Compared as names rather than counted, so a writer that reorders its sections is not a
    // failure and a writer that cuts `Branchloft Pathway // Boulderloft Pathway` in half is.
    // `//` is a comment only at the start of a line, and this is where that rule is worth its
    // keep: seven of these 105 names carry one, two of them inside the maybeboard.
    expect(new Set(back.lines.map((line) => line.name)), format).toEqual(
      new Set(written.map((card) => card.name)),
    );
  });

  it("keeps the reader's own 14 piles through Archidekt, and only through Archidekt", () => {
    const cards = exportCardsFor(ARCHIDEKT_SECTIONED);

    expect(pilesOf(formatExport(cards, "archidekt"))).toEqual(pilesOf(ARCHIDEKT_SECTIONED));

    // Moxfield's section vocabulary is fixed, so `Flash Enabler` and the other free-form piles
    // come back as whatever the app makes of the card — a real loss, stated here rather than
    // discovered by a reader whose categories vanished. Every *copy* still arrives.
    const moxfield = pilesOf(formatExport(cards, "moxfield"));
    expect(Object.keys(moxfield)).not.toContain("Flash Enabler");
    expect(Object.keys(moxfield)).toEqual(expect.arrayContaining(["Commander", "Maybeboard"]));
    expect(Object.values(moxfield).reduce((total, copies) => total + copies, 0)).toBe(117);
  });

  /** `{noDeck}` is the only thing any of these formats can say about a pile that counts toward
   *  nothing, which is why Archidekt is the one format that writes an inactive pile *and* leaves
   *  nothing out. */
  it("keeps the switched-off piles through Archidekt's {noDeck}", () => {
    const back = parseDecklist(formatExport(exportCardsFor(ARCHIDEKT_SECTIONED), "archidekt"));

    expect(back.lines.filter((line) => line.excluded)).toHaveLength(17);
  });

  /**
   * **The one that matters.** A writer that is not idempotent grows or loses something on every
   * export/import cycle — a heading duplicated, a marker re-emitted, a set code re-cased — and
   * one cycle cannot see it, because there is nothing to compare the first answer against.
   *
   * Every readable format is checked rather than only Archidekt: the five differ in exactly what
   * they throw away (a printing, the reader's piles, the maybeboard), and a fixed point has to
   * hold for what each one *keeps*.
   */
  it.each(READABLE)("survives a second trip, so %s is a fixed point", (format) => {
    const once = formatExport(exportCardsFor(ARCHIDEKT_SECTIONED), format);
    const twice = formatExport(exportCardsFor(once), format);

    expect(twice, format).toBe(once);
  });
});
