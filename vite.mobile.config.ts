import { defineConfig, mergeConfig, type Plugin } from "vite";
import base from "./vite.config.ts";
import { FAKE_ALIASES } from "./.storybook/fake/aliases.ts";

/** The light app's document, from the repository root. */
const ENTRY = "mobile/index.html";

/**
 * Serves the light entry to every page navigation, and puts it at the root of the build.
 *
 * **The root stays the repository root**, for `vite.share.config.ts`'s reason: the base config's
 * `"@": "/src"` alias is root-relative, so `root: "mobile"` would quietly resolve every `@/…`
 * against `mobile/`. With the root where it is, `/` would serve the *desktop's* `index.html` —
 * so a navigation is rewritten to the light document instead, which is also the history
 * fallback the light app's path-based URLs need (`/decks/12` must load the app, not 404).
 */
function lightEntry(): Plugin {
  return {
    name: "light:entry",
    // `post`, because Vite's own `vite:build-html` emits the document in *its* `generateBundle`
    // and an unenforced plugin here would rename a file that has not been emitted yet.
    enforce: "post",
    configureServer(server) {
      server.middlewares.use((request, _res, next) => {
        // Connect's request extends Node's `IncomingMessage`, and `@types/node` is never
        // installed here — so the type arrives with none of the three fields read below. A cast
        // on the one read, for `vite.config.ts`'s reason about `process`.
        const req = request as unknown as {
          url?: string;
          method?: string;
          headers: { accept?: string };
        };
        const path = (req.url ?? "/").split("?")[0];
        const navigation =
          req.method === "GET" &&
          String(req.headers.accept ?? "").includes("text/html") &&
          // A file has an extension and a Vite internal starts `/@`; neither is a page. The
          // extension is asked of the **last segment**: a dot further up the path is part of a
          // route, and reading it as a file would hand that route the desktop's document.
          !path.slice(path.lastIndexOf("/") + 1).includes(".") &&
          !path.startsWith("/@");
        if (navigation) req.url = `/${ENTRY}`;
        next();
      });
    },
    generateBundle(_options, bundle) {
      // **Renamed in place, and only that.** Rolldown hands a plugin a proxy of the bundle: a
      // write to an item's `fileName` is carried back, while a new key assigned onto the bundle
      // is warned about and ignored — so the Rollup idiom of deleting the old key and assigning
      // the new one deletes the document and emits nothing, exiting 0.
      //
      // **A missing document is an error, not a skip.** Neither `verify` nor CI runs this build,
      // and a guard that quietly did nothing would leave the page at `dist-mobile/mobile/` and
      // exit 0 — the same silent outcome, reached from the other side.
      const html = bundle[ENTRY];
      if (!html) {
        return this.error(`light:entry: ${ENTRY} was not emitted, so there is nothing to serve`);
      }
      html.fileName = "index.html";
    },
  };
}

/**
 * The two Tauri plugins the app imports, kept **out of the dependency optimizer** in fake mode.
 *
 * Each of them imports `@tauri-apps/api/core` from inside `node_modules`, and the optimizer
 * applies the fake's alias while it pre-bundles them. Spelled root-relative, that replacement is
 * not a path the optimizer can load — it reads `/.storybook/…` off the drive's root — and the
 * dev server **exits** during "bundling dependencies", a few seconds after it printed its URL
 * (driven 2026-10-01: a blank page and `ERR_CONNECTION_REFUSED` on every dependency). Spelled
 * absolute it loads, and the plugin's bundle then carries **its own copy of the fake**, with its
 * own scope pointer and no world installed in it, so a Copy or an Open-on would be answered by
 * nobody. Served unbundled, the plugin's import takes the same alias the app's does and there is
 * one fake. Both packages are plain ESM, which is all leaving the optimizer asks of them.
 */
const FAKE_UNBUNDLED = ["@tauri-apps/plugin-clipboard-manager", "@tauri-apps/plugin-opener"];

export default defineConfig(({ mode }) =>
  mergeConfig(base, {
    plugins: [lightEntry()],
    // The Storybook fake, under the real `ipc.ts` — **the four aliases `.storybook/main.ts`
    // declares, read from the one list both use**, for its reason: the fake sits *under* the
    // hand-written mirror, so the light app in a plain browser exercises the mirror too.
    // `mergeConfig` puts these ahead of the base config's `@` alias, and `@/lib/images` has to be
    // tried before that prefix.
    resolve: mode === "fake" ? { alias: FAKE_ALIASES } : {},
    optimizeDeps: mode === "fake" ? { exclude: FAKE_UNBUNDLED } : {},
    build: {
      outDir: "dist-mobile",
      emptyOutDir: true,
      rolldownOptions: { input: ENTRY },
    },
    // Not 1420 (`tauri dev`), not 5174 (the share viewer), not 6006 (Storybook).
    //
    // **No `watch` of its own.** The base config's `server.watch.ignored` is `vite.watch.ts`'s list,
    // which keeps the watcher out of every build output under the root — the `EBUSY` this server
    // died of on 2026-10-01 (`docs/reference/light-app.md` §4) — and `mergeConfig` carries it
    // here. This config restated those five globs until the base config grew the list for every
    // server; a second copy appended over the first changed nothing but what could drift.
    server: { port: 5175, strictPort: true },
  }),
);
