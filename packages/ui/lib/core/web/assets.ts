/**
 * **Where the engine's files live, and what a build calls them** — read by the Worker, which loads
 * them, and by `apps/light/vite.config.ts`, which serves them in dev and copies them into a build.
 * Here rather than in that config because a Vite config is type-checked and tested by nothing
 * (`vite.base.ts` keeps `iconFont.ts` under `packages/ui/` for the same reason).
 *
 * `scripts/build-wasm.mjs` writes the files to `dist-wasm/` at the repository root, which is
 * ignored: no build but the web app's ever needs them.
 */

/** The file wasm-bindgen's `--target web` glue is written to, and the module beside it. */
export const GLUE_FILE = "grimoire_web.js";
export const WASM_FILE = "grimoire_web_bg.wasm";

/**
 * Where a build's engine is served from: **`/wasm/<build>/`**, the build id a directory.
 *
 * The two files have fixed names, so a URL without the id would be one address for every build
 * there will ever be — and anything that keeps a response by its URL (the HTTP cache, and from
 * step 5.3 the service worker) would pair this build's glue with the last build's module, which
 * fails at runtime rather than at load. **A directory and not a query**, because the glue finds
 * whatever it imports beside itself by its own URL, and a query does not survive that.
 */
export function wasmPath(build: string, file: string): string {
  return `/wasm/${build}/${file}`;
}

/** The glue and the module, as absolute URLs on `origin`. */
export function wasmUrls(origin: string, build: string): { glue: string; wasm: string } {
  return {
    glue: new URL(wasmPath(build, GLUE_FILE), origin).href,
    wasm: new URL(wasmPath(build, WASM_FILE), origin).href,
  };
}

/**
 * **The scanner's own module**, which `scripts/build-wasm.mjs` writes into a folder of
 * `dist-wasm/` beside the engine's two files: wasm-bindgen's glue and the module, built with
 * `simd128` and loaded by a Worker of its own (`scanWorker.ts`).
 *
 * **Served under `/wasm/<build>/scanner/`, and the build there is the scanner's own** — a hash of
 * these two files and not of the engine's, so a change to either module moves that module's
 * address and leaves the other's where it was. Under `/wasm/` because everything said of that
 * tree is true of these: content-addressed, kept for a year, never a page.
 */
export const SCANNER_DIR = "scanner";
export const SCANNER_GLUE_FILE = `${SCANNER_DIR}/grimoire_scan.js`;
export const SCANNER_WASM_FILE = `${SCANNER_DIR}/grimoire_scan_bg.wasm`;

/** The scanner's glue and module, as absolute URLs on `origin`. `build` is the scanner's own id. */
export function scannerUrls(origin: string, build: string): { glue: string; wasm: string } {
  return {
    glue: new URL(wasmPath(build, SCANNER_GLUE_FILE), origin).href,
    wasm: new URL(wasmPath(build, SCANNER_WASM_FILE), origin).href,
  };
}

/** Whether a request's path names a file of the scanner's module, whatever build's. */
export function isScannerModule(path: string): boolean {
  return new RegExp(`^/wasm/[^/]+/${SCANNER_DIR}/`).test(path);
}

/**
 * **Where the scanner's three files are served from: `/scanner-assets/`**, under the names the
 * release publishes them by, with {@link SCANNER_MANIFEST} beside them saying what each one is.
 *
 * **Stable names, unlike the two trees a build hashes**: the bundle of card hashes is rebuilt
 * with every set and shipped again at each release under the name it always had, so these
 * addresses are revalidated and never kept by the HTTP cache (`infrastructure/app-worker/_headers`) — and the
 * page keeps what it fetched in Cache Storage itself, by what the manifest said of it
 * (`scanStore.ts`). Not `/scanner/`: that is the Scanner page's own place.
 */
export const SCANNER_ASSETS_PREFIX = "/scanner-assets/";
/** The build's word on the three files: their names, lengths, digests and the bundle's format. */
export const SCANNER_MANIFEST = "manifest.json";

/**
 * **The scanner's cache: what it fetched, kept for good.** One cache, two writers, and neither
 * is a build's: the page puts the three files here once it has checked them (`scanStore.ts`),
 * and the service worker keeps the scanner's module here the first time a Worker loads it
 * (`sw/serve.ts`) — so a reader who has scanned once can scan offline.
 *
 * **Not a shell and not the pictures.** A shell cache is deleted when its build is replaced,
 * and this must outlive a deploy; and Settings' *Clear cache* empties the picture cache alone,
 * as the desktop's sweeps its picture folder and leaves `data/scanner/` where it is. The `v1`
 * is for a day the *stored shape* changes — the headers an entry is kept under — and nothing
 * else moves it: a new bundle is a new digest under the same name.
 */
export const SCANNER_CACHE = "grimoire-scanner-v1";

