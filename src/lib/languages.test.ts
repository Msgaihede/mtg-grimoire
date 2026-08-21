import { describe, expect, it } from "vitest";
import { languageHint, languageName } from "@/lib/languages";

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
