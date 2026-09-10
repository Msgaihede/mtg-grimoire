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
 * The token that fills a **field with a mana symbol on it** — a chip, a pip, a band segment, a
 * bar in the deck stats band.
 *
 * **`--color-mana-*` and never `--color-pie-*`**, and `index.css` states the split at the tokens
 * themselves: these six are how a printed symbol is filled, glyphs sit on them in near-black
 * exactly as on a real symbol, and they are *"never a panel, never a border, never text"*. The
 * pie deeps are the colour-**identity** palette — saturated enough to carry meaning at one pixel,
 * and far too hot at bar size.
 *
 * **This exists because a third surface asked for it, which is the condition
 * `src/features/decks/CLAUDE.md` already wrote down**: `DeckColorBar` filling its segments and
 * `DeckStats`' `PIP_COLOR` filling its dots were two answers from one palette and that was not
 * drift — *"A third surface filling by colour key is the point at which all of them want one home
 * in `mana.ts`."* The deck stats redesign is that third surface, several times over: the two pips
 * bands, the six per-colour cost/source tracks, and the six colour curves. So the home is here.
 *
 * A `var()` reference rather than a hex, so the palette can move in one file — and a **custom
 * property rather than a Tailwind class**, because Tailwind scans source text for whole class
 * names and a `bg-mana-${key}` assembled at runtime emits no rule at all.
 */
export const MANA_FILL: Record<ManaKey, string> = {
  W: "var(--color-mana-w)",
  U: "var(--color-mana-u)",
  B: "var(--color-mana-b)",
  R: "var(--color-mana-r)",
  G: "var(--color-mana-g)",
  C: "var(--color-mana-c)",
};

/**
 * Which colours of mana a card can make, from the concatenated-letter `producedMana` — one
 * `ManaKey` per distinct letter the field names, in {@link MANA_KEYS} order.
 *
 * **`null` in, empty out, and the caller is what tells the two apart.** This answers only "which
 * letters are in this string"; whether an empty answer means *this card makes no mana* or *this
 * row predates the column* is `DeckCard.producedMana`'s own distinction (`""` against `null`), and
 * folding it in here would let a caller lose it by accident. `deckStats` keeps both.
 *
 * Scryfall's array can also carry `"2"` — the two-generic half of a `{2/W}`-style producer — and
 * every letter that is not one of the six is dropped rather than guessed at, which is the same
 * rule `addPips` keeps for a symbol it does not know.
 */
