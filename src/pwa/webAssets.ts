// Type-only: `vite` is a devDependency and this import leaves nothing behind at runtime.
import type { Plugin } from "vite";
import { MANIFEST_PATH, manifestJson } from "./manifest";

/** A PNG the config read off disk, with the name it should have in the bundle. */
export interface IconFile {
  fileName: string;
  source: Uint8Array;
}

/** The one thing `generateBundle` uses off Rollup's plugin context. Named so a test can hand
 *  the hook a two-line stand-in rather than a whole `PluginContext`. */
export interface AssetEmitter {
  emitFile: (file: { type: "asset"; fileName: string; source: string | Uint8Array }) => void;
}

/**
 * The plugin, with its two hooks narrowed to the plain functions they are.
 *
 * `Plugin` types both as an `ObjectHook` — either a function or a `{ order, handler }` pair —
 * which is right for a consumer and useless for a caller: `plugin.transformIndexHtml(html)` does
 * not type-check against a union that might be an object. Narrowing here keeps both halves
 * honest: Vite still accepts it (a bare function is one arm of that union) and the suite can
 * call the hooks directly, which is the only way to test them without running a build.
 */
export interface WebAssetsPlugin extends Plugin {
  transformIndexHtml: (html: string) => string;
  generateBundle: (this: AssetEmitter) => void;
}

/** The master's own transform, verbatim. Changing the artwork changes this, which is the point. */
const MASTER_SCALE = "scale(0.9200)";

/**
 * How much of the master's scale survives into the maskable icon: `0.8000`.
 *
 * **The arithmetic, so nobody has to guess at it again.** A maskable icon is cropped by the
 * platform to a shape inscribed in a circle of radius 40% of the frame, so the artwork has to
 * sit inside that circle. `logos/README.md` measures the master's clear space at 12/64, which
 * puts the book across 40/64 = 0.625 of the frame; a square of side *c* has a circumscribed
 * circle of radius *c*·√2/2, so *c* ≤ 0.566 is the requirement. 0.625 × (0.80/0.92) = 0.543,
 * whose circle is 0.384 — inside 0.40 with room for the book being taller than it is wide.
 *
 * The book therefore fills 54% of a maskable tile against 62% of the transparent mark. That is
 * what maskable costs, not a mistake.
 */
const MASKABLE_SCALE = "scale(0.8000)";

/** `--color-bg`, resolved. A maskable icon is full-bleed by definition: transparency there is
 *  a hole the platform fills with whatever it likes. */
const FIELD = '<rect width="64" height="64" fill="#0C0D12"></rect>';

/**
 * The maskable icon, derived from the master rather than drawn again.
 *
 * `logos/README.md` says the master is the artwork to edit, so a second hand-drawn copy would
 * be a file guaranteed to rot. Two edits: a full-bleed field behind everything, and the
 * mark shrunk into the safe zone.
 *
 * It **throws** rather than returning something plausible when the master no longer carries the
 * transform it is looking for. A silent miss here is a dark square on a reader's home screen,
 * and nothing in a build log would say so.
 */
export function maskableFromMark(markSvg: string): string {
  if (!markSvg.includes(MASTER_SCALE)) {
    throw new Error(
      `the master mark no longer contains ${MASTER_SCALE}; the maskable icon cannot be derived ` +
        `from it. Re-derive MASKABLE_SCALE from the new transform — see src/pwa/webAssets.ts.`,
    );
  }
  const scaled = markSvg.replace(MASTER_SCALE, MASKABLE_SCALE);
  // After `</defs>`, so the field paints under the artwork and over nothing.
  return scaled.replace("</defs>", `</defs>${FIELD}`);
}

/** `<link>` and `<meta>` for the head, as one string. */
const HEAD = [
  `<link rel="manifest" href="/${MANIFEST_PATH}" />`,
  `<meta name="theme-color" content="${manifestJson().theme_color}" />`,
  // iOS ignores the manifest's icons entirely and reads this instead.
  `<link rel="apple-touch-icon" href="/icons/mark-256.png" />`,
].join("");

/**
 * Everything the web build adds to the bundle that the app itself never imports.
 *
 * A plugin **factory taking file contents** rather than a plugin that reads them, for
 * `src/lib/iconFont.ts`'s reason stated the other way round: that module gets to live under
 * `src/` because it needs no filesystem, and this one gets to live here because the filesystem
 * stays in `vite.web.config.ts`. Nothing under `src/` may import `node:fs` — the absent
 * `@types/node` is the fence, and it is the only one.
 */
export function webAssetsPlugin({
  markSvg,
  icons,
}: {
  markSvg: string;
  icons: IconFile[];
}): WebAssetsPlugin {
  return {
    name: "grimoire-web-assets",
    transformIndexHtml(html: string) {
      return html.replace("</head>", `${HEAD}</head>`);
    },
    generateBundle(this: AssetEmitter) {
      this.emitFile({
        type: "asset",
        fileName: MANIFEST_PATH,
        source: JSON.stringify(manifestJson(), null, 2),
      });
      this.emitFile({
        type: "asset",
        fileName: "icons/maskable.svg",
        source: maskableFromMark(markSvg),
      });
      for (const icon of icons) {
        this.emitFile({ type: "asset", fileName: icon.fileName, source: icon.source });
      }
    },
  };
}
