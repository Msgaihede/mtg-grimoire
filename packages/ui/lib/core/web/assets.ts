/**
 * **Where the engine's files live, and what a build calls them** — read by the Worker, which loads
 * them, and by `apps/light/vite.config.ts`, which serves them in dev and copies them into a build.
 * Here rather than in that config because a Vite config is type-checked and tested by nothing
 * (`vite.base.ts` keeps `iconFont.ts` under `packages/ui/` for the same reason).
 *
 * `scripts/build-wasm.ts` writes the files to `dist-wasm/` at the repository root, which is
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
 * **The scanner's own module**, which `scripts/build-wasm.ts` writes into a folder of
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
 * **Where the Neural scanner's eight files are served: `/scanner-neural/<set>/`** —
 * `card-neural`'s detector, embedder, gallery and `neural.json`, and the four of its printing
 * evidence, which are in git (`crates/card-neural/models/`), copied in by the web build and
 * fetched by the page the first time a Neural frame is due (`scanner.ts`) — never before, and
 * never for a Fast or Exact frame.
 *
 * **Content-addressed, as the two modules are**: `<set>` is {@link buildIdOf} the eight files, so
 * a new set — the gallery is rebuilt when cards come out — is a new address, and nothing kept
 * under an old one is ever stale. So the HTTP cache keeps them a year
 * (`infrastructure/app-worker/_headers`), and the service worker keeps them in
 * {@link SCANNER_CACHE} the first time they are fetched, letting the last set go (`sw/shell.ts`'s
 * `kept`, the module's route) — a reader who has scanned in Neural once does so offline. In no
 * precache ({@link isScannerFile}): 48.7 megabytes most readers never ask for.
 *
 * A tree of its own, not `/scanner-assets/`: those are stable names that are revalidated and
 * kept by the page, and these are neither.
 */
export const NEURAL_PREFIX = "/scanner-neural/";

/**
 * The four, **in the order `load_neural` takes them** — `card_neural::DETECTOR_FILE`,
 * `EMBEDDER_FILE`, `GALLERY_FILE` and `META_FILE`, which `assets.test.ts` holds them to.
 */
export const NEURAL_FILES = [
  "detector.onnx",
  "embedder.onnx",
  "gallery.bin",
  "neural.json",
] as const;
export type NeuralFile = (typeof NEURAL_FILES)[number];

/**
 * **The printing evidence beside them**, in the order `load_neural_evidence` takes them —
 * `card_neural::evidence`'s `SYMBOL_NET_FILE`, `BAND_NET_FILE`, `SYMBOLS_FILE` and `BANDS_FILE`,
 * which `assets.test.ts` holds them to: the set symbol and collector band networks and their
 * galleries. Served from the same folder under the same set, and fetched only once the
 * recogniser has taken its four (`scanner.ts`), holding up no frame — a page whose fetch of them
 * fails reads as it did before they existed.
 */
export const NEURAL_EVIDENCE_FILES = [
  "symbol.onnx",
  "band.onnx",
  "symbols.bin",
  "bands.bin",
] as const;
export type NeuralEvidenceFile = (typeof NEURAL_EVIDENCE_FILES)[number];

/** All eight, the recogniser's then the evidence's. */
const ALL_NEURAL_FILES: readonly (NeuralFile | NeuralEvidenceFile)[] = [
  ...NEURAL_FILES,
  ...NEURAL_EVIDENCE_FILES,
];

/** One of the eight as a build serves it. `set` is the eight files' own id. */
export function neuralPath(set: string, name: string): string {
  return `${NEURAL_PREFIX}${set}/${name}`;
}

/** Whether a request's path names a file of the Neural scanner's, whatever set's. */
export function isNeuralFile(path: string): boolean {
  return /^\/scanner-neural\/[^/]+\/[^/]+$/.test(path);
}

/**
 * The one of the eight a request under `/scanner-neural/<any set>/` asks for, or `null` — what
 * the dev server reads `crates/card-neural/models/` by. Only the eight names are files there:
 * that folder holds a README and nothing else is served from it.
 */
export function neuralFileOf(path: string): NeuralFile | NeuralEvidenceFile | null {
  const name = /^\/scanner-neural\/[^/]+\/([^/]+)$/.exec(path)?.[1];
  return ALL_NEURAL_FILES.find((file) => file === name) ?? null;
}

/** What each of the eight is: `neural.json` is JSON, and the rest are bytes. */
export function neuralContentType(name: string): string {
  return name.endsWith(".json") ? "application/json" : "application/octet-stream";
}

/** The most the host serves as one file: Workers static assets' 25 MiB. */
export const HOST_FILE_LIMIT = 25 * 1024 * 1024;

/** One of the eight as `models/README.md`'s table writes it down. */
export interface NeuralRow {
  bytes: number;
  /** The first and last eight hex digits of its SHA-256 — the table's `4e9a46bd…a87a5a35`. */
  head: string;
  tail: string;
}

