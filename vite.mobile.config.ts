// Node's own modules, in a file `tsc` never reads: a Vite config is type-stripped by Vite and
// checked by nothing (`tsconfig.node.json` has why that project lists one file), and `@types/node`
// is never installed. What this file decides that can be wrong lives in
// `src/lib/core/web/assets.ts`, where the suite covers it; what stays here is the filesystem.
import { createHash } from "node:crypto";
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
  NOT_A_PLACE,
  SCANNER_ASSETS_PREFIX,
  SCANNER_DIR,
  SCANNER_GLUE_FILE,
  SCANNER_MANIFEST,
  SCANNER_WASM_FILE,
  WASM_FILE,
  wasmContentType,
  wasmFileOf,
  wasmPath,
} from "./src/lib/core/web/assets.ts";
import { readManifest } from "./src/lib/core/web/scanStore.ts";
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
      server.middlewares.use((request, response, next) => {
        // Connect's request extends Node's `IncomingMessage`, and `@types/node` is never
        // installed here — so the type arrives with none of the fields read below. A cast on the
        // one read, for `vite.config.ts`'s reason about `process`.
        const req = request as unknown as Asked;
        const path = pathOf(req);
        if (isNavigation(req.method, req.headers.accept, path)) {
          req.url = `/${ENTRY}`;
          return next();
        }
        // **A page asked for where nothing is a page is a 404 here too** (`NOT_A_PLACE`). Left to
        // Vite, its own single-page fallback would answer `/mtgimg/x` or `/assets/chunk` with
        // `/index.html` — which at this root is the *desktop's* document. Only what that
        // fallback would have taken: a path with a file on the end is Vite's to serve or refuse.
        const fallsBack =
          req.method === "GET" &&
          String(req.headers.accept ?? "").includes("text/html") &&
          !path.slice(path.lastIndexOf("/") + 1).includes(".");
        if (fallsBack && NOT_A_PLACE.some((tree) => path.startsWith(tree))) {
          const res = response as unknown as Answer;
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader("Cache-Control", "no-store");
          return res.end("Not found");
        }
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

/** One file under `dist-wasm/`, by its path from it. */
interface Built {
  name: string;
  bytes: Uint8Array;
}

/**
 * The folder of `dist-wasm/` the scanner's three files and their manifest are fetched into —
 * `scripts/scanner-assets.mjs --web`. Beside the two modules because everything said of that
 * folder is true of these: ignored, written by a script of its own, and no build's but this one.
 */
const SCANNER_ASSETS_DIR = SCANNER_ASSETS_PREFIX.slice(1);

/**
 * What `dist-wasm/` holds, **as the three things it is**: the engine's two files at its root,
 * the scanner's two in a folder of their own, and the scanner's three files with their manifest
 * in another. Kept apart from the first read, because each has an address of its own: a hash of
 * the engine's bytes, a hash of the scanner module's, and — for the files — none.
 */
function builtFiles(): { engine: Built[]; scanner: Built[]; assets: Built[] } {
  const all: Built[] = !existsSync(ENGINE_DIR)
    ? []
    : (readdirSync(ENGINE_DIR, { recursive: true }) as string[])
        .map((name) => name.replaceAll("\\", "/"))
        // wasm-bindgen writes declarations beside the glue; nothing loads them. A download
        // still on its way is a `.part` (`scripts/scanner-assets.mjs`).
        .filter(
          (name) =>
            !name.endsWith(".d.ts") &&
            !name.endsWith(".part") &&
            statSync(ENGINE_DIR + name).isFile(),
        )
        .map((name) => ({ name, bytes: readFileSync(ENGINE_DIR + name) }));
  const under = (dir: string) => (file: Built) => file.name.startsWith(`${dir}/`);
  return {
    engine: all.filter((file) => !file.name.includes("/")),
    scanner: all.filter(under(SCANNER_DIR)),
    assets: all.filter((file) => file.name.startsWith(SCANNER_ASSETS_DIR)),
  };
}

const engineBuilt = (files: { name: string }[]): boolean =>
  [GLUE_FILE, WASM_FILE].every((wanted) => files.some(({ name }) => name === wanted));

const scannerBuilt = (files: { name: string }[]): boolean =>
  [SCANNER_GLUE_FILE, SCANNER_WASM_FILE].every((wanted) =>
    files.some(({ name }) => name === wanted),
  );

/** What a build is told when the engine is there and the scanner's module is not. */
const SCANNER_MISSING =
  `The card scanner's module has not been built: dist-wasm/ has no ${SCANNER_GLUE_FILE} and ` +
  `${SCANNER_WASM_FILE}. Run \`npm run web:wasm\` first.`;

/** `card_scanner::index::FORMAT_VERSION`, read from the crate as `scripts/scanner-assets.mjs` reads it. */
function scannerFormat(): number {
  const source = readFileSync(
    fileURLToPath(new URL("./crates/card-scanner/src/index.rs", import.meta.url)),
    "utf8",
  );
  const declared = /pub const FORMAT_VERSION: u16 = (\d+);/.exec(source);
  if (!declared) throw new Error("crates/card-scanner/src/index.rs declares no FORMAT_VERSION.");
  return Number(declared[1]);
}

/**
 * The scanner's three files as this build ships them, or the reason it ships none.
 *
 * **Held to their own manifest before a byte is emitted**: the three names and no other, each
 * the manifest's length and digest, and the bundle's format the one this tree's scanner reads.
 * A folder that fails any of it is a folder some other checkout or some earlier week wrote, and
 * shipping it would be a download every reader's browser then refuses.
 */
function scannerAssets(files: Built[], format: number): { ship: Built[] } | { why: string } {
  const fetchIt = "Run `npm run scanner:assets -- --web`.";
  const named = (name: string): Built | undefined =>
    files.find((file) => file.name === `${SCANNER_ASSETS_DIR}${name}`);
  const manifestFile = named(SCANNER_MANIFEST);
  if (!manifestFile) return { why: `dist-wasm/${SCANNER_ASSETS_DIR} has no manifest. ${fetchIt}` };
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(new TextDecoder().decode(manifestFile.bytes));
  } catch {
    // Read as no manifest, below.
  }
  const manifest = readManifest(parsed);
  if (manifest === null) return { why: `the scanner files' manifest is unreadable. ${fetchIt}` };
  if (manifest.formatVersion !== format) {
    return {
      why:
        `the scanner files are format ${manifest.formatVersion} and this tree's scanner reads ` +
        `${format}. ${fetchIt}`,
    };
  }
  const ship: Built[] = [manifestFile];
  for (const entry of manifest.files) {
    const file = named(entry.name);
    const digest = file && createHash("sha256").update(file.bytes).digest("hex");
    if (!file || file.bytes.length !== entry.bytes || digest !== entry.sha256) {
      return { why: `${entry.name} is not the file its manifest describes. ${fetchIt}` };
    }
    ship.push(file);
  }
  return { ship };
}

/**
 * **The web app's engine, served and shipped** — one of the `web` mode's three plugins, with
 * `webHosting` below and `vite.sw.ts`'s service worker.
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
 *
 * **The card scanner's module rides here too** (step 7.5): its two files are in a folder of
 * `dist-wasm/` and are served from the same folder of `/wasm/<build>/`, with the build there
 * the *scanner's own* hash — so the dev middleware below, which reads any path under
 * `/wasm/<anything>/`, already answers them, and a build emits them beside the engine's under
 * an id that moves only when the scanner's bytes do. A build with an engine and no scanner
 * fails as a build with no engine does. Neither is in the service worker's precache
 * (`sw/shell.ts`).
 */
function webEngine(
  build: string,
  files: Built[],
  building: boolean,
  scanner: { build: string; files: Built[] },
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
      if (building && !scannerBuilt(scanner.files)) this.error(SCANNER_MISSING);
    },
    generateBundle() {
      for (const { name, bytes } of files) {
        // An asset under a name of its own: the glue is written out as wasm-bindgen wrote it,
        // unbundled and unhashed, because the id in its path is what versions it.
        this.emitFile({ type: "asset", fileName: wasmPath(build, name).slice(1), source: bytes });
      }
      for (const { name, bytes } of scanner.files) {
        this.emitFile({
          type: "asset",
          fileName: wasmPath(scanner.build, name).slice(1),
          source: bytes,
        });
      }
    },
  };
}

