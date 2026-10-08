import type { ScannerAssetDue } from "@/lib/ipc";
import { SCANNER_ASSETS_PREFIX, SCANNER_CACHE, SCANNER_MANIFEST } from "./assets";
import type { CacheLike, CachesLike } from "./sw/pictures";

/**
 * **Where a browser keeps the scanner's three files, and how they get there** — the web host's
 * half of what `crates/grimoire-core/src/scanner_assets.rs` does for a host with a folder (the
 * light app's step 7.5).
 *
 * **The source is the app's own origin.** The release build copies the three files into the
 * web app's static files (`scripts/scanner-assets.mjs --web`, `apps/light/vite.config.ts`), because
 * the place a native host downloads them from — a GitHub release — sends no CORS header, so a
 * page cannot read it. Beside them is a manifest of that build's own making: each file's name,
 * length and SHA-256, and the bundle's format version.
 *
 * **The store is Cache Storage**, in a cache of the scanner's own ({@link SCANNER_CACHE}) —
 * where this host already keeps card pictures, and not OPFS, which is the engine's SQLite pool
 * and nothing else's. A page reads Cache Storage itself, so a session is built from it with no
 * request at all: offline, and with no service worker in the way.
 *
 * **A file is trusted only after it has been checked, and only then is it kept.** A download
 * is read to its end into memory, held to the manifest's exact length and to its SHA-256 — a
 * browser with no `crypto.subtle` to hash with is refused before a byte is asked for — and
 * only then `put`, whole, as a response built from the bytes. So there is no half-written entry to meet: a download that was cut off put nothing.
 * What is kept carries its length and digest as headers, and a read whose body is not that
 * length deletes the entry rather than hand it over.
 *
 * **What is owed is what the store does not hold as the manifest describes it** — by digest,
 * so a release that rebuilt the bundle of card hashes owes it again under the name it always
 * had, and a bump of the bundle's format owes it too. Until the new one lands the old one is
 * still there and still loads: a scanner that knows last month's cards beats none.
 */

/** The three files, by the key a row and a progress event name one by. */
export type ScanKey = "bundle" | "detectionModel" | "recognitionModel";

/**
 * What each is called: its name on the release, and what a reader is told it is —
 * `scanner_assets::Piece`'s `key`, `asset` and `label`, which `scanStore.test.ts` holds to the
 * Rust text. In the order a fetch takes them, which is the core's. **`about` is the core's
 * own figure for each** (`BUNDLE_BYTES`, a measurement; `DETECTION_BYTES` and
 * `RECOGNITION_BYTES`, exact), used for an offer only when the build's manifest — which has
 * the real ones — cannot be reached.
 */
export const SCAN_FILES: readonly { key: ScanKey; name: string; label: string; about: number }[] = [
  { key: "bundle", name: "card-hashes.bin", label: "Card hashes", about: 5_874_752 },
  {
    key: "detectionModel",
    name: "text-detection.rten",
    label: "Text detection model",
    about: 2_510_284,
  },
  {
    key: "recognitionModel",
    name: "text-recognition.rten",
    label: "Text recognition model",
    about: 9_716_568,
  },
];

/** One file as the build's manifest describes it. */
export interface ScanFile {
  key: ScanKey;
  name: string;
  /** Its exact length. */
  bytes: number;
  /** Its SHA-256, lower-case hex. */
  sha256: string;
}

/** `/scanner-assets/manifest.json`, read. */
export interface ScanManifest {
  /** `card_scanner::index::FORMAT_VERSION` of the bundle these files are. */
  formatVersion: number;
  /** All three, in {@link SCAN_FILES}' order. */
  files: ScanFile[];
}

/**
 * A manifest out of whatever the address answered, or `null` for anything that is not one —
 * **exactly the three files, under exactly their names**, each with a length and a digest. A
 * manifest that names a fourth file, or another name, is one this build does not know how to
 * use, and is refused whole.
 */
