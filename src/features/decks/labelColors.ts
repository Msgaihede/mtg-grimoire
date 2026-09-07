/**
 * What a deck label's stored colour is: a **hex string**, `#rrggbb`.
 *
 * `deck_labels.color` holds whatever word the webview hands it — the backend checks only that it
 * is non-empty, because picking what a colour *is* belongs to the webview (CLAUDE.md's Rust/TS
 * boundary) and this file owns that decision. What it hands over changed on 2026-08-20: it used
 * to be a **token** from a fixed palette of six, and it is now the colour itself.
 *
 * **The six are still here and still first**, as {@link LABEL_COLORS} — they are the frame/pie
 * deeps the visual direction sanctions "for identity pips", they are what the quick row of the
 * picker offers, and a reader who never opens the wheel writes one of them and nothing else. The
 * change is that the wheel and the hex field beside them can now write a colour that is not one
 * of the six, which a token could not express: a label is the one thing on a deck screen whose
 * meaning is the reader's rather than the game's, and "cut candidate" wanting a purple no card
 * frame has is a reasonable thing for a reader to want.
 *
 * **What it costs, stated rather than discovered**: a stored hex does not follow the theme. While
 * the token lasted, retiring `--color-pie-u` would have moved every azure label in the database
 * with it; a hex written today is that colour for as long as the row lives. The app has one
 * palette and one `:root`, so nothing has ever moved under a label — but the day one does, these
 * rows will not, and that is the trade the picker was worth.
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
 * the reader picked in Settings, and `src/lib/` may not import from `src/features/`. What stayed
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
 * The quick row of the colour picker: the app's own colour identity deeps, verbatim from
 * `--color-pie-*` in `src/index.css`.
 *
 * **Literal hexes rather than `var(--color-pie-*)`, and that is the whole of what the storage
 * change means here.** These strings are *written to the database* when a reader presses one, so
 * they cannot be a reference to something a stylesheet decides later — a `var()` in a column is a
 * colour with no value outside this build. They are duplicated from `index.css` deliberately, and
 * `labelColors.test.ts` is what keeps the two honest.
 *
 * A label dot is 10px, the same scale as a rarity gem, so the direction's boldness budget is
 * untouched however loud a reader's own choice is: the loud colour on a deck screen is still the
 * card art.
 */
export const LABEL_COLORS: readonly LabelColorChoice[] = [
  { hex: "#d9b95c", label: "Gold" },
  { hex: "#f8e7b9", label: "Bone" },
  { hex: "#0e68ab", label: "Azure" },
  { hex: "#c8c4bf", label: "Slate" },
  { hex: "#d3202a", label: "Ember" },
  { hex: "#00733e", label: "Moss" },
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
 * wears when the card carries no label at all — the colourless deep, grey being the whole point,
 * since a filled mark has to be *some* colour and an unlabelled one in gold would stop gold
 * meaning "there is a label here". That reason survives unchanged; what changed is that the
 * search wall draws the same mark over cards that have no labels at all, so the neutral fill is a
 * fact about the mark rather than about this palette. It was never {@link DEFAULT_LABEL_COLOR},
 * which answers a different question — the colour of a label this build cannot read, and such a
 * label is still a label.
 */
