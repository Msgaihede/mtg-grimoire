import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";

/**
 * The web target's build. Everything the desktop build does, plus four differences.
 *
 * **One `index.html` and one `main.tsx` serve both**, which is why this is a merge rather
 * than a second project: the only thing that differs at the entry point is `__CORE__`, and
 * the branch it selects folds away in each bundle.
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
  }),
);
