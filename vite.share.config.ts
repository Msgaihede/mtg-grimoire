import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";

/**
 * The **public web viewer**'s build — the third Vite config in this repo, after the app's and the
 * web target's.
 *
 * It produces `dist-share/`, which `share-worker/wrangler.jsonc` serves through its `assets`
 * binding. A static asset request is free and unlimited even on the Workers free plan, which is
 * what keeps a share that goes viral off the account's 100,000-request/day budget — the cliff
 * every paying reader's sync shares (spec §7.1).
 */
/**
 * Drops the built `index.html`.
 *
 * Rollup needs an HTML entry to find the script, and `share/index.html` is that entry — but the
 * page a reader lands on is **rendered by the Worker** from a D1 row, because that is what
 * carries the OpenGraph card. Shipping the dev shell as well would put a second, useless page on
 * the same public host: one that fetches the committed golden from a path only the dev server
 * serves, and answers "could not be loaded" to anyone who found it.
 */
function dropDevShell() {
  return {
    name: "share:drop-dev-shell",
    // `post`, because Vite's own `vite:build-html` emits the document in *its* `generateBundle`
    // and hooks run in plugin order — an unenforced plugin here deletes a file that has not been
    // emitted yet, and succeeds silently.
    enforce: "post" as const,
    generateBundle(_options: unknown, bundle: Record<string, { type: string }>) {
      for (const [name, item] of Object.entries(bundle))
        if (item.type === "asset" && name.endsWith(".html")) delete bundle[name];
    },
  };
}

export default mergeConfig(
  base,
  defineConfig({
    plugins: [dropDevShell()],
    // ⚠️ **The root stays the repository root.** `resolve.alias`' `"@": "/src"` is *root-relative*
    // in Vite, so `root: "share"` would quietly resolve every `@/…` against `share/` — the entry
    // is named below instead, which is the whole difference.
    //
    // Which core the bundle talks to. **`"web"` is required rather than cosmetic**:
    // `src/lib/core/index.ts` and `src/pwa/target.ts` read `__CORE__` at module scope and a
    // bundle without it fails to build. It is also what makes `cardArtSrc` prefer the URL the
    // snapshot carries over the `mtgimg://` protocol a browser has never heard of.
    define: { __CORE__: JSON.stringify("web") },

    build: {
      outDir: "dist-share",
      emptyOutDir: true,
      rollupOptions: {
        input: "share/index.html",
        output: {
          // ⚠️ **`assets/share.js` is pinned, not hashed, and this is the single easiest way to
          // ship a blank page.** `share-worker/src/page.ts` writes
          // `<script type="module" src="/assets/share.js">` into every shell by a **fixed**
          // name: it is built from a D1 row and cannot afford the extra read a Vite manifest
          // would cost. A content hash here loads nothing, with no error anywhere.
          //
          // Only the entry is pinned. Chunks and assets keep their hashes — nothing points at
          // them by name, and the fonts want a cacheable URL.
          entryFileNames: "assets/share.js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },

    // Not 1420 (`tauri dev`, hardcoded in tracked files), not 5173 (the web target), not 6006
    // (Storybook). All four have to be able to run at once.
    server: { port: 5174, strictPort: true },
  }),
);
