// Node's own modules, in a file `tsc` never reads: a Vite config is type-stripped by Vite and
// checked by nothing (`tsconfig.node.json` has why that project lists one file), and `@types/node`
// is never installed. What this file decides that can be wrong lives in
// `src/lib/core/web/assets.ts`, where the suite covers it; what stays here is the filesystem.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig, type Plugin } from "vite";
import base from "./vite.config.ts";
import { FAKE_ALIASES } from "./.storybook/fake/aliases.ts";
import { headersFor, parseHeaders } from "./app-worker/src/headers.ts";
import {
  buildIdOf,
  GLUE_FILE,
  isNavigation,
  WASM_FILE,
  wasmContentType,
  wasmFileOf,
  wasmPath,
} from "./src/lib/core/web/assets.ts";
import { serviceWorker } from "./vite.sw.ts";

/** The light app's document, from the repository root. */
const ENTRY = "mobile/index.html";

/** What is served at the light app's root as it stands — resolved against this file. */
const PUBLIC_DIR = fileURLToPath(new URL("./mobile/public/", import.meta.url));

/** A request as Connect hands it over — Node's `IncomingMessage`, whose type is not installed. */
interface Asked {
  url?: string;
  method?: string;
  headers: { accept?: string };
}

/** As much of Node's `ServerResponse` as an answer written by hand needs. */
interface Answer {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string | Uint8Array): void;
}

/** A request's path, without its query. */
const pathOf = (request: Asked): string => (request.url ?? "/").split("?")[0];

/**
 * Serves the light entry to every page navigation, and puts it at the root of the build.
 *
 * **The root stays the repository root**, for `vite.share.config.ts`'s reason: the base config's
 * `"@": "/src"` alias is root-relative, so `root: "mobile"` would quietly resolve every `@/…`
 * against `mobile/`. With the root where it is, `/` would serve the *desktop's* `index.html` —
 * so a navigation is rewritten to the light document instead, which is also the history
 * fallback the light app's path-based URLs need (`/decks/12` must load the app, not 404).
 * `isNavigation` is what a navigation is, and it is under `src/` so the suite holds it.
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
        // installed here — so the type arrives with none of the fields read below. A cast on the
        // one read, for `vite.config.ts`'s reason about `process`.
        const req = request as unknown as Asked;
        if (isNavigation(req.method, req.headers.accept, pathOf(req))) req.url = `/${ENTRY}`;
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

/**
 * Where `npm run web:wasm` (`scripts/build-wasm.mjs`) writes the engine: wasm-bindgen's glue and
 * the module, and whatever the glue imports beside itself. Ignored, and read by the web mode
 * alone. Resolved against this file rather than the working directory.
 */
const ENGINE_DIR = fileURLToPath(new URL("./dist-wasm/", import.meta.url));

/** What a build, a dev server and a reader of the page are each told when it is not there. */
const ENGINE_MISSING =
  `The card engine has not been built: dist-wasm/ has no ${GLUE_FILE} and ${WASM_FILE}. ` +
  "Run `npm run web:wasm` first.";

/** Every file of the engine on disk, by its path under `dist-wasm/` — none, when it is not built. */
function engineFiles(): { name: string; bytes: Uint8Array }[] {
  if (!existsSync(ENGINE_DIR)) return [];
  return (
    (readdirSync(ENGINE_DIR, { recursive: true }) as string[])
      .map((name) => name.replaceAll("\\", "/"))
      // wasm-bindgen writes declarations beside the glue; nothing loads them.
      .filter((name) => !name.endsWith(".d.ts") && statSync(ENGINE_DIR + name).isFile())
      .map((name) => ({ name, bytes: readFileSync(ENGINE_DIR + name) }))
  );
}

const engineBuilt = (files: { name: string }[]): boolean =>
  [GLUE_FILE, WASM_FILE].every((wanted) => files.some(({ name }) => name === wanted));

/**
 * **The web app's engine, served and shipped** — the `web` mode's one plugin.
 *
 * The Worker loads the glue from `/wasm/<build>/grimoire_web.js` and the module from beside it
 * (`src/lib/core/web/worker.ts`); `assets.ts` has why the build id is a directory. Neither file is
 * in the module graph — they are a build of their own, and the page names them by URL — so they
 * are put there by hand:
 *
 * - **In dev**, a middleware answers `/wasm/<anything>/…` from `dist-wasm/` as it is on disk at
 *   that moment, uncached, so `npm run web:wasm` beside a running server is picked up by a reload.
 *   A file that is not there is a 404 that says what to run — which the Worker's failed load
 *   carries to the boot screen.
 * - **In a build**, every file is emitted under `wasm/<build>/`, and an engine that was never
 *   built **fails the build** with the same sentence rather than shipping a page that cannot open.
 * - **In the preview**, a page navigation answers the built document, by `isNavigation` — the
 *   rule the dev server serves by. (See `appType` below for what else the preview is told.)
 */
