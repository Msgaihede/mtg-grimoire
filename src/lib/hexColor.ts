/**
 * How a stored colour is read, and what reads legibly printed on one.
 *
 * **Every line of this file came out of `features/decks/labelColors.ts` on 2026-09-07, and the
 * move is a layering fix rather than a tidy.** `useMarkColors` has to pick a foreground for a
 * colour the reader chose in Settings, which is exactly the question {@link labelFgCss} already
 * answers — and `src/lib/` importing from `src/features/` inverts this tree's direction, since a
 * module every surface may reach for must not depend on one surface's folder. So the four things
 * that are about a **hex string** live here, and `labelColors.ts` re-exports every one of them:
 * no existing caller changed, and `labelColors.test.ts` still passes unaltered, which is what
 * makes the move checkable rather than merely plausible.
 *
 * **What did not move is what is about a _label_** — the six quick picks the picker offers, their
 * display names, and the uppercase six digits its hex field draws. Those are that surface's
 * vocabulary and belong with the surface.
 *
 * {@link LEGACY_TOKENS} came with the functions because {@link normalizeLabelColor} is *total*
 * over it and the two cannot be separated. It is deck-label history, kept verbatim; that it is
 * now filed under a general name changes nothing about what it is for.
 */

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

/** `#rrggbb` or `#rgb`, with the hash optional — the three shapes a reader's field can hold. */
export const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * What a colour this build cannot read is drawn as: the label picker's own first swatch.
 *
 * **It is spelled here as well as in `LABEL_COLORS[0]`, and `labelColors.test.ts` is the fence
 * that keeps the two the same colour** — that suite asserts
 * `labelColorCss(null) === DEFAULT_LABEL_COLOR.hex`, so a palette edit that moved the picker's
 * gold and left this behind is a red build rather than a dot in a colour the app no longer uses.
 * The alternative — importing the picker's array back into this file — is the import direction
 * this module exists to remove.
 */
export const FALLBACK_HEX = "#d9b95c";

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
  return normalizeLabelColor(color) ?? FALLBACK_HEX;
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
 *
 * **Its second caller since 2026-09-07 is `useMarkColors`**, which is what brought this function
 * into `lib/`: a mark the reader has recoloured prints a tick or a signed number on itself, so a
 * pale custom green needs the same answer a pale label does.
 */
export function labelFgCss(color: string | null): string {
  const hex = labelColorCss(color);
  const channel = (at: number) => parseInt(hex.slice(at, at + 2), 16) / 255;
  const luma = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luma >= 0.55 ? "var(--color-accent-fg)" : "var(--color-text)";
}
