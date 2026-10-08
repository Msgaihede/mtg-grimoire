import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import base from "../../vite.base.ts";

/**
 * The **public web viewer**'s build — a Vite config of its own, merged over the shared base.
 *
 * It produces `apps/share/dist-share/`, which `infrastructure/share-worker/wrangler.jsonc` serves
 * through its `assets` binding. A static asset request is free and unlimited even on the Workers
 * free plan, which is what keeps a share that goes viral off the account's 100,000-request/day
 * budget — the cliff every paying reader's sync shares (spec §7.1).
 */
/**
 * Drops the built `index.html`.
 *
 * Rollup needs an HTML entry to find the script, and `index.html` beside this file is that entry
 * — but the page a reader lands on is **rendered by the Worker** from a D1 row, because that is
 * what carries the OpenGraph card. Shipping the dev shell as well would put a second, useless
 * page on the same public host: one that fetches the committed golden from a path only the dev
 * server serves, and answers "could not be loaded" to anyone who found it.
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

/** The dev shell's snapshot is the Rust golden, which is outside this root: `/@fs/` reaches it. */
function goldenSnapshot() {
  const golden = fileURLToPath(
    new URL("../desktop/src-tauri/src/share/__golden__/snapshot.json", import.meta.url),
  );
  return {
    name: "share:golden-snapshot",
    transformIndexHtml: (html: string) =>
      html.replace("%GOLDEN_SNAPSHOT%", `/@fs/${golden.replaceAll("\\", "/")}`),
  };
}

export default mergeConfig(
  base,
  defineConfig({
    // **The root is this folder**, so the entry below is named from here and `dist-share/` lands
    // beside it. It was the repository until 2026-10-08, and for a reason that no longer holds:
    // the `@` alias was the root-relative `"/src"`, so a root of `share` would quietly have
    // resolved every `@/…` against `share/`. The base config now spells the alias as an absolute
    // path (`vite.base.ts`' `UI`), which means the same folder from any root.
    root: fileURLToPath(new URL("./", import.meta.url)),
    // **The desktop's public folder, on purpose.** The share bundle has always carried the one
    // file in it — `mtg-grimoire-mark.svg` — as a side effect of where its root was: every
    // config rooted at the repository, and the `public/` there was every build's. Nothing in
    // the viewer or in the Worker's shell names the file. It is kept so that the deployed bundle
    // does not lose a URL in a change that is meant to move files and nothing else; dropping it
    // is a decision of its own.
    publicDir: fileURLToPath(new URL("../desktop/public/", import.meta.url)),
    plugins: [dropDevShell(), goldenSnapshot()],
    build: {
      outDir: "dist-share",
      emptyOutDir: true,
      rolldownOptions: {
        input: "index.html",
        output: {
          // ⚠️ **`assets/share.js` is pinned, not hashed, and this is the single easiest way to
          // ship a blank page.** `infrastructure/share-worker/src/page.ts` writes
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

    // Not 1420 (`tauri dev`, hardcoded in tracked files) and not 6006 (Storybook). All three have
    // to be able to run at once.
    server: { port: 5174, strictPort: true },
  }),
);
