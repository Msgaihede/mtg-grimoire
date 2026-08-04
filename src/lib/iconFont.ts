/**
 * Trim the icon fonts' `@font-face` rules down to woff2.
 *
 * Build-time code — `vite.config.ts` is its only caller. It lives under `src/` so it is
 * covered by the test suite rather than only by whatever the last build happened to emit,
 * and the plugin wrapper lives here with it for the same reason: the `id` filter is half
 * of what makes this work, and a filter that stops matching is a silent 5 MB regression.
 * Nothing in the app imports either, so neither is in the bundle.
 *
 * `mana-font` and `keyrune` date from the eot/svg era: their `src` lists name
 * eot + woff + ttf + svg, and `mana.css` never references the `mana.woff2` sitting in the
 * same folder. Vite emits every file a `url()` names whether or not a browser will ever
 * ask for it, so importing those stylesheets unedited puts ~5 MB of dead weight in the
 * bundle — `mana.svg` alone is 1.9 MB — for a WebView2 target that has supported woff2
 * since it existed.
 *
 * Rewriting the `src` rather than vendoring a trimmed copy of the CSS keeps node_modules
 * the source of truth: `keyrune` ships a new `.ss-<code>` class every time a set is
 * printed, and a vendored copy would go stale on the next `npm update`. Only `@font-face`
 * blocks are touched; every glyph class passes through untouched.
 */

/**
 * Magic's card-text face, which `mana.css` declares for four `.ms-…` text classes this
 * app does not use. It ships no woff2, so it cannot be trimmed — it is dropped, and those
 * classes keep working on the Garamond/Palatino stack the same rules already name.
 */
const UNUSED_FAMILY = "MPlantin";

export function woff2Only(css: string): string {
  return css.replace(/@font-face\s*\{[^}]*\}/g, (block) => {
    const family = /font-family:\s*['"]?([\w-]+)/.exec(block)?.[1];
    if (!family) return block;
    if (family === UNUSED_FAMILY) return "";
    // Both declarations at once: these files carry an `src: url(…eot)` shim line ahead of
    // the real multi-format list, and leaving it would re-emit the eot.
    return block.replace(
      /src:[^;]*;\s*(?:src:[^;]*;)?/,
      `src: url("../fonts/${family.toLowerCase()}.woff2") format("woff2");`,
    );
  });
}

/**
 * `mana-font/css/mana.css` and `keyrune/css/keyrune.css`, however they are imported —
 * posix or Windows separators, but never with a query suffix. `?raw` is how
 * `iconFont.test.ts` reads these files as they ship, and transforming that would have the
 * test grade its own output.
 */
const ICON_FONT_CSS = /node_modules[\\/](mana-font|keyrune)[\\/]css[\\/][^\\/?]+\.css$/;

/**
 * The Vite plugin: ship one format of the icon fonts instead of five.
 *
 * `enforce: "pre"` so this runs before Vite's CSS plugin turns the `url()`s into emitted
 * assets. It only sees these files because `main.tsx` imports them — an `@import` from
 * `index.css` is inlined by Tailwind before Vite resolves it as a module, and the rules
 * would never reach a transform hook.
 */
export function woff2IconFonts() {
  return {
    name: "woff2-icon-fonts",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (!ICON_FONT_CSS.test(id)) return null;
      return { code: woff2Only(code), map: null };
    },
  };
}