export function producedKeys(produced: string | null): ManaKey[] {
  if (produced === null || produced === "") return [];
  const seen = new Set<string>();
  for (const letter of produced) seen.add(letter);
  return MANA_KEYS.filter((key) => seen.has(key));
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

/**
 * One printed cost's coloured symbols, by colour — {@link MANA_KEYS}' six, every one present and
 * every one a number.
 *
 * A `Record` rather than a `Map`, because the vocabulary is closed and the bar draws it in
 * `MANA_KEYS` order: a colour with no pips is a `0` here and no segment on screen, which is a
 * different fact from a colour the counter has never heard of.
 */
export type PipCounts = Record<ManaKey, number>;

/**
 * A count with nothing in it yet — six zeroes.
 *
 * **Written out rather than built from {@link MANA_KEYS}, and the literal is the fence.** A
 * seventh key added to that tuple makes this line a type error, where an
 * `Object.fromEntries(MANA_KEYS.map(…)) as PipCounts` would have satisfied the compiler with a
 * record missing an entry — and a missing entry reads as `undefined + copies` and poisons the
 * whole count with `NaN` the first time a card asks for that colour.
 */
export function emptyPips(): PipCounts {
  return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
}

/** The six keys a pip can be, as a set the tokeniser can ask about one half at a time. */
const PIP_KEYS: ReadonlySet<string> = new Set<string>(MANA_KEYS);

/** Is this brace-less half one of the six? A predicate rather than a bare `has` at the call
 *  site, so the accumulator below can be indexed with no cast. */
function isPipKey(token: string): token is ManaKey {
  return PIP_KEYS.has(token);
}

/**
 * Fold one printed cost into `into`, `copies` times.
 *
 * **Accumulating rather than answering, because the caller folds a whole gallery.** The deck
 * overview counts every deck's pips at once, and `deck_pip_costs` hands it one `(cost, copies)`
 * pair per distinct cost per deck — 90 rows for the dev database's four decks, measured
 * 2026-09-07 — so a function that allocated a fresh record per pair would allocate ninety and
 * throw eighty-nine away. {@link countPips} is this one *with* the allocation, for the
 * single-cost question.
 *
 * The rules, and only one of them is a decision rather than a reading:
 *
 * * **A coloured symbol is one pip of its colour.** `{W}` is a W.
 * * **A hybrid is one pip of _each_ half** — `{W/U}` is a W *and* a U, so a Boros Charm and a
 *   `{R/W}` cost say the same thing about the deck holding them. It is a cost the reader may pay
 *   either way, so neither half is truer than the other; the bar answers **what does this deck
 *   want**, not what will be spent. Halving the pip, or picking the side the deck has more of,
 *   would be this module inventing an answer the cardboard deliberately leaves open.
 * * **A twobrid is its colour and a Phyrexian is its colour**: `{2/W}` is a W, `{W/P}` is a W,
 *   `{W/U/P}` is a W and a U. Those are not three more rules — they fall out of the hybrid one,
 *   because every half that names a colour counts and every half that does not is skipped, and
 *   `2` and `P` are halves that do not.
 * * **`{C}` is a pip**, and it is the colourless one. It is a demand for a real kind of mana,
 *   which is exactly what separates it from the generic below.
 * * **Generic is not a pip.** `{2}`, `{X}`, `{Y}`, `{Z}`, `{S}`, `{E}`, `{T}`, `{Q}` and
 *   everything else these six keys do not name contribute nothing — the issue's own instruction
 *   ("ignore general mana cost"), and the right one: generic mana says how *much* a card costs
 *   and this is asking *what* it costs.
 * * **A split or double-faced cost is one string** (`"{1}{R} // {1}{U}"`) and every symbol in it
 *   counts, which is {@link hasVariableCost}'s reading of the same shape: a card that can be
 *   cast either way wants both. The `//` between them is not a symbol, so the tokeniser walks
 *   past it with nothing to do.
 *
 * `null` and `""` are both an empty count, exactly as they are for {@link hasVariableCost}: an
 * empty cost is the **land** case — Scryfall gives a transform's back face `""` and
 * `.storybook/fake/cards.ts` seeds `""` for lands — so it is a cost with no symbols rather than
 * a cost nobody knows. A pile of nothing but basics therefore counts to six zeroes, which is
 * what lets the bar draw *nothing* for it rather than a grey rule saying so.
 *
 * It goes through {@link SYMBOL} rather than a regex of its own, and that is
 * {@link hasVariableCost}'s rule for its reason: a second, looser spelling of "what is a symbol"
 * is exactly how the two drift.
 */
export function addPips(into: PipCounts, cost: string | null, copies: number): void {
  if (!cost) return;
  for (const match of cost.matchAll(SYMBOL)) {
    // Uppercased for the reason `hasVariableCost` lowercases — nothing guarantees the case a
    // cost arrives in — and split on `/` because that is the whole of what a hybrid, a twobrid
    // or a Phyrexian token is: a list of halves, each of which either names a colour or does not.
    for (const half of match[1].toUpperCase().split("/")) {
      if (isPipKey(half)) into[half] += copies;
    }
  }
}

/** One cost's pips on their own — {@link addPips} into a fresh count, one copy of the card. */
export function countPips(cost: string | null): PipCounts {
  const counts = emptyPips();
  addPips(counts, cost, 1);
  return counts;
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