export function readManifest(value: unknown): ScanManifest | null {
  if (typeof value !== "object" || value === null) return null;
  const { formatVersion, files } = value as Record<string, unknown>;
  if (typeof formatVersion !== "number" || !Number.isSafeInteger(formatVersion)) return null;
  if (!Array.isArray(files) || files.length !== SCAN_FILES.length) return null;
  const read: ScanFile[] = [];
  for (const { key, name } of SCAN_FILES) {
    const entry = (files as unknown[]).find(
      (file) => typeof file === "object" && file !== null && (file as { key?: unknown }).key === key,
    ) as Record<string, unknown> | undefined;
    if (entry === undefined || entry.name !== name) return null;
    const { bytes, sha256 } = entry;
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) return null;
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return null;
    read.push({ key, name, bytes, sha256 });
  }
  return { formatVersion, files: read };
}

/** What asking the origin for the manifest came to. */
export type ManifestAnswer =
  | { kind: "ok"; manifest: ScanManifest }
  /** The origin has none: this build was made without the scanner's files. */
  | { kind: "missing" }
  /** The origin did not answer, or answered something else. `message` is for a reader. */
  | { kind: "unreachable"; message: string };

/**
 * **The two OCR models' SHA-256, written down** — `scanner_assets::DETECTION_SHA256` and
 * `RECOGNITION_SHA256`, which a host with a folder holds each model to before its loader sees
 * a byte. The models are fixed files, unlike the bundle, so the build's manifest is not the
 * only word on them: a manifest that names another digest for either is one this version does
 * not read (`scanner.ts`), and a stored model kept under another is not handed to the module.
 * `scanStore.test.ts` holds both to the Rust text.
 */
export const MODEL_SHA256: Readonly<Partial<Record<ScanKey, string>>> = {
  detectionModel: "f15cfb56bd02c4bf478a20343986504a1f01e1665c2b3a0ad66340f054b1b5ca",
  recognitionModel: "e484866d4cce403175bd8d00b128feb08ab42e208de30e42cd9889d8f1735a6e",
};

/** What a bundle that parses and holds no card is refused with — the core's words for one. */
export const EMPTY_BUNDLE = "it holds no cards";

/** A stored file's own record of what it is — the two headers it was kept under. */
export interface Kept {
  bytes: number;
  sha256: string;
}

/** The digest a stored file was kept under. */
export const SHA_HEADER = "X-Grimoire-Sha256";
/** When it was kept, in Unix milliseconds — for whoever reads the cache by hand. */
export const KEPT_HEADER = "X-Grimoire-Stored";

/** What a second fetch hears while one is running — `scanner_assets::ALREADY_FETCHING`. */
export const ALREADY_FETCHING = "The scanner's files are already downloading.";

/** What a fetch says when the origin could not be asked at all. */
export const UNREACHABLE =
  "The scanner's files could not be downloaded. Check your connection, then try again.";

/**
 * What a browser with no `crypto.subtle` is told, before a byte is asked for. A file is kept
 * under the digest the manifest names and trusted by it from then on — a model is handed to
 * the module because its kept digest is the pinned one — so a file nobody hashed must not be
 * kept at all. (A page on a secure context always has one; this is plain `http` off
 * `localhost`.)
 */
export const NO_DIGEST =
  "This browser cannot check the scanner's files, so they were not downloaded.";

/** What a store that would not take a checked file is said to have done. The browser's own
 *  reason goes to the console: a reader's sentence does not end in one. */
export const NOT_KEPT = "The scanner's files could not be kept in this browser's storage.";

/** What a browser with no Cache Storage is told: there is nowhere to keep eighteen megabytes. */
export const NO_STORAGE = "This browser gives MTG Grimoire no storage to keep the scanner's files in.";

/**
 * How long a download may hear nothing — on the answer and on each chunk — before it is given
 * up. The feeds' own bound (`scryfall::STALL`): a fetch that never ended would hold the one
 * claim for good, and every later press would be told one is already running.
 */
export const STALL_MS = 30_000;

/** Bytes of download between two progress events — the core's `PROGRESS_STEP`. */
export const PROGRESS_STEP = 256 * 1024;

/** As much of a streamed body as a download reads. */
interface BodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

/** As much of a `Response` as this reads — which lets the suite hand it a body of its own. */
export interface Answered {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: { getReader(): BodyReader } | null;
  json(): Promise<unknown>;
}