/**
 * Whether one of a build's files — its path from the output folder — is **the scanner's, and so
 * fetched on first use and never precached**: its module and its three files. Neither is asked
 * for until a reader opens the Scanner and presses Download, and a service worker that put them
 * in its shell would spend 23 MB of every first visit on a view most readers never open.
 */
export function isScannerFile(file: string): boolean {
  return isScannerModule(`/${file}`) || `/${file}`.startsWith(SCANNER_ASSETS_PREFIX);
}

/**
 * The file a request for `path` asks for, relative to the engine's folder — `null` for a path
 * that is not under `/wasm/<build>/`, or that climbs out of it. What the dev server and the
 * preview read `dist-wasm/` by; the build id is not checked there, because a dev server has one
 * engine on disk whatever the page was told.
 *
 * **Every segment is letters, digits, `.`, `_` and `-`, and nothing else is a file of the
 * engine's.** An allow-list rather than a hunt for `..`: on Windows a backslash is a separator
 * too, so `..\package.json` is one segment here and a climb on disk — a browser rewrites it
 * before it asks, and a script does not.
 */
export function wasmFileOf(path: string): string | null {
  const match = /^\/wasm\/[^/]+\/(.+)$/.exec(path);
  if (!match) return null;
  const file = match[1];
  const plain = (part: string): boolean => /^[\w.-]+$/.test(part) && !/^\.+$/.test(part);
  return file.split("/").every(plain) ? file : null;
}

/**
 * An id for the engine on disk: its files' names and bytes, hashed. **The same engine keeps its
 * address across builds of the page**, so a deploy that changed only the page does not make a
 * reader download the module again; a changed byte moves it.
 *
 * FNV-1a, twice over with two seeds — sixteen hex digits. Not a cryptographic hash and not asked
 * to be one: nothing trusts this id, it only has to differ when the files do.
 */
export function buildIdOf(files: readonly { name: string; bytes: Uint8Array }[]): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  const mix = (byte: number): void => {
    a = Math.imul(a ^ byte, 0x01000193);
    b = Math.imul(b ^ byte, 0x85ebca6b);
  };
  for (const { name, bytes } of [...files].sort((x, y) => (x.name < y.name ? -1 : 1))) {
    for (let at = 0; at < name.length; at++) mix(name.charCodeAt(at) & 0xff);
    // The length between the name and the bytes, so a byte moved from the end of one file to
    // the start of the next is a different engine.
    for (let shift = 0; shift < 32; shift += 8) mix((bytes.length >>> shift) & 0xff);
    for (let at = 0; at < bytes.length; at++) mix(bytes[at]);
  }
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, "0");
  return hex(a) + hex(b);
}

/** What a server says a file of the engine is. `WebAssembly.instantiateStreaming` checks it. */
export function wasmContentType(file: string): string {
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".js")) return "text/javascript";
  return "application/octet-stream";
}

/**
 * **Where nothing is a page**, whatever the caller accepts: the two trees a build writes its
 * files into, the tree the service worker answers card pictures under (`packages/ui/lib/images.ts`'s
 * `WEB_IMAGE_PREFIX`; `assets.test.ts` holds this spelling to that constant), the folder the
 * scanner's three files are fetched from, and `/_headers`, which a host parses and does not serve.
 *
 * A path under any of them names a file or nothing. Answered with the document, a chunk a
 * deploy renamed would be a 200 of HTML where a script was asked for, and a picture a page asks
 * for before its service worker controls it would be a 200 a cache has no reason to refuse.
 *
 * **Here, and read by {@link isNavigation}, so the dev server, the preview, the smoke run's
 * server and the hosting Worker's script answer by one rule.** It was the Worker's own list
 * until the three local servers were found handing the document to `/mtgimg/x`.
 */
export const NOT_A_PLACE: readonly string[] = [
  "/assets/",
  "/wasm/",
  "/mtgimg/",
  SCANNER_ASSETS_PREFIX,
  "/_headers",
];

/**
 * Whether a request is a page navigation the app's document answers — the history fallback its
 * path-based URLs need (`/decks/12` must load the app, not 404).
 *
 * A file has an extension and a Vite internal starts `/@`; neither is a page, and nothing under
 * {@link NOT_A_PLACE} is. The extension is asked of the **last segment**: a dot further up the
 * path is part of a route, and reading it as a file would hand that route the wrong document.
 */
export function isNavigation(
  method: string | undefined,
  accept: string | undefined,
  path: string,
): boolean {
  return (
    method === "GET" &&
    String(accept ?? "").includes("text/html") &&
    !path.slice(path.lastIndexOf("/") + 1).includes(".") &&
    !path.startsWith("/@") &&
    !NOT_A_PLACE.some((tree) => path.startsWith(tree))
  );
}
