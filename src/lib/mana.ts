/**
 * Magic's colour pie, as the interface uses it.
 *
 * The direction doc's thesis: colour appears only where it carries Magic meaning. This
 * module is the whole of that vocabulary — the five (plus colourless) symbol keys, the
 * `mana-font` class names that draw them, and the gradient behind the app's one signature
 * element. Nothing else in the app invents a colour.
 */

/** The filter chips: WUBRG plus colourless. */
export const MANA_KEYS = ["W", "U", "B", "R", "G", "C"] as const;
export type ManaKey = (typeof MANA_KEYS)[number];

/**
 * The mana line is the colour *pie*, not the filter row — five colours, no colourless.
 * WUBRG order is not a preference: it is the order the symbols are printed in.
 */
export const MANA_LINE_KEYS = ["W", "U", "B", "R", "G"] as const;

export const MANA_LABEL: Record<ManaKey, string> = {
  W: "White",
  U: "Blue",
  B: "Black",
  R: "Red",
  G: "Green",
  C: "Colorless",
};

/**
 * The `mana-font` classes that draw one symbol.
 *
 * The glyph comes from the bundled font; the *fill* comes from our own tokens, because
 * `mana-font`'s built-in `--ms-mana-*` values are a shade off the direction doc's
 * (`#fdfbce` where the doc says `#FFFBD5`) and the doc is what is binding.
 */
export function manaSymbolClass(key: ManaKey): string {
  return `ms ms-${key.toLowerCase()}`;
}

/**
 * Every `mana-font` class a printed cost can be drawn with, keyed the way the font spells
 * them: lowercase, and slash-less for hybrids (`{W/U}` → `.ms-wu`).
 *
 * A closed list rather than a pattern, because the failure mode of guessing is invisible:
 * `.ms-` with an unknown suffix is a class the stylesheet has no rule for, so the symbol
 * renders as *nothing at all* and the reader misreads the cost. Anything not in here keeps
 * its text instead. `mana.test.ts` checks every entry against the shipped `mana.css`.
 */
export const MANA_COST_GLYPHS: ReadonlySet<string> = new Set([
  // Generic: 0–20, plus the two joke costs that are really printed.
  ...Array.from({ length: 21 }, (_, i) => String(i)),
  ...tokens("100 1000000"),
  // The five, colourless, snow, energy, Phyrexian, and the variables.
  ...tokens("w u b r g c s e p x y z"),
  // Hybrid — allied then enemy, spelled in the order Scryfall prints the pair.
  ...tokens("wu ub br rg gw wb ur bg rw gu"),
  // Twobrid, Phyrexian, hybrid Phyrexian, and the colourless hybrids of recent sets.
  ...tokens("2w 2u 2b 2r 2g"),
  ...tokens("wp up bp rp gp"),
  ...tokens("wup ubp brp rgp gwp wbp urp bgp rwp gup"),
  ...tokens("cw cu cb cr cg"),
  // Not mana, printed in mana's company: the tap and untap symbols, the two oddities, and
  // the four Scryfall emits that no cost contains — planeswalker and chaos on Planechase
  // cards, the acorn and ticket stamps on Un-set and Unfinity printings.
  ...tokens("tap untap infinity 1-2"),
  ...tokens("planeswalker chaos acorn tk"),
]);

/** A row of the table above. Written as one string so a group stays one line. */
function tokens(row: string): string[] {
  return row.split(" ");
}

/**
 * Tokens the font files under a different name than Scryfall writes them.
 *
 * `{T}` is `.ms-tap` rather than `.ms-t`, which is a lamp on Kaladesh cards; the rest are
 * the un-set curiosities.
 */
const GLYPH_ALIAS: Record<string, string> = {
  t: "tap",
  q: "untap",
  "∞": "infinity",
  "½": "1-2",
  // `{PW}` and `{A}` are single letters in the data and whole words in the font.
  pw: "planeswalker",
  a: "acorn",
};

/** One piece of a printed string: a symbol the font can draw, or the prose around it. */
export type ManaPart =
  | { kind: "text"; value: string }
  | {
      kind: "symbol";
      /** The token as printed, brace-less — the fallback text when there is no glyph. */
      token: string;
      /** The `mana-font` classes that draw it, or `null` when the font has no such glyph. */
      glyph: string | null;
    };

