/**
 * Magic's colour pie, as the interface uses it.
 *
 * The direction doc's thesis: colour appears only where it carries Magic meaning. This
 * module is the whole of that vocabulary — the five (plus colourless) symbol keys, the
 * `mana-font` class names that draw them, and the gradient behind the app's one signature
 * element. Nothing else in the app invents a colour.
 */
import type { SyncPhase, SyncProgressEvent } from "@/lib/ipc";
import { PHASE_LABEL } from "@/lib/useSyncProgress";

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
  // Not mana, printed in mana's company.
  ...tokens("tap untap infinity 1-2"),
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

/** What the mana line is showing, or `null` when it is just a line. */
export interface ManaLineSync {
  /** 0–1, or `null` for a phase with no denominator. */
  value: number | null;
  label: string;
}

/**
 * Fold a sync into what the line should draw.
 *
 * `busy` decides, not the event: a run inside the 24 h check window emits nothing at all,
 * and Tauri drops the events emitted before the webview started listening — so an event
 * is evidence of progress, never of running. `done` and `error` are terminal phases whose
 * event can outlive the run by a poll interval, so they read as indeterminate rather than
 * as a full or empty bar.
 */
export function manaLineSync(
  progress: SyncProgressEvent | null,
  busy: boolean,
): ManaLineSync | null {
  if (!busy) return null;
  const phase: SyncPhase | null =
    progress && progress.phase !== "done" && progress.phase !== "error" ? progress.phase : null;
  if (!phase || !progress) return { value: null, label: "Syncing card data" };
  return {
    value: progress.total > 0 ? Math.min(1, progress.done / progress.total) : null,
    label: PHASE_LABEL[phase],
  };
}
