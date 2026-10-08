import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
// Ships one format of the icon fonts instead of five — worth ~5 MB of the bundle. Both the
// rewrite and its `id` filter live in the shared UI so the test suite covers them; see
// `packages/ui/lib/iconFont.ts` for why, and `iconFont.test.ts` for the guarantee that it
// leaves every glyph class alone.
import { woff2IconFonts } from "./packages/ui/lib/iconFont.ts";
import { WATCH_IGNORED } from "./vite.watch.ts";

// **This file's own address, held in a name — and that is what lets the file be tested.** Written
// in place as the second argument of the two `new URL` calls below, it makes each of them an
// asset reference to a page's build: Vite rewrites the path into an address on the dev server,
// and Vitest then swaps the base for `self.location`. The suite's jsdom is a page to both, so
// imported by `scripts/vite-base.test.mjs` the repository came out as an address under
// `http://localhost:3000/` and `fileURLToPath` threw before an assertion ran (2026-10-08).
// Vite's own `@vite-ignore` mark stops the first rewrite and not the second, which reads no
// marks. Neither recognises a name. Loaded as a config, this file is bundled by Vite's loader,
// which rewrites nothing either way.
const HERE = import.meta.url;

/** The repository root: where `node_modules`, the lockfile and any `.env` file are. */
export const REPO = fileURLToPath(new URL("./", HERE));
/** What `@/*` means, as `tsconfig.json`'s `paths` and `components.json`'s aliases say. */
export const UI = fileURLToPath(new URL("./packages/ui", HERE));

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// What the three apps' configs and `vitest.config.ts` are merged over. It sets no `root`: each
// app's config names its own folder, and Vitest's is the repository.
export default defineConfig({
  plugins: [woff2IconFonts(), react(), tailwindcss()],

  resolve: {
    alias: { "@": UI },
  },

  // An app's root is `apps/<name>`, and Vite looks for `.env` files in the root unless told.
  envDir: REPO,

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching the cargo hosts — and every other build output under the
      //    repository, where a watch on a file cargo is still writing kills the server on
      //    Windows. `vite.watch.ts` holds the list and the measurement.
      ignored: WATCH_IGNORED,
    },
    // 4. The shared UI is outside every app's root, and a dev server answers 403 for a file
    //    outside this list — a blank window, and a build never asks. Named rather than left to
    //    Vite's default, which is the nearest folder above the root holding a workspace file or,
    //    failing one, a `package.json`. Today that is the repository as well: measured
    //    2026-10-08, the share viewer's server still answered 200 for a shared file with this
    //    line taken out. It stops being so the day an app has a `package.json` of its own and
    //    nothing above it says workspace. `scripts/vite-base.test.mjs` holds the line.
    fs: { allow: [REPO] },
  },
});