/**
 * **The card scanner's three files, served and shipped** — the bundle of card hashes and the
 * two OCR models, with the manifest that says what each is (`scripts/scanner-assets.mjs --web`
 * fetches them into `dist-wasm/scanner-assets/`).
 *
 * A browser gets them from the app's own origin: the release they are published on sends no
 * CORS header, so a page cannot read it. They are fetched when a reader presses Download in the
 * Scanner and by nothing before (`src/lib/core/web/scanStore.ts`), so they are in no precache.
 *
 * - **In dev**, `/scanner-assets/<name>` is answered from the folder as it is at that moment,
 *   uncached; a file that is not there is a 404, which the page reads as a build made without
 *   them and says so.
 * - **In a build**, the folder is held to its own manifest ({@link scannerAssets}) and emitted
 *   under the same address — or, where it is absent or stale, **nothing is emitted and the
 *   build says why**: a developer's build still builds, and the page says the scanner's files
 *   are not part of it rather than offering a download that would 404. **A build that is
 *   going to be deployed, or smoke-tested as one, may not** — CI's `web` job and
 *   `release.yml`'s set `GRIMOIRE_SCANNER_ASSETS=required`, and there the same finding fails
 *   the build: a web app released without its scanner is a regression nobody would see until
 *   a reader pressed Download.
 */