function webEngine(
  build: string,
  files: { name: string; bytes: Uint8Array }[],
  building: boolean,
): Plugin {
  return {
    name: "web:engine",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const file = wasmFileOf(pathOf(request as unknown as Asked));
        if (file === null) return next();
        const res = response as unknown as Answer;
        const onDisk = ENGINE_DIR + file;
        if (!existsSync(onDisk) || !statSync(onDisk).isFile()) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end(ENGINE_MISSING);
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", wasmContentType(file));
        // The address does not move in dev, so nothing may keep what it answered.
        res.setHeader("Cache-Control", "no-store");
        res.end(readFileSync(onDisk));
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, _res, next) => {
        const req = request as unknown as Asked;
        if (isNavigation(req.method, req.headers.accept, pathOf(req))) req.url = "/index.html";
        next();
      });
    },
    buildStart() {
      // A dev server starts without it — the boot screen then says what is missing.
      if (building && !engineBuilt(files)) this.error(ENGINE_MISSING);
    },
    generateBundle() {
      for (const { name, bytes } of files) {
        // An asset under a name of its own: the glue is written out as wasm-bindgen wrote it,
        // unbundled and unhashed, because the id in its path is what versions it.
        this.emitFile({ type: "asset", fileName: wasmPath(build, name).slice(1), source: bytes });
      }
    },
  };
}

/**
 * The hosting's response headers — Cloudflare's `_headers` file, kept in `app-worker/` beside the
 * `wrangler.jsonc` that deploys the build, and what it is copied to.
 */
const HEADERS_SOURCE = fileURLToPath(new URL("./app-worker/_headers", import.meta.url));
const WEB_BUILD = fileURLToPath(new URL("./dist-web", import.meta.url));

/**
 * **The web build's hosting file, shipped and enforced** — the `web` mode's second plugin.
 *
 * - **In a build**, `app-worker/_headers` is emitted at the root of `dist-web/`, where
 *   `wrangler deploy` reads it. Emitted here and **kept in neither public directory**: the root's
 *   is copied into the desktop's `dist/` and the share viewer's `dist-share/`, and
 *   `mobile/public/` into the APK's `dist-mobile/` as well as this build — none of which may
 *   carry a policy that is not theirs. A file that does not parse fails the build, by line,
 *   rather than deploying as fewer rules than it looks.
 * - **In the preview**, every response carries what the built file says that address is sent —
 *   `app-worker/src/headers.ts` reads the format as Cloudflare does — so the
 *   Content-Security-Policy meets the app on `localhost` and not first on the day of a deploy.
 *   The *built* copy, because a preview serves the build. **A file that is not there gets none
 *   of them**, as on the host: there the 404 is the Worker's own answer, which `_headers` does
 *   not reach — and a year's `immutable` on a 404 is a chunk no rebuild could bring back.
 *   **`/_headers` itself is a 404**, as on the host, which parses the file and does not serve it.
 *
 * **Not in dev.** Vite's dev server injects `<style>` elements and an inline preamble and talks
 * to the page over a WebSocket, each of which the shipped policy forbids on purpose.
 *
 * Listed **before** `web:engine`: that plugin rewrites a navigation to `/index.html`, and a
 * rule is matched against the address the reader asked for.
 */
function webHosting(): Plugin {
  return {
    name: "web:hosting",
    configurePreviewServer(server) {
      if (!existsSync(`${WEB_BUILD}/_headers`)) {
        throw new Error("dist-web/_headers is missing. Run `npm run web:build` first.");
      }
      const rules = parseHeaders(readFileSync(`${WEB_BUILD}/_headers`, "utf8"));
      server.middlewares.use((request, response, next) => {
        const req = request as unknown as Asked;
        const path = pathOf(req);
        const res = response as unknown as Answer;
        // The host parses this file and does not serve it. Served here, a service worker whose
        // precache list named it would install in the preview and fail on the day of a deploy.
        if (path === "/_headers") {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end("Not found");
          return;
        }
        const answered =
          isNavigation(req.method, req.headers.accept, path) || existsSync(WEB_BUILD + path);
        if (answered) {
          for (const [name, value] of Object.entries(headersFor(rules, path))) {
            res.setHeader(name, value);
          }
        }
        next();
      });
    },
    generateBundle() {
      const source = readFileSync(HEADERS_SOURCE, "utf8");
      parseHeaders(source);
      this.emitFile({ type: "asset", fileName: "_headers", source });
    },
  };
}