/** `{2}{U}` and `{T}: Add {G}.` are the same parse. */
const SYMBOL = /\{([^}]*)\}/g;

/**
 * Split a printed string into its mana symbols and the text between them.
 *
 * One function for both the cost line and the rules text, because Magic makes no
 * distinction: `{T}: Add {G}` is a cost with prose around it. The text between symbols is
 * always preserved — a parser that returned only the symbols would delete an ability's
 * words, and one that returned only what it recognised would delete the symbol.
 */
export function manaParts(source: string | null): ManaPart[] {
  if (!source) return [];
  const parts: ManaPart[] = [];
  let cut = 0;
  for (const match of source.matchAll(SYMBOL)) {
    if (match.index > cut) parts.push({ kind: "text", value: source.slice(cut, match.index) });
    parts.push({ kind: "symbol", token: match[1], glyph: manaGlyphClass(match[1]) });
    cut = match.index + match[0].length;
  }
  if (cut < source.length) parts.push({ kind: "text", value: source.slice(cut) });
  return parts;
}

/**
 * Does this printed cost name the variable `{X}`?
 *
 * **`{X}` only — never `{Y}` or `{Z}`.** `validation/engine.ts`'s `symbolValue` scores all
 * three as 0, and it is right to: it is answering *what is this cost worth*, and a variable
 * contributes nothing to a mana value until it is announced. This function answers a
 * different question — *what is this pile called* — and there the three are not
 * interchangeable. `{Y}` and `{Z}` appear on a handful of Un-cards and nowhere else, so a
 * heading that swept them up would be a heading saying "X" over cards that print no X: a
 * label telling the reader a lie about the cardboard in front of them.
 *
 * Case-insensitive on the token, because the glyph table above lowercases (`MANA_COST_GLYPHS`
 * holds `x y z`) and nothing guarantees the case a cost arrives in.
 *
 * `null` and `""` are both `false`. An empty cost is the **land** case — Scryfall gives a
 * transform's back face `""` and `.storybook/fake/cards.ts` seeds `""` for lands — so it is a
 * cost with no symbols rather than a cost nobody knows.
 *
 * A split or MDFC cost is one string (`"{X}{B}{B}{B}"`, `"{1}{R} // {1}{U}"`), so asking about
 * the whole string is the right question: an X on either half is an X the reader pays. It goes
 * through {@link SYMBOL} rather than `String.includes("{X}")` all the same, so the one
 * tokeniser in this file stays the one tokeniser — a second, looser spelling of "what is a
 * symbol" is exactly how the two drift.
 */
export function hasVariableCost(cost: string | null): boolean {
  if (!cost) return false;
  for (const match of cost.matchAll(SYMBOL)) {
    if (match[1].toLowerCase() === "x") return true;
  }
  return false;
}

/** The classes that draw one brace-less token, or `null` if the font has no glyph for it. */
function manaGlyphClass(token: string): string | null {
  const bare = token.toLowerCase().replace(/\//g, "");
  const key = GLYPH_ALIAS[bare] ?? bare;
  return MANA_COST_GLYPHS.has(key) ? `ms ms-${key}` : null;
}

/**
 * The signature: a soft W→U→B→R→G blend, written against the theme tokens so the line and
 * the chips can never drift apart.
 */
export const MANA_LINE_GRADIENT = `linear-gradient(90deg, var(--color-mana-w) 0%, var(--color-mana-u) 25%, var(--color-mana-b) 50%, var(--color-mana-r) 75%, var(--color-mana-g) 100%)`;

/**
 * What the mana line draws — the subset of an `Activity` the line itself needs.
 *
 * `Activity` extends this, so the ribbon hands the top job straight to `ManaLine`. It stays
 * here rather than moving to `activity.ts` because it is a property of the *line*: a
 * fraction and a name for it are all a 2px rule can carry.
 */
export interface ManaLineSync {
  /** 0–1, or `null` for a phase with no denominator. */
  value: number | null;
  label: string;
}
