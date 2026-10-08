/**
 * What a deck label's stored colour is: a **hex string**, `#rrggbb`.
 *
 * `deck_labels.color` holds whatever word the webview hands it — the backend checks only that it
 * is non-empty, because picking what a colour *is* belongs to the webview (CLAUDE.md's Rust/TS
 * boundary) and this file owns that decision. What it hands over changed on 2026-08-20: it used
 * to be a **token** from a fixed palette of six, and it is now the colour itself.
 *
 * **The six are still here and still first**, as {@link LABEL_COLORS} — they are the app's own
 * mana colours and its gold, they are what the quick row of the picker offers, and a reader who
 * never opens the wheel writes one of them and nothing else. The
 * change is that the wheel and the hex field beside them can now write a colour that is not one
 * of the six, which a token could not express: a label is the one thing on a deck screen whose
 * meaning is the reader's rather than the game's, and "cut candidate" wanting a purple no card
 * frame has is a reasonable thing for a reader to want.
 *
 * **What it costs, stated rather than discovered**: a stored hex does not follow the theme. While
 * the token lasted, retiring a palette colour would have moved every label wearing it; a hex
 * written today is that colour for as long as the row lives. **That day came on 2026-09-28**, when
 * the saturated colour-identity deeps the six picks were copied from were retired and the picks
 * moved to the mana colours: every label a reader picked before then keeps the deep it was
 * stored with (`#0e68ab`, `#00733e` and the rest still draw exactly as they did), and only a
 * press made after it writes the new value. That is intended — a label's colour is the reader's
 * choice, and a build being newer is not a reason to repaint it.
 *
 * **Rows written before the change still read**, through {@link LEGACY_TOKENS}: six words, mapped
 * to the six hexes they always drew. That map is a read path and never a write one — nothing in
 * the app stores a token any more — and it does not expire, because a database is not migrated by
 * a build being newer than it.
 *
 * A colour this file cannot read at all — a token retired before the map, a truncated write — is
 * {@link DEFAULT_LABEL_COLOR} rather than nothing: a dot the reader cannot see is a label the
 * reader cannot find.
 *
 * **Four of those answers moved to `@/lib/hexColor` on 2026-09-07 and are re-exported below**,
 * so every caller of this file is untouched and this suite is unaltered. The reason is a layering
 * one and is written at that module: `useMarkColors` needs {@link labelFgCss} for a mark colour
 * the reader picked in Settings, and `packages/ui/lib/` may not import from `packages/ui/features/`. What stayed
 * is what is about a *label* rather than about a hex string — the six quick picks, their display
 * names, and the field's uppercase spelling.
 */

import { labelColorCss } from "@/lib/hexColor";

export {
  HEX,
  labelColorCss,
  labelFgCss,
  LEGACY_TOKENS,
  normalizeLabelColor,
} from "@/lib/hexColor";

/** One of the six the picker offers first. `hex` is `#rrggbb` lowercase, which is the shape
 *  everything stored goes in. */
export interface LabelColorChoice {
  hex: string;
  label: string;
}

/**
 * The quick row of the colour picker: the app's own mana colours, verbatim from `--color-mana-*`
 * in `packages/ui/index.css`, and its gold, `--color-accent` (2026-09-28 — they were the saturated
 * colour-identity deeps until those were retired, and a label stored before keeps its old hex).
 * Five of the six mana colours are here under the names the picks have always had; `mana-b` is
 * not, because Slate already stands for the grey end of the row.
 *
 * **Literal hexes rather than `var(--color-mana-*)`, and that is the whole of what the storage
 * change means here.** These strings are *written to the database* when a reader presses one, so
 * they cannot be a reference to something a stylesheet decides later — a `var()` in a column is a
 * colour with no value outside this build. They are duplicated from `index.css` deliberately, and
 * `labelColors.test.ts` is what keeps the two honest.
 *
 * **Gold is the accent converted, and exactly.** The accent is `oklch(0.75 0.12 85)`, which is in
 * the sRGB gamut, so it has one hex: OKLCh → OKLab (`a = C·cos h`, `b = C·sin h`) → linear sRGB
 * through Björn Ottosson's published OKLab matrices → the sRGB transfer curve → rounded to 8 bits
 * per channel, which is `#d1a84b` (209, 168, 75). The same pipeline gives `#56bd78` for
 * `--color-ok`, the conversion `index.css` already quotes, and the test does it again.
 *
 * **Every one of the six is pale**, so `labelFgCss` puts the app's near-black on each — the three
 * deeps that took light text (azure, ember, moss) are gone from the row, and a count printed on a
 * freshly picked label is dark ink throughout.
 *
 * A label dot is 10px, the same scale as a rarity gem, so the direction's boldness budget is
 * untouched however loud a reader's own choice is: the loud colour on a deck screen is still the
 * card art.
 */
export const LABEL_COLORS: readonly LabelColorChoice[] = [
  { hex: "#d1a84b", label: "Gold" },
  { hex: "#fffbd5", label: "Bone" },
  { hex: "#aae0fa", label: "Azure" },
  { hex: "#c8c4bf", label: "Slate" },
  { hex: "#f9aa8f", label: "Ember" },
  { hex: "#9bd3ae", label: "Moss" },
];

/**
 * The default: what a new label's picker opens on, and what an unreadable stored colour draws
 * as.
 *
 * The second half of that sentence is now spelled in two places — here, and as `FALLBACK_HEX` in
 * `@/lib/hexColor`, which is where {@link labelColorCss} went and which may not import this array
 * back. `labelColors.test.ts`' `labelColorCss(null) === DEFAULT_LABEL_COLOR.hex` is the fence
 * that keeps the two the same colour.
 */
export const DEFAULT_LABEL_COLOR = LABEL_COLORS[0];

/** The six digits, uppercase, for the picker's hex field — where the `#` is drawn beside the box
 *  rather than typed into it. */
export function labelColorHex(color: string | null): string {
  return labelColorCss(color).slice(1).toUpperCase();
}

/**
 * **`UNTAGGED_COLOR` used to live here and has moved to `components/CountTag.tsx`**, where it is
 * `NEUTRAL_COUNT_PAINT`. (The old spelling is kept as written: it is the name that constant
 * actually had, from the years this was called a tag.) It said what a mark in a label's colour
 * wears when the card carries no label at all — colourless, grey being the whole point,
 * since a filled mark has to be *some* colour and an unlabelled one in gold would stop gold
 * meaning "there is a label here". That reason survives unchanged; what changed is that the
 * search wall draws the same mark over cards that have no labels at all, so the neutral fill is a
 * fact about the mark rather than about this palette. It was never {@link DEFAULT_LABEL_COLOR},
 * which answers a different question — the colour of a label this build cannot read, and such a
 * label is still a label.
 */