/** What the store asks of the browser. Handed in, so the suite gives it fakes. */
export interface StoreEnv {
  /** `caches`. Absent in a browser, or a context, with none. */
  caches?: CachesLike;
  /** `fetch`, to the app's own origin. `no-store`: what arrives is kept here, not there too. */
  fetch(path: string, init: { cache: "no-store" }): Promise<Answered>;
  /** SHA-256 as lower-case hex. Absent where there is no `crypto.subtle`. */
  digest?: (bytes: Uint8Array) => Promise<string>;
  /** Run `run` after `ms`. */
  after(ms: number, run: () => void): void;
  /** Unix milliseconds. */
  now(): number;
}

export interface ScanStore {
  /** Ask the origin what this build's files are. Asked afresh each time: a deploy moves it. */
  manifest(): Promise<ManifestAnswer>;
  /** What the store holds of each file, by its own record. Reads no body. */
  kept(): Promise<Record<ScanKey, Kept | null>>;
  /** One file's bytes, or `null` when it is not held — or is held and is not whole. */
  read(key: ScanKey): Promise<Uint8Array | null>;
  /**
   * Download `file` to its end, check it, keep it. `heard` is told of every chunk's length as
   * it arrives, and `checking` once the last has. Rejects with an `Error` whose message is one
   * sentence a reader can be shown; nothing is kept then.
   */
  fetch(file: ScanFile, heard: (bytes: number) => void, checking?: () => void): Promise<void>;
}

const pathOf = (name: string): string => `${SCANNER_ASSETS_PREFIX}${name}`;
const nameOf = (key: ScanKey): string => SCAN_FILES.find((file) => file.key === key)?.name ?? key;
const labelOf = (key: ScanKey): string => SCAN_FILES.find((file) => file.key === key)?.label ?? key;

/**
 * **Which files a fetch would bring**: the manifest's, less each the store holds under the
 * same length and digest — as rows in the shape the core answers (`downloads::Due`).
 */
export function owedRows(manifest: ScanManifest, kept: Record<ScanKey, Kept | null>): ScannerAssetDue[] {
  return manifest.files
    .filter((file) => {
      const held = kept[file.key];
      return held === null || held.bytes !== file.bytes || held.sha256 !== file.sha256;
    })
    .map((file) => ({ key: file.key, label: labelOf(file.key), bytes: file.bytes }));
}

/** `1 234 567`, as the core's sentences write a byte count. */
const spaced = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

