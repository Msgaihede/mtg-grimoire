import { describe, expect, it } from "vitest";
import {
  addPips,
  countPips,
  emptyPips,
  hasVariableCost,
  MANA_COST_GLYPHS,
  MANA_KEYS,
  MANA_LINE_GRADIENT,
  manaParts,
  manaSymbolClass,
  type PipCounts,
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

describe("hasVariableCost", () => {
  it("is true for a cost that names {X}, alone or among other symbols", () => {
    expect(hasVariableCost("{X}{B}{B}{B}")).toBe(true);
    expect(hasVariableCost("{X}")).toBe(true);
  });

  it("is false for a cost with no variable in it", () => {
    expect(hasVariableCost("{2}{U}")).toBe(false);
  });

  /**
   * `{Y}` and `{Z}` are worth the same as `{X}` — nothing until announced — and that is the
   * question `engine.ts`'s `symbolValue` answers. This one names a pile, and a heading that
   * says X over an Un-card printing `{Y}` is a heading telling the reader a lie.
   */
  it("is false for {Y} and {Z}, which are worth what {X} is but are not it", () => {
    expect(hasVariableCost("{Y}{Z}")).toBe(false);
    expect(hasVariableCost("{Y}")).toBe(false);
  });

  /** The glyph table in this file lowercases, so nothing guarantees the case a cost arrives
   *  in — matching only the printed capital would file a card by how it was typed. */
  it("reads a lowercase {x} as the same variable", () => {
    expect(hasVariableCost("{x}{r}")).toBe(true);
  });

  /**
   * A split or MDFC cost is one string, so the question is asked of the whole of it. Neither
   * half of `{1}{R} // {1}{U}` names a variable, and the `//` is not a symbol.
   */
  it("is false for a split cost whose halves name no variable", () => {
    expect(hasVariableCost("{1}{R} // {1}{U}")).toBe(false);
  });

  /** An empty cost is the land case — Scryfall sends `""` for a transform's back face and the
   *  workbench seeds `""` for lands — so it is "no symbols", not "no answer". */
  it("is false for an absent or empty cost", () => {
    expect(hasVariableCost(null)).toBe(false);
    expect(hasVariableCost("")).toBe(false);
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

/**
 * The colour bar's arithmetic — every rule the deck gallery's bar rests on, and the two that
 * are decisions rather than readings (a hybrid counts twice; generic counts not at all).
 */
describe("countPips", () => {
  /**
   * Six zeroes, **written out here rather than taken from `emptyPips()`**.
   *
   * An expectation built from the constant under test agrees with a broken constant by
   * construction: an `emptyPips` that had lost a key would produce an expected record missing
   * the same key, and every assertion below would go on passing over the hole. The literal is
   * the second opinion.
   */
  const NO_PIPS: PipCounts = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  /** That literal with the colours a case is about written over it, so each expectation reads
   *  as "these, and every other colour at zero". */
  const pips = (over: Partial<PipCounts>): PipCounts => ({ ...NO_PIPS, ...over });

  it("starts every colour at zero, colourless included", () => {
    expect(emptyPips()).toEqual(NO_PIPS);
    expect(Object.keys(emptyPips()).sort()).toEqual([...MANA_KEYS].sort());
  });

  it("counts one pip per coloured symbol, however many times it is printed", () => {
    expect(countPips("{2}{U}{U}")).toEqual(pips({ U: 2 }));
    expect(countPips("{W}{U}{B}{R}{G}")).toEqual(pips({ W: 1, U: 1, B: 1, R: 1, G: 1 }));
  });

  /**
   * **The rule that is a decision.** A hybrid is a cost the reader may pay either way, so
   * neither half is truer than the other and both are counted — the bar answers *what does this
   * deck want*, not *what will be spent*. Lurrus's real printed cost, because a made-up
   * `{W/U}` on its own would not show the pips accumulating per copy of the symbol.
   */
  it("counts a hybrid as one pip of each half", () => {
    expect(countPips("{1}{W/B}{W/B}")).toEqual(pips({ W: 2, B: 2 }));
    expect(countPips("{W/U}")).toEqual(pips({ W: 1, U: 1 }));
  });

  /**
   * Not three more rules — the hybrid one, arriving at halves that are not colours. `2` and `P`
   * name no colour, so they are skipped and what is left is the colour the card really asks
   * for.
   */
  it("counts a twobrid and a Phyrexian as their colours and nothing else", () => {
    expect(countPips("{2/W}")).toEqual(pips({ W: 1 }));
    expect(countPips("{G/P}")).toEqual(pips({ G: 1 }));
    expect(countPips("{B/G/P}")).toEqual(pips({ B: 1, G: 1 }));
  });

  /** `{C}` is a demand for a real kind of mana, which is the whole of what separates it from
   *  the generic beside it — so it is a pip and `{1}` is not. */
  it("counts {C} as a colourless pip while the generic beside it counts for nothing", () => {
    expect(countPips("{1}{C}{C}")).toEqual(pips({ C: 2 }));
  });

  /**
   * "Ignore general mana cost" — the issue's own instruction, and the right one: generic mana
   * says how *much* a card costs and this is asking *what* it costs. The variables and the
   * oddities go the same way, `{S}` and `{E}` included: snow and energy are resources rather
   * than colours, and the bar has no segment to put either in.
   */
  it("counts nothing for generic, the variables, and every symbol that is not a colour", () => {
    expect(countPips("{2}{X}{Y}{Z}{S}{E}{T}{Q}")).toEqual(NO_PIPS);
    expect(countPips("{X}{X}")).toEqual(NO_PIPS);
    // 100 and 1000000 are printed costs, not typos: the generic rule has to hold for the joke
    // ones too, and a counter that read the leading digit would find a `1` in each.
    expect(countPips("{100}{1000000}")).toEqual(NO_PIPS);
  });

  /**
   * A split or MDFC cost is one string, so every symbol in it counts — {@link hasVariableCost}'s
   * reading of the same shape. A card castable either way wants both halves, and the `//`
   * between them is not a symbol at all.
   */
  it("counts both halves of a split cost", () => {
    expect(countPips("{1}{R} // {1}{U}")).toEqual(pips({ R: 1, U: 1 }));
  });

  /** An empty cost is the **land** case — Scryfall sends `""` for a transform's back face and
   *  the workbench seeds `""` for lands — so it is a cost with no symbols rather than a cost
   *  nobody knows, and a pile of basics counts to six zeroes rather than refusing. */
  it("counts an absent or empty cost as no pips at all", () => {
    expect(countPips(null)).toEqual(NO_PIPS);
    expect(countPips("")).toEqual(NO_PIPS);
  });

  /** The tokeniser lowercases elsewhere in this file and nothing guarantees the case a cost
   *  arrives in, so a colour typed in lowercase is the same colour. */
  it("reads a lowercase symbol as the same colour", () => {
    expect(countPips("{x}{r}{w/u}")).toEqual(pips({ R: 1, W: 1, U: 1 }));
  });

  describe("addPips", () => {
    /** The deck's own arithmetic: four copies of a one-red spell is four red pips, not one. */
    it("weights a cost by the copies in the deck", () => {
      const counts = emptyPips();
      addPips(counts, "{R}{R}", 4);
      expect(counts).toEqual(pips({ R: 8 }));
    });

    /**
     * The shape the gallery folds a deck in — one accumulator, one call per `(cost, copies)`
     * pair, no record allocated per row. The hybrid still counts on both sides of the sum.
     */
    it("accumulates every cost it is given into one count", () => {
      const counts = emptyPips();
      addPips(counts, "{1}{R}", 4);
      addPips(counts, "{W/U}", 2);
      addPips(counts, "{C}", 1);
      // A land, contributing nothing and not disturbing what is already there.
      addPips(counts, "", 20);
      addPips(counts, null, 20);
      expect(counts).toEqual(pips({ R: 4, W: 2, U: 2, C: 1 }));
    });

    /** Zero copies is a row nothing is played from — the arithmetic holds rather than being
     *  special-cased, which is what keeps a stepped-to-zero deck row harmless. */
    it("adds nothing for a row with no copies", () => {
      const counts = emptyPips();
      addPips(counts, "{G}{G}", 0);
      expect(counts).toEqual(NO_PIPS);
    });
  });
});
