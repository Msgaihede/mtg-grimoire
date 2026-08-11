import { describe, expect, it } from "vitest";
import {
  MANA_COST_GLYPHS,
  MANA_KEYS,
  MANA_LINE_GRADIENT,
  manaParts,
  manaSymbolClass,
} from "@/lib/mana";
/**
 * The bundled font as it ships. `manaParts` names classes rather than glyphs, so the only
 * thing standing between a cost and an empty box is that every class it can name is one
 * `mana.css` actually draws — which a package bump can change without a word.
 */
import manaCss from "mana-font/css/mana.css?raw";

describe("manaSymbolClass", () => {
  /** `mana-font` keys its glyphs on lowercase letters; the app spells colours WUBRG. */
  it("names the mana-font glyph for every chip, colourless included", () => {
    expect(manaSymbolClass("W")).toBe("ms ms-w");
    expect(manaSymbolClass("C")).toBe("ms ms-c");
    expect(MANA_KEYS).toHaveLength(6);
  });
});

describe("manaParts", () => {
  const glyphs = (cost: string) => manaParts(cost).map((p) => (p.kind === "symbol" ? p.glyph : p));

  it("draws each symbol of a printed cost, in printed order", () => {
    expect(manaParts("{2}{U}{U}")).toEqual([
      { kind: "symbol", token: "2", glyph: "ms ms-2" },
      { kind: "symbol", token: "U", glyph: "ms ms-u" },
      { kind: "symbol", token: "U", glyph: "ms ms-u" },
    ]);
  });

  /**
   * Costs are not only letters and numbers. `mana-font` keys hybrids and Phyrexian mana on
   * the slash-less spelling, so `{W/U}` is `.ms-wu` — dropping that transformation gives
   * every hybrid card an empty box where its cost should be.
   */
  it("reads hybrid, twobrid and Phyrexian mana as the font spells them", () => {
    expect(glyphs("{W/U}")).toEqual(["ms ms-wu"]);
    expect(glyphs("{2/R}")).toEqual(["ms ms-2r"]);
    expect(glyphs("{G/P}")).toEqual(["ms ms-gp"]);
    expect(glyphs("{B/G/P}")).toEqual(["ms ms-bgp"]);
    // Not a mana symbol and printed in costs' company all the same, with its own name in
    // the font.
    expect(glyphs("{T}")).toEqual(["ms ms-tap"]);
  });

  /**
   * The four symbols Scryfall emits that never appear in a mana cost: the planeswalker and
   * chaos symbols on Planechase cards, and the acorn and ticket stamps of the Un-sets. Two
   * of them are single letters in the data and whole words in the font, which is exactly
   * the kind of mapping that goes missing and renders as an empty box.
   */
  it("reads the symbols that are printed outside a cost", () => {
    expect(glyphs("{PW}")).toEqual(["ms ms-planeswalker"]);
    expect(glyphs("{CHAOS}")).toEqual(["ms ms-chaos"]);
    expect(glyphs("{A}")).toEqual(["ms ms-acorn"]);
    expect(glyphs("{TK}")).toEqual(["ms ms-tk"]);
  });

  /**
   * Oracle text is a cost with prose around it, which is the same parse: the text between
   * the braces has to survive, or an ability line loses every word around its symbols.
   */
  it("keeps the words between the symbols", () => {
    expect(manaParts("{T}: Add {G}.")).toEqual([
      { kind: "symbol", token: "T", glyph: "ms ms-tap" },
      { kind: "text", value: ": Add " },
      { kind: "symbol", token: "G", glyph: "ms ms-g" },
      { kind: "text", value: "." },
    ]);
  });

  /**
   * The font is 15 years of Magic behind a set that keeps printing new symbols, so an
   * unknown token is routine. It keeps its text and loses only its glyph — a symbol that
   * renders as nothing at all is a cost the reader silently misreads.
   */
  it("hands back an unknown symbol as text rather than an empty box", () => {
    expect(manaParts("{HW}")).toEqual([{ kind: "symbol", token: "HW", glyph: null }]);
  });

  it("has nothing to draw for an absent or empty cost", () => {
    // Scryfall gives a transform's back face `"mana_cost": ""`, and Rust already maps that
    // to null — both have to come back as no symbols rather than as an empty pill.
    expect(manaParts(null)).toEqual([]);
    expect(manaParts("")).toEqual([]);
  });

  /** Every class this can name is one the bundled font actually draws. */
  it("names only classes `mana-font` ships", () => {
    expect(MANA_COST_GLYPHS.size).toBeGreaterThan(50);
    for (const key of MANA_COST_GLYPHS) {
      // Word-boundary-ish: `.ms-1` must not be satisfied by `.ms-1-2`, nor `.ms-2` by
      // `.ms-20`.
      expect(new RegExp(`\\.ms-${key}(?![\\w-])`).test(manaCss), `.ms-${key}`).toBe(true);
    }
  });
});

describe("MANA_LINE_GRADIENT", () => {
  /** The signature element. Five colours, in WUBRG order, and no colourless — the line is
   *  the colour pie, not the filter row. */
  it("runs W→U→B→R→G in order", () => {
    const order = [
      "--color-mana-w",
      "--color-mana-u",
      "--color-mana-b",
      "--color-mana-r",
      "--color-mana-g",
    ];
    const positions = order.map((token) => MANA_LINE_GRADIENT.indexOf(token));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(MANA_LINE_GRADIENT).not.toContain("--color-mana-c");
  });
});
