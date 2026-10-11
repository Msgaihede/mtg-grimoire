import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { UserConfig } from "vite";
// Ships one format of the icon fonts instead of five — worth ~5 MB of the bundle. Both the
// rewrite and its `id` filter live in the shared UI so the test suite covers them; see
// `packages/ui/lib/iconFont.ts` for why, and `iconFont.test.ts` for the guarantee that it
// leaves every glyph class alone.
import { woff2IconFonts } from "./packages/ui/lib/iconFont.ts";
import { releaseDates } from "./packages/ui/lib/releaseDates.ts";
import { WATCH_IGNORED } from "./vite.watch.ts";

// **This file's own address, held in a name — and that is what lets the file be tested.** Written
// in place as the second argument of the two `new URL` calls below, it makes each of them an
// asset reference to a page's build: Vite rewrites the path into an address on the dev server,
// and Vitest then swaps the base for `self.location`. The suite's jsdom is a page to both, so
// imported by `scripts/vite-base.test.ts` the repository came out as an address under
// `http://localhost:3000/` and `fileURLToPath` threw before an assertion ran (2026-10-08).
// Vite's own `@vite-ignore` mark stops the first rewrite and not the second, which reads no
// marks. Neither recognises a name. Loaded as a config, this file is bundled by Vite's loader,
// which rewrites nothing either way.
const HERE = import.meta.url;

/** The repository root: where `node_modules`, the lockfile and any `.env` file are. */
export const REPO = fileURLToPath(new URL("./", HERE));
/** What `@/*` means, as `tsconfig.base.json`'s `paths` and `components.json`'s aliases say. */
export const UI = fileURLToPath(new URL("./packages/ui", HERE));

// Read Node's environment without adding its ambient globals to the webview programs.
const host = (
  globalThis as typeof globalThis & {
    process: { env: Record<string, string | undefined> };
  }
).process.env.TAURI_DEV_HOST;

/**
 * The build's own version and every release's day, for the light edition's Updates panel
 * (`packages/ui/lib/appVersion.ts`). A light host has no updater to ask its version of, so the
 * page is told at build time: the root manifest's version is the one release-please bumps with
 * every host's, and the days are its log's headings (`releaseDates.ts` has why from there).
 */
const VERSION: string = JSON.parse(readFileSync(`${REPO}package.json`, "utf8")).version;
const RELEASE_DATES = releaseDates(readFileSync(`${REPO}CHANGELOG.md`, "utf8"));

// What the three apps' configs and `vitest.config.ts` are merged over. It sets no `root`: each
// app's config names its own folder, and Vitest's is the repository.
export default {
  plugins: [woff2IconFonts(), react(), tailwindcss()],

  // Replaced in every program built over this file — the three apps, Vitest and Storybook — so the
  // page that reads them never meets them undefined.
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(VERSION),
    // A string of JSON, parsed by the page: Vitest hands an `import.meta.env` key over as a
    // string, so an object defined here arrives there as `[object Object]`.
    "import.meta.env.VITE_RELEASE_DATES": JSON.stringify(JSON.stringify(RELEASE_DATES)),
  },

  resolve: {
    alias: { "@": UI },
    // One copy of each, whichever package's import reached it first. pnpm already gives every
    // package the same files — the three builds were byte for byte the same with and without
    // this line, 2026-10-08 — so it holds nothing today; it is here for the day two packages
    // declare different ranges and a second React would otherwise be a silent second context.
    // Resolved from each program's root: every app declares the first two, and the root manifest
    // declares all three for the programs rooted there (Vitest, Storybook) and for the two apps
    // that do not import the query library themselves.
    dedupe: ["react", "react-dom", "@tanstack/react-query"],
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
    //    line taken out. Each app has a `package.json` of its own since 2026-10-08, and
    //    `pnpm-workspace.yaml` at the root is what Vite's default now finds.
    //    `scripts/vite-base.test.ts` holds the line.
    fs: { allow: [REPO] },
  },
} satisfies UserConfig;