export default defineConfig(({ mode, command, isPreview }) => {
  /**
   * **`web` is the web app's build**: the light entry over the engine in a Worker, into
   * `dist-web/` (`npm run web:build`, `web:dev`, `web:preview`). Every other mode is the light app
   * as it was — `dist-mobile/`, which the Android host embeds, and `fake` for the Storybook fake.
   * The page's code is the same; what differs is below `@/lib/core`, which reads this mode
   * (`src/lib/core/index.ts`).
   */
  const web = mode === "web";
  const building = command === "build";
  const engine = web && building ? engineFiles() : [];
  // A build's id is its engine's bytes; a dev server has one engine and serves it uncached.
  const engineBuild = building ? buildIdOf(engine) : "dev";

  return mergeConfig(base, {
    // **`webHosting()` stays first among the `web` plugins.** A preview middleware answers in the
    // order its plugin is listed, and this one only *sets headers and passes on*: listed after a
    // plugin that answers — `web:engine`'s rewrite of a navigation, or the service worker's
    // middleware for `/sw.js` (`vite.sw.ts`), which ends the response itself — that answer would
    // leave without the policy, and the one local server that enforces it would have a hole
    // exactly where a worker's script is served. Listed first, its headers are already on the
    // response when the service worker's middleware writes its own `Cache-Control: no-cache` over
    // the same value and ends it.
    //
    // **`serviceWorker()` stays last.** It is written into `dist-web/` after everything else and
    // into no other build, and its build id hashes every file the other plugins put there — the
    // emitted `_headers` included, which its precache list leaves out.
    plugins: [
      lightEntry(),
      ...(web
        ? [webHosting(), webEngine(engineBuild, engine, building), serviceWorker("dist-web")]
        : []),
    ],
    // **The light builds' own public directory**: the web manifest, its icons and the favicon.
    // Vite copies a public directory into every build that names it, and the one at the root is
    // every build's — there the manifest went out in the desktop's `dist/` and the share
    // viewer's `dist-share/`, which have no use for it. Here it reaches `dist-mobile/`, `dist-web/`
    // and the two dev servers, and nothing else. The favicon is a second copy of the mark for
    // that reason; `mobile/host.test.ts` holds it equal to the master.
    publicDir: PUBLIC_DIR,
    // The Storybook fake, under the real `ipc.ts` — **the four aliases `.storybook/main.ts`
    // declares, read from the one list both use**, for its reason: the fake sits *under* the
    // hand-written mirror, so the light app in a plain browser exercises the mirror too.
    // `mergeConfig` puts these ahead of the base config's `@` alias, and `@/lib/images` has to be
    // tried before that prefix.
    resolve: mode === "fake" ? { alias: FAKE_ALIASES } : {},
    optimizeDeps: mode === "fake" ? { exclude: FAKE_UNBUNDLED } : {},
    // How the Worker is told where its engine is. `define` reaches the Worker's bundle as it
    // reaches the page's, and an `import.meta.env` key is replaced by the dev server too.
    define: web ? { "import.meta.env.VITE_ENGINE_BUILD": JSON.stringify(engineBuild) } : {},
    // **The preview answers a missing file with a 404, as a real host does.** Vite's own
    // single-page fallback hands the document to anything that accepts `*/*` — a script, a
    // Worker's `import()` — so a file a deploy removed would arrive as HTML with a 200, and the
    // failure the app is built to report would be a MIME error instead. `mpa` turns that off, and
    // `web:engine` puts back the one fallback wanted: a page navigation.
    ...(web && isPreview ? { appType: "mpa" } : {}),
    build: {
      outDir: web ? "dist-web" : "dist-mobile",
      emptyOutDir: true,
      rolldownOptions: { input: ENTRY },
    },
    // Not 1420 (`tauri dev`), not 5174 (the share viewer), not 6006 (Storybook) — and the web app
    // is not on the light server's 5175, so the two can be up at once.
    //
    // **No `watch` of its own.** The base config's `server.watch.ignored` is `vite.watch.ts`'s list,
    // which keeps the watcher out of every build output under the root — the `EBUSY` this server
    // died of on 2026-10-01 (`docs/reference/light-app.md` §4) — and `mergeConfig` carries it
    // here. This config restated those five globs until the base config grew the list for every
    // server; a second copy appended over the first changed nothing but what could drift.
    server: { port: web ? 5176 : 5175, strictPort: true },
    preview: { port: 4176, strictPort: true },
  });
});