/**
 * `crates/card-neural/models/README.md`'s table, read: each file's exact length and the two ends
 * of its digest. The files change as a set and the table with them (`crates/card-neural/CLAUDE.md`),
 * so it is what the web build holds the files it ships to ({@link neuralFault}).
 */
export function neuralTable(readme: string): Map<string, NeuralRow> {
  const rows = new Map<string, NeuralRow>();
  const row = /^\|\s*`([\w.-]+)`\s*\|\s*(\d[\d ]*)\s*\|\s*`([0-9a-f]{8})…([0-9a-f]{8})`\s*\|/gm;
  for (const [, name, bytes, head, tail] of readme.matchAll(row)) {
    rows.set(name, { bytes: Number(bytes.replace(/ /g, "")), head, tail });
  }
  return rows;
}

/** A file a web build found: its name, its length and its SHA-256 in hex. */
export interface FoundFile {
  name: string;
  bytes: number;
  sha256: string;
}

/**
 * Why the Neural files a web build found **cannot ship** — or `null`, when they can: all four of
 * the recogniser's there, each under the host's {@link HOST_FILE_LIMIT}, and each the length and
 * digest `models/README.md` writes down for it. A file the table does not describe was changed without
 * it, and a page that loaded it would be running a model nobody measured.
 *
 * The recogniser's four alone: the evidence is held to the table by {@link neuralEvidenceFault},
 * and a build asks both.
 */
export function neuralFault(
  files: readonly FoundFile[],
  table: ReadonlyMap<string, NeuralRow>,
): string | null {
  return faultAmong(NEURAL_FILES, files, table);
}

/**
 * {@link neuralFault} for the four evidence files ({@link NEURAL_EVIDENCE_FILES}): all four there,
 * under the host's limit, and each as its row in `models/README.md` says. **A question of its
 * own** only so each answer can name its set of files: the web build ships all eight, and refuses
 * to build when either set is missing or does not match the table (`apps/light/vite.config.ts`).
 * It is the page, not the build, that goes on without the evidence when a reader's fetch of it
 * fails.
 */
export function neuralEvidenceFault(
  files: readonly FoundFile[],
  table: ReadonlyMap<string, NeuralRow>,
): string | null {
  return faultAmong(NEURAL_EVIDENCE_FILES, files, table);
}

/** The first of `names` that is missing from `files`, too large, or not as `table` says. */
function faultAmong(
  names: readonly string[],
  files: readonly FoundFile[],
  table: ReadonlyMap<string, NeuralRow>,
): string | null {
  for (const name of names) {
    const file = files.find((found) => found.name === name);
    if (file === undefined) return `crates/card-neural/models/ has no ${name}.`;
    if (file.bytes > HOST_FILE_LIMIT) {
      return `${name} is ${file.bytes} bytes, over the host's ${HOST_FILE_LIMIT} a file.`;
    }
    const row = table.get(name);
    if (row === undefined) return `crates/card-neural/models/README.md has no row for ${name}.`;
    if (
      row.bytes !== file.bytes ||
      !file.sha256.startsWith(row.head) ||
      !file.sha256.endsWith(row.tail)
    ) {
      return (
        `${name} is ${file.bytes} bytes with SHA-256 ${file.sha256}, and ` +
        `crates/card-neural/models/README.md says ${row.bytes} bytes and ${row.head}…${row.tail}.`
      );
    }
  }
  return null;
}

/**
 * The eight files' lengths as a build hands them to the page (`VITE_NEURAL_BYTES`, JSON) — or none
 * for text that is not that. A file is held to its length as it arrives (`scanNeural.ts`).
 */
export function neuralBytesOf(
  text: unknown,
): Partial<Record<NeuralFile | NeuralEvidenceFile, number>> {
  let parsed: unknown;
  try {
    parsed = typeof text === "string" ? JSON.parse(text) : null;
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const lengths: Partial<Record<NeuralFile | NeuralEvidenceFile, number>> = {};
  for (const name of ALL_NEURAL_FILES) {
    const bytes = (parsed as Record<string, unknown>)[name];
    if (typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes > 0)
      lengths[name] = bytes;
  }
  return lengths;
}

/**
 * Whether one of a build's files — its path from the output folder — is **the scanner's, and so
 * fetched on first use and never precached**: its module, its three files and the Neural
 * scanner's eight. None is asked for until a reader opens the Scanner — the three not before
 * Download, the eight not before a Neural frame — and a service worker that put them in its shell
 * would spend 50 MB of every first visit on a view most readers never open.
 */
export function isScannerFile(file: string): boolean {
  return (
    isScannerModule(`/${file}`) ||
    `/${file}`.startsWith(SCANNER_ASSETS_PREFIX) ||
    `/${file}`.startsWith(NEURAL_PREFIX)
  );
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
 * `WEB_IMAGE_PREFIX`; `assets.test.ts` holds this spelling to that constant), the folders the
 * scanner's three files and the Neural scanner's eight are fetched from, and `/_headers`, which a
 * host parses and does not serve.
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
  NEURAL_PREFIX,
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
