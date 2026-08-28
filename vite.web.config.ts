// The web target's build.
//
// Type-stripped by Vite and checked by nothing, exactly like `vite.config.ts` — see
// `tsconfig.node.json`'s comment for why that project deliberately lists one file and why
// widening it breaks `npm run build` on a clean checkout. The decisions the PWA half of this
// file makes live under `src/pwa/` where the suite covers them; what stays here is the
// filesystem, which nothing under `src/` may touch (the absent `@types/node` is the fence).
import { readFileSync } from "node:fs";
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";
import { webAssetsPlugin } from "./src/pwa/webAssets";

/** The two raster sizes the manifest names, read from the tracked masters in `logos/png/`. */
const icons = ["mark-256.png", "mark-512.png"].map((name) => ({
  fileName: `icons/${name}`,
  source: new Uint8Array(readFileSync(`logos/png/${name}`)),
}));

/**
 * The web target's build. Everything the desktop build does, plus five differences.
 *
 * **One `index.html` and one `main.tsx` serve both**, which is why this is a merge rather
 * than a second project: the only thing that differs at the entry point is `__CORE__`, and
 * the branch it selects folds away in each bundle. The PWA shell is the fifth difference and
 * keeps that property — the manifest link, the theme colour and the icons are *emitted* by a
 * plugin that only this config installs, so `index.html` itself stays untouched and a desktop
 * build produces the same document it always did.
 *
 * `publicDir` points at a directory that is **generated in full** — `scripts/build-wasm.mjs`
 * writes the wasm module there and copies the favicon in beside it. That is what keeps a
 * 2 MB wasm module out of the desktop bundle, and therefore out of the portable exe, on a
 * machine where someone has run the wasm build.
 *
 * Port 5173 is Vite's own default and the one the spike served its probes on. It is not
 * 1420: that is `tauri dev`'s, it is hardcoded in tracked files, and the two must be able to
 * run at once.
 *
 * `clearScreen` and `envPrefix` come from the base config and are Tauri's; they are harmless
 * here and left alone rather than unset, so this file stays a list of real differences.
 */
export default mergeConfig(
  base,
  defineConfig({
    publicDir: "web/public",
    define: { __CORE__: JSON.stringify("web") },
    build: { outDir: "dist-web", emptyOutDir: true },
    server: { port: 5173, strictPort: true },
    plugins: [
      webAssetsPlugin({
        markSvg: readFileSync("public/mtg-grimoire-mark.svg", "utf8"),
        icons,
      }),
    ],
  }),
);
