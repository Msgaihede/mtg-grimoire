import { describe, expect, it } from "vitest";
import {
  isKnownLanguage,
  LANGUAGE_CODES,
  languageHint,
  languageName,
} from "@/lib/languages";

describe("languageName", () => {
  it("names the codes a reader can read for themselves", () => {
    expect(languageName("ja")).toBe("Japanese");
    expect(languageName("zhs")).toBe("Simplified Chinese");
    expect(languageName("zht")).toBe("Traditional Chinese");
  });

  /**
   * The three the table exists for. `PH` is what issue #161 was filed about — 49 printings in
   * the 2026-08-18 corpus, Elesh Norn among them — and `QYA` and `DW` are the two Scryfall's
   * own languages page does not list, read off `ltr`/`ltc` and `hoc` rows instead.
   */
  it("names the invented languages the corpus actually contains", () => {
    expect(languageName("ph")).toBe("Phyrexian");
    expect(languageName("qya")).toBe("Quenya");
    expect(languageName("dw")).toBe("Dwarvish");
  });

  /**
   * A language this table has not been taught is still the reader's own data, so it is drawn
   * as itself in capitals — the shape every surface already gives a code — rather than as
   * "Unknown", which would claim the card has no language at all.
   */
  it("draws an unknown code as itself rather than claiming ignorance of the card", () => {
    expect(languageName("xx")).toBe("XX");
    // Not a language, and not an inherited `Object.prototype` key either: a record read with
    // this key would hand back a function.
    expect(languageName("constructor")).toBe("CONSTRUCTOR");
  });

  /** The database stores codes lowercase; a surface that has already shouted one still asks. */
  it("takes a code in either case", () => {
    expect(languageName("JA")).toBe("Japanese");
  });
});

describe("languageHint", () => {
  /**
   * The mark is two letters on a photograph with nothing beside it saying what they are for,
   * so the hover names the fact as well as the value — the whole of what #161 asked for.
   */
  it("says what the abbreviation is short for, not just the name", () => {
    expect(languageHint("ph")).toBe("Printed in Phyrexian");
    expect(languageHint("ja")).toBe("Printed in Japanese");
  });

  /** The fallback reads as a sentence too, rather than degrading into a bare code. */
  it("keeps its sentence for a language it cannot name", () => {
    expect(languageHint("xx")).toBe("Printed in XX");
  });
});

describe("LANGUAGE_CODES", () => {
  /**
   * **English first**, because the one caller is a picker and every other surface in this app
   * that lists languages puts it there — `PrintingsFilterBar`'s own order. The rest follow the
   * table's declared order, which is roughly by how often a reader meets them.
   */
  it("leads with English", () => {
    expect(LANGUAGE_CODES[0]).toBe("en");
  });

  /**
   * Nineteen: every code across the 116 712 rows of the 2026-08-18 bulk. The number is asserted
   * rather than left implied because this array is now what a settings picker is built from, and
   * a code silently dropped from the table would be a filter a reader can no longer choose.
   */
  it("carries every code the corpus contains", () => {
    expect(LANGUAGE_CODES).toHaveLength(19);
    // The two Scryfall's own languages page does not list, and the one issue #161 was about.
    expect(LANGUAGE_CODES).toEqual(expect.arrayContaining(["qya", "dw", "ph"]));
    // Every entry names itself — the array and the table cannot come apart.
    for (const code of LANGUAGE_CODES) expect(languageName(code)).not.toBe(code.toUpperCase());
  });

});

describe("isKnownLanguage", () => {
  it("knows the codes the table names, in either case", () => {
    expect(isKnownLanguage("en")).toBe(true);
    expect(isKnownLanguage("ph")).toBe(true);
    expect(isKnownLanguage("JA")).toBe(true);
  });

  /**
   * **Narrower than `languageName` on purpose, and this is the pair worth reading together.**
   * `languageName("xx")` is `"XX"` — the reader's own data, drawn as itself — where this answers
   * `false`, because offering `XX` as a tick-box would be the app inventing a filter that matches
   * nothing. Same input, two honest answers to two different questions.
   */
  it("refuses a code the table has not been taught, where languageName does not", () => {
    expect(isKnownLanguage("xx")).toBe(false);
    expect(languageName("xx")).toBe("XX");
  });

  /** A `Set`, so an inherited key is not a language. */
  it("is not fooled by a prototype key", () => {
    expect(isKnownLanguage("constructor")).toBe(false);
    expect(isKnownLanguage("toString")).toBe(false);
  });
});
