/**
 * Set symbols, from the bundled `keyrune` icon font.
 *
 * The class is a pure function of the set code, which is why it is derived here rather
 * than sent by Rust: a CSS class name is presentation, and the data layer has no business
 * knowing one.
 */

/** Set codes are lowercase alphanumerics; anything else is not one and gets no glyph. */
const SET_CODE = /^[a-z0-9]+$/;

/**
 * The `keyrune` classes for a set's symbol, or `""` when there is nothing safe to render.
 *
 * keyrune ships 441 sets and Scryfall knows ~1 050, so a code with no glyph of its own is
 * routine rather than exceptional — and it needs no handling here, because the font
 * already handles it: `.ss:before` carries a generic set symbol that any `.ss-<unknown>`
 * falls back to. The alternative would be a 441-entry lookup table in this app, going
 * stale every time a set is printed. Call sites show the code as text as well, so the set
 * is identifiable either way.
 */
export function setGlyphClass(code: string): string {
  const key = code.trim().toLowerCase();
  return SET_CODE.test(key) ? `ss ss-${key}` : "";
}