export function createScanStore(env: StoreEnv): ScanStore {
  /** The scanner's cache when it exists — **never created by a question**, only by a write. */
  async function existing(): Promise<CacheLike | null> {
    if (!env.caches) return null;
    try {
      return (await env.caches.keys()).includes(SCANNER_CACHE)
        ? await env.caches.open(SCANNER_CACHE)
        : null;
    } catch {
      // A Cache Storage that throws holds nothing anybody can read.
      return null;
    }
  }

  /** `promise`, or a rejection once {@link STALL_MS} has passed with it still pending. */
  function unstalled<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let over = false;
      env.after(STALL_MS, () => {
        if (!over) reject(new Error("stalled"));
      });
      promise.then(
        (value) => {
          over = true;
          resolve(value);
        },
        (error: unknown) => {
          over = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  async function download(
    file: ScanFile,
    heard: (bytes: number) => void,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const label = labelOf(file.key);
    let response: Answered;
    try {
      response = await unstalled(env.fetch(pathOf(file.name), { cache: "no-store" }));
    } catch {
      throw new Error(UNREACHABLE);
    }
    if (!response.ok) {
      throw new Error(`${label} could not be downloaded: the server answered ${response.status}.`);
    }
    // A host that hands its document to any path it does not know answers a missing file with
    // a 200 of HTML (`sw/serve.ts`'s `shellFile` has met one). Said as what it is.
    if ((response.headers.get("Content-Type") ?? "").includes("text/html")) {
      throw new Error(`${label} could not be downloaded: the server answered a page, not the file.`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error(`${label} could not be downloaded: the server answered nothing.`);
    // The manifest's length exactly: a file is read into the room it should fill, and one
    // that runs past it is refused at the byte that does — never grown into.
    const bytes = new Uint8Array(file.bytes);
    let at = 0;
    for (;;) {
      let chunk: { done: boolean; value?: Uint8Array };
      try {
        chunk = await unstalled(reader.read());
      } catch {
        void reader.cancel().catch(() => undefined);
        throw new Error(UNREACHABLE);
      }
      if (chunk.done) break;
      const value = chunk.value ?? new Uint8Array(0);
      if (at + value.byteLength > file.bytes) {
        void reader.cancel().catch(() => undefined);
        throw new Error(
          `${label} arrived as more than the ${spaced(file.bytes)} bytes this version expects. ` +
            "Reload to update, then try again.",
        );
      }
      bytes.set(value, at);
      at += value.byteLength;
      heard(value.byteLength);
    }
    if (at !== file.bytes) {
      throw new Error(
        `${label} arrived as ${spaced(at)} bytes where ${spaced(file.bytes)} were expected. Try again.`,
      );
    }
    return bytes;
  }

  return {
    async manifest(): Promise<ManifestAnswer> {
      let response: Answered;
      try {
        response = await unstalled(env.fetch(pathOf(SCANNER_MANIFEST), { cache: "no-store" }));
      } catch {
        return { kind: "unreachable", message: UNREACHABLE };
      }
      if (response.status === 404) return { kind: "missing" };
      if (!response.ok) {
        const message = `The scanner's files could not be downloaded: the server answered ${response.status}.`;
        return { kind: "unreachable", message };
      }
      const manifest = readManifest(await response.json().catch(() => null));
      return manifest === null
        ? {
            kind: "unreachable",
            message: "The scanner's files could not be downloaded: the server's list of them is unreadable.",
          }
        : { kind: "ok", manifest };
    },

    async kept(): Promise<Record<ScanKey, Kept | null>> {
      const held: Record<ScanKey, Kept | null> = {
        bundle: null,
        detectionModel: null,
        recognitionModel: null,
      };
      const cache = await existing();
      if (cache === null) return held;
      for (const { key, name } of SCAN_FILES) {
        const stored = await cache.match(pathOf(name), { ignoreVary: true }).catch(() => undefined);
        const bytes = Number(stored?.headers.get("Content-Length"));
        const sha256 = stored?.headers.get(SHA_HEADER);
        if (stored && Number.isSafeInteger(bytes) && typeof sha256 === "string") {
          held[key] = { bytes, sha256 };
        }
      }
      return held;
    },

    async read(key: ScanKey): Promise<Uint8Array | null> {
      const cache = await existing();
      if (cache === null) return null;
      const path = pathOf(nameOf(key));
      try {
        const stored = await cache.match(path, { ignoreVary: true });
        if (!stored) return null;
        const bytes = new Uint8Array(await stored.arrayBuffer());
        if (bytes.byteLength === Number(stored.headers.get("Content-Length"))) return bytes;
        // Not the length it was kept at: whatever this is, it is not the file. Gone, so the
        // next look owes it again.
        await cache.delete(path, { ignoreVary: true });
        return null;
      } catch {
        return null;
      }
    },

    async fetch(
      file: ScanFile,
      heard: (bytes: number) => void,
      checking?: () => void,
    ): Promise<void> {
      if (!env.caches) throw new Error(NO_STORAGE);
      if (!env.digest) throw new Error(NO_DIGEST);
      const bytes = await download(file, heard);
      checking?.();
      const got = await env.digest(bytes).catch(() => null);
      if (got !== file.sha256) {
        throw new Error(
          `${labelOf(file.key)} did not arrive as the file this version expects. Try again.`,
        );
      }
      try {
        const cache = await env.caches.open(SCANNER_CACHE);
        // Built from the bytes, whole, immediately before its `put`: there is no moment at
        // which this address answers part of a file.
        await cache.put(
          pathOf(file.name),
          new Response(bytes, {
            status: 200,
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(bytes.byteLength),
              [SHA_HEADER]: file.sha256,
              [KEPT_HEADER]: String(env.now()),
            },
          }),
        );
      } catch (error) {
        console.warn("MTG Grimoire: the scanner's files could not be kept.", error);
        throw new Error(NOT_KEPT, { cause: error });
      }
    },
  };
}
