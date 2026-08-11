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

/** The palette, in the order a picker offers it. */
export const TAG_COLORS: readonly { token: string; label: string; css: string }[] = [
  { token: "gold", label: "Gold", css: "var(--color-pie-gold)" },
  { token: "bone", label: "Bone", css: "var(--color-pie-w)" },
  { token: "azure", label: "Azure", css: "var(--color-pie-u)" },
  { token: "slate", label: "Slate", css: "var(--color-pie-c)" },
  { token: "ember", label: "Ember", css: "var(--color-pie-r)" },
  { token: "moss", label: "Moss", css: "var(--color-pie-g)" },
];

/** The default, used for a tag with no colour and for one whose token this build has never
 *  heard of. */
export const DEFAULT_TAG_COLOR = TAG_COLORS[0];

/** One tag's colour as CSS. Total: every string is answered, including `null`. */
export function tagColorCss(token: string | null): string {
  return (TAG_COLORS.find((c) => c.token === token) ?? DEFAULT_TAG_COLOR).css;
}
