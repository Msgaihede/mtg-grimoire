/**
 * What a deck tag's stored colour looks like.
 *
 * `deck_tags.color` holds a **token from this palette**, never a hex string — the backend
 * stores whatever word the webview hands it, and picking what a colour *is* is the webview's
 * job. That is deliberate: a stored hex would outlive the theme, and a tag chosen against
 * last year's palette would come back as a colour this app no longer uses.
 *
 * The values are the frame/pie deeps the visual direction already sanctions "for identity
 * pips" — no new colour enters the palette to serve a label. A tag dot is 8px, which is the
 * same scale as a rarity gem, so the direction's boldness budget is untouched: the loud
 * colour on a deck screen is still the card art.
 *
 * `gold` is the default and the one the design canvas draws, and it is first for that
 * reason. An unknown token — a tag written by a newer build, or one whose palette entry has
 * been retired — falls back to it rather than to nothing: a dot the reader cannot see is a
 * label the reader cannot find.
 */

/**
 * ## Why each colour carries a foreground
 *
 * A tag was an 8px dot for as long as nothing was written on one, and a dot needs no
 * foreground. The deck stack's quantity tag is a *filled* mark in the tag's own colour with
 * the copy count printed on it — so every entry here now has to answer what is legible on it,
 * and one answer cannot serve the palette: it runs from `#f8e7b9` at 0.91 relative luminance
 * to `#0e68ab` at 0.35. Near-black on the three light deeps, the app's own text colour on the
 * three dark ones, which is the split a 0.55 luminance threshold makes.
 *
 * Stored rather than computed, because the values are `var(--color-pie-*)` and a luminance
 * cannot be read out of a CSS variable at render time — the number that would decide it only
 * exists in this file's own stylesheet.
 */
export const TAG_COLORS: readonly { token: string; label: string; css: string; fg: string }[] = [
  { token: "gold", label: "Gold", css: "var(--color-pie-gold)", fg: "var(--color-accent-fg)" },
  { token: "bone", label: "Bone", css: "var(--color-pie-w)", fg: "var(--color-accent-fg)" },
  { token: "azure", label: "Azure", css: "var(--color-pie-u)", fg: "var(--color-text)" },
  { token: "slate", label: "Slate", css: "var(--color-pie-c)", fg: "var(--color-accent-fg)" },
  { token: "ember", label: "Ember", css: "var(--color-pie-r)", fg: "var(--color-text)" },
  { token: "moss", label: "Moss", css: "var(--color-pie-g)", fg: "var(--color-text)" },
];

/** The default, used for a tag with no colour and for one whose token this build has never
 *  heard of. */
export const DEFAULT_TAG_COLOR = TAG_COLORS[0];

/**
 * **`UNTAGGED_COLOR` used to live here and has moved to `components/CountTag.tsx`**, where it is
 * `NEUTRAL_COUNT_PAINT`. It said what a mark in a tag's colour wears when the card carries no tag
 * at all — the colourless deep, grey being the whole point, since a filled mark has to be *some*
 * colour and an untagged one in gold would stop gold meaning "there is a tag here". That reason
 * survives unchanged; what changed is that the search wall draws the same mark over cards that
 * have no tags at all, so the neutral fill is a fact about the mark rather than about this
 * palette. It was never {@link DEFAULT_TAG_COLOR}, which answers a different question — the
 * colour of a tag whose token this build cannot read, and such a tag is still a tag.
 */

/** One tag's colour as CSS. Total: every string is answered, including `null`. */
export function tagColorCss(token: string | null): string {
  return (TAG_COLORS.find((c) => c.token === token) ?? DEFAULT_TAG_COLOR).css;
}

/** What is legible printed on {@link tagColorCss}'s answer, for the same token. */
export function tagFgCss(token: string | null): string {
  return (TAG_COLORS.find((c) => c.token === token) ?? DEFAULT_TAG_COLOR).fg;
}
