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
 */

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

/** The default: what a new label's picker opens on, and what an unreadable stored colour draws
 *  as. */
export const DEFAULT_LABEL_COLOR = LABEL_COLORS[0];

/**
 * The six words `deck_labels.color` held until 2026-08-20, and the colours they drew.
 *
 * **A read path only.** Nothing writes a token any more — the picker writes hex, and a rename
 * sends back whatever the row already had — so this map exists to keep a database older than the
 * build from going grey, and for no other reason. It is frozen at six entries by definition: a
 * seventh token never existed to be stored.
 */
export const LEGACY_TOKENS: Readonly<Record<string, string>> = {
  gold: "#d9b95c",
  bone: "#f8e7b9",
  azure: "#0e68ab",
  slate: "#c8c4bf",
  ember: "#d3202a",
  moss: "#00733e",
};

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * A stored colour as `#rrggbb` lowercase, or `null` for one this build cannot read.
 *
 * Total over three shapes, because all three arrive: a hex with or without the `#` (the field
 * lets a reader type either), a three-digit shorthand (`#f00`, which a reader typing by hand
 * will try), and one of {@link LEGACY_TOKENS}. `null` is the honest answer for anything else, and
 * it is what lets the *field* refuse a half-typed colour while {@link labelColorCss} still draws
 * something.
 */
export function normalizeLabelColor(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  const legacy = LEGACY_TOKENS[trimmed.toLowerCase()];
  if (legacy) return legacy;
  const match = HEX.exec(trimmed);
  if (!match) return null;
  const digits = match[1].toLowerCase();
  // `#f00` and `#ff0000` are the same colour, and only one of them is a shape the rest of the
  // app has to know about.
  return digits.length === 3
    ? `#${digits[0]}${digits[0]}${digits[1]}${digits[1]}${digits[2]}${digits[2]}`
    : `#${digits}`;
}

/** One label's colour as CSS. Total: every string is answered, including `null` and a colour from
 *  a build this one has never seen. */
export function labelColorCss(color: string | null): string {
  return normalizeLabelColor(color) ?? DEFAULT_LABEL_COLOR.hex;
}

/** The six digits, uppercase, for the picker's hex field — where the `#` is drawn beside the box
 *  rather than typed into it. */
export function labelColorHex(color: string | null): string {
  return labelColorCss(color).slice(1).toUpperCase();
}

/**
 * What is legible printed on {@link labelColorCss}'s answer.
 *
 * **Computed now, where it used to be a seventh column on each of six rows.** A label was an 8px
 * dot for as long as nothing was written on one, and a dot needs no foreground; the deck stack's
 * quantity tag is a *filled* mark in the label's own colour with the copy count printed on it, so
 * every colour has to answer what reads on it — and once the reader picks the colour, no table
 * can hold the answer in advance.
 *
 * The formula is the one whose numbers that retired table was built from: the sRGB channels
 * weighted 0.2126/0.7152/0.0722 **without** linearisation, which is what put `#f8e7b9` at 0.91
 * and `#0e68ab` at 0.35 in its own doc. At or above 0.55, the app's near-black; below it, the
 * app's text colour. Kept rather than swapped for WCAG relative luminance because the six
 * hand-made answers are the specification here — `labelColors.test.ts` asserts every one of them
 * unchanged, and a "more correct" curve that flips one of the six is a regression on a screen
 * somebody looked at.
 */
export function labelFgCss(color: string | null): string {
  const hex = labelColorCss(color);
  const channel = (at: number) => parseInt(hex.slice(at, at + 2), 16) / 255;
  const luma = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luma >= 0.55 ? "var(--color-accent-fg)" : "var(--color-text)";
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