function webScanner(files: Built[], format: number): Plugin {
  // Node's `process`, in a file nothing type-checks (this file's first comment).
  const required = process.env.GRIMOIRE_SCANNER_ASSETS === "required";
  return {
    name: "web:scanner",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = pathOf(request as unknown as Asked);
        if (!path.startsWith(SCANNER_ASSETS_PREFIX)) return next();
        const res = response as unknown as Answer;
        const name = path.slice(SCANNER_ASSETS_PREFIX.length);
        const onDisk = ENGINE_DIR + SCANNER_ASSETS_DIR + name;
        const plain = /^[\w.-]+$/.test(name) && !/^\.+$/.test(name);
        if (!plain || !existsSync(onDisk) || !statSync(onDisk).isFile()) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end("The scanner's files are not here. Run `npm run scanner:assets -- --web`.");
          return;
        }
        res.statusCode = 200;
        res.setHeader(
          "Content-Type",
          name.endsWith(".json") ? "application/json" : "application/octet-stream",
        );
        res.setHeader("Cache-Control", "no-store");
        res.end(readFileSync(onDisk));
      });
    },
    generateBundle() {
      const found = scannerAssets(files, format);
      if ("why" in found) {
        const said = `The card scanner's files are not in this build: ${found.why}`;
        if (required) this.error(said);
        this.warn(said);
        return;
      }
      for (const { name, bytes } of found.ship) {
        this.emitFile({ type: "asset", fileName: name, source: bytes });
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
 * **The web build's hosting file, shipped and enforced** — the `web` mode's first-listed plugin.
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
 *   not reach — and a year's `immutable` on a 404 is a chunk no rebuild could bring back. **It
 *   gets the host's 404 instead** — `text/plain`, `nosniff`, `no-store` — written here, for
 *   every path that is neither a file of the build's nor a place in the app.
 *   **`/_headers` itself is one**, as on the host, which parses the file and does not serve it.
 *
 * **Not in dev.** Vite's dev server injects `<style>` elements and an inline preamble and talks
 * to the page over a WebSocket, each of which the shipped policy forbids on purpose.
 *
 * Listed **before** `web:engine`: that plugin rewrites a navigation to `/index.html`, and a
 * rule is matched against the address the reader asked for. And before `web:service-worker`,
 * whose middleware ends the response for `/sw.js` itself: a service worker's `fetch` is held to
 * the policy on that script's response, so it has to be on it by then.
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
        const onDisk = WEB_BUILD + path;
        // A file of the build's — and never `_headers`, which the host parses and does not
        // serve: served here, a service worker whose precache list named it would install in
        // the preview and fail on the day of a deploy. A path that climbs is nobody's file.
        // **`/` is the document's own address**, a file to every caller: the service worker's
        // precache asks for it with `Accept: */*`, which is no navigation.
        const file =
          path === "/" ||
          (path !== "/_headers" &&
            !path.includes("..") &&
            existsSync(onDisk) &&
            statSync(onDisk).isFile());
        if (!file && !isNavigation(req.method, req.headers.accept, path)) {
          // **The host's own 404, word for word** (`app-worker/src/index.ts`'s `REFUSAL`): plain
          // text nothing may sniff into something else, and nothing may keep — the same address
          // is a real file the moment a build puts one there. Answered here rather than left to
          // Vite, whose bare 404 carries none of the three. `isNavigation` knows the trees where
          // nothing is a place, so `/mtgimg/x` asked for as a page ends here too, as on the host.
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader("Cache-Control", "no-store");
          res.end("Not found");
          return;
        }
        for (const [name, value] of Object.entries(headersFor(rules, path))) {
          res.setHeader(name, value);
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
  const built = web && building ? builtFiles() : { engine: [], scanner: [], assets: [] };
  const engine = built.engine;
  // A build's id is its engine's bytes; a dev server has one engine and serves it uncached.
  // The scanner's module has an id of its own, so neither module's change moves the other.
  const engineBuild = building ? buildIdOf(engine) : "dev";
  const scannerBuild = building ? buildIdOf(built.scanner) : "dev";
  const format = web ? scannerFormat() : 0;

  return mergeConfig(base, {
    // **`webHosting()` stays first among the `web` plugins.** A preview middleware answers in the
    // order its plugin is listed, and this one only *sets headers and passes on*: listed after a
    // plugin that answers — `web:engine`'s rewrite of a navigation, or the service worker's
    // middleware for `/sw.js` (`vite.sw.ts`), which ends the response itself — that answer would
    // leave without the policy, and a local server that enforces it would have a hole
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
        ? [
            webHosting(),
            webEngine(engineBuild, engine, building, { build: scannerBuild, files: built.scanner }),
            webScanner(built.assets, format),
            serviceWorker("dist-web"),
          ]
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
    // The scanner's Worker is told its module's id the same way, and the page the bundle
    // format that module reads — which a manifest for another format is refused by.
    define: web
      ? {
          "import.meta.env.VITE_ENGINE_BUILD": JSON.stringify(engineBuild),
          "import.meta.env.VITE_SCANNER_BUILD": JSON.stringify(scannerBuild),
          "import.meta.env.VITE_SCANNER_FORMAT": JSON.stringify(String(format)),
        }
      : {},
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
