import {
  NEURAL_EVIDENCE_FILES,
  NEURAL_FILES,
  NEURAL_PREFIX,
  neuralPath,
  SCANNER_CACHE,
  type NeuralEvidenceFile,
  type NeuralFile,
} from "./assets";
import type { CachesLike } from "./sw/pictures";

/**
 * **The Neural scanner's four files, as the page fetches them** — `card-neural`'s detector,
 * embedder, gallery and `neural.json`, which the scanner's Worker is handed once per Worker, the
 * first time a frame is due (`scanner.ts`). Never before a reader has opened the Scanner and
 * started scanning.
 *
 * **Fetched from the app's own origin and kept by what keeps a content-addressed file**: the
 * address names the set (`assets.ts`' `NEURAL_PREFIX`), so the HTTP cache keeps each a year and
 * the service worker keeps it in the scanner's Cache Storage the first time it passes
 * (`sw/serve.ts`' `fromKept`). The page keeps nothing itself: a Worker that is ended and made
 * again is posted the files again, read back from those caches with no network — and the page's
 * memory holds them only between the read and the post that hands them over.
 *
 * **One at a time, each held to its length** — what the build measured (`VITE_NEURAL_BYTES`). A
 * host that hands its document to a path it does not know answers with a page, and a cut-off
 * body is short: either is refused in a sentence, and no Worker is handed part of a network.
 * Each answer and each chunk is bounded ({@link STALL_MS}), so a fetch that never ends is a
 * failure and not a frame that hangs.
 *
 * **The printing evidence is four more, fetched the same way and later**
 * ({@link fetchNeuralEvidence}): once the recogniser has taken its four, in the background, with
 * no frame waiting on them.
 */

/**
 * How long a fetch may hear nothing — on the answer and on each chunk — before it is given up.
 * The feeds' own bound (`scryfall::STALL`): a fetch that never ended would hold up every frame
 * waiting on the files for good.
 */
export const STALL_MS = 30_000;

/** As much of a streamed body as a fetch reads. */
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

/** What the fetches ask of the browser. Handed in, so the suite gives it fakes. */
export interface NeuralEnv {
  /** `caches`. Absent in a browser, or a context, with none. */
  caches?: CachesLike;
  /**
   * `fetch`, to the app's own origin — `default`, because the files are content-addressed and
   * kept by the HTTP cache and the service worker.
   */
  fetch(path: string, init: { cache: "default" }): Promise<Answered>;
  /** Run `run` after `ms`. */
  after(ms: number, run: () => void): void;
  /** Unix milliseconds. */
  now(): number;
}

/** `1 234 567`, as the core's sentences write a byte count. */
export const spaced = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/**
 * `promise`, or a rejection once {@link STALL_MS} has passed with it still pending — on `env`'s
 * clock. The bound on an answer and on each chunk of a fetch.
 */
export function unstalledBy<T>(env: Pick<NeuralEnv, "after">, promise: Promise<T>): Promise<T> {
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

/** What the page knows of the eight before it asks: their set, and each one's length. */
export interface NeuralSource {
  /** The files' own id — the folder of {@link NEURAL_PREFIX} they are served from. */
  set: string;
  /** Each file's exact length, as the build found it. A file with none is read to its end. */
  bytes: Readonly<Partial<Record<NeuralFile | NeuralEvidenceFile, number>>>;
}

/** The four, as `load_neural` takes them. */
export interface NeuralFiles {
  detector: Uint8Array;
  embedder: Uint8Array;
  gallery: Uint8Array;
  meta: Uint8Array;
}

/** The evidence's four, as `load_neural_evidence` takes them. */
export interface NeuralEvidenceFiles {
  symbolNet: Uint8Array;
  bandNet: Uint8Array;
  symbols: Uint8Array;
  bands: Uint8Array;
}

/** What a fetch that could not reach the origin says. */
export const NEURAL_UNREACHABLE =
  "The Neural scanner's files could not be downloaded. Check your connection.";

/**
 * What a 404 says: the page names a set the server no longer has — a deploy since this page
 * loaded put another there. A reload takes the update, and its set.
 */
export const NEURAL_OTHER_SET =
  "The Neural scanner's files on the server are for another version of MTG Grimoire. " +
  "Reload to update, then try again.";

/** What one file's failure says, after the shared start. */
const failed = (why: string): string =>
  `The Neural scanner's files could not be downloaded: ${why}`;

/** One file, read to its end and held to its length. Rejects with one sentence. */
async function one(
  env: Pick<NeuralEnv, "fetch" | "after">,
  source: NeuralSource,
  name: NeuralFile | NeuralEvidenceFile,
): Promise<Uint8Array<ArrayBuffer>> {
  let response: Answered;
  try {
    // `default`: a file at a content-addressed address is the HTTP cache's to keep, and the
    // service worker's (`sw/serve.ts`) — the page keeps none of the four.
    response = await unstalledBy(
      env,
      env.fetch(neuralPath(source.set, name), { cache: "default" }),
    );
  } catch {
    throw NEURAL_UNREACHABLE;
  }
  if (response.status === 404) throw NEURAL_OTHER_SET;
  if (!response.ok) throw failed(`the server answered ${response.status}.`);
  if ((response.headers.get("Content-Type") ?? "").includes("text/html")) {
    throw failed("the server answered a page, not the file.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw failed("the server answered nothing.");
  const expected = source.bytes[name];
  // Read into the room the file should fill when its length is known — refused at the byte that
  // runs past it — and gathered otherwise.
  const room = expected === undefined ? null : new Uint8Array(expected);
  const chunks: Uint8Array[] = [];
  let at = 0;
  for (;;) {
    let chunk: { done: boolean; value?: Uint8Array };
    try {
      chunk = await unstalledBy(env, reader.read());
    } catch {
      void reader.cancel().catch(() => undefined);
      throw NEURAL_UNREACHABLE;
    }
    if (chunk.done) break;
    const value = chunk.value ?? new Uint8Array(0);
    if (room !== null) {
      if (at + value.byteLength > room.byteLength) {
        void reader.cancel().catch(() => undefined);
        throw failed(
          `${name} is longer than the ${spaced(room.byteLength)} bytes this version expects.`,
        );
      }
      room.set(value, at);
    } else {
      chunks.push(value);
    }
    at += value.byteLength;
  }
  if (room !== null) {
    if (at !== room.byteLength) {
      throw failed(
        `${name} arrived as ${spaced(at)} bytes where ${spaced(room.byteLength)} were expected.`,
      );
    }
    return room;
  }
  const whole = new Uint8Array(at);
  let put = 0;
  for (const value of chunks) {
    whole.set(value, put);
    put += value.byteLength;
  }
  return whole;
}

/**
 * The four files, fetched one after another. Rejects with the first failure's sentence — and then
 * the ones already read are let go with the promise.
 */
export async function fetchNeural(
  env: Pick<NeuralEnv, "fetch" | "after">,
  source: NeuralSource,
): Promise<NeuralFiles> {
  const read: Uint8Array[] = [];
  for (const name of NEURAL_FILES) read.push(await one(env, source, name));
  const [detector, embedder, gallery, meta] = read;
  return { detector, embedder, gallery, meta };
}

/**
 * Whether this build ships the evidence: it names a length for each of its four files. **A build
 * made without them names none, and the page then asks for none** — no request that could only
 * be answered 404, and nothing kept that is not there to keep.
 */
export function shipsEvidence(source: NeuralSource): boolean {
  return NEURAL_EVIDENCE_FILES.every((name) => source.bytes[name] !== undefined);
}

/**
 * The evidence's four files, fetched one after another as {@link fetchNeural}'s are and refused
 * in the same sentences. The page asks for them only after the recogniser has taken its four,
 * and a refusal here is logged and nothing else: Neural reads on without the evidence.
 */
export async function fetchNeuralEvidence(
  env: Pick<NeuralEnv, "fetch" | "after">,
  source: NeuralSource,
): Promise<NeuralEvidenceFiles> {
  const read: Uint8Array[] = [];
  for (const name of NEURAL_EVIDENCE_FILES) read.push(await one(env, source, name));
  const [symbolNet, bandNet, symbols, bands] = read;
  return { symbolNet, bandNet, symbols, bands };
}

/**
 * Whether this browser holds all of `source`'s set already — the recogniser's four and, when the
 * build ships it ({@link shipsEvidence}), the evidence's, kept by the service worker on an earlier
 * visit — so the status can say they are there before this page has asked. Reads no body, and
 * **never creates the cache by asking**; a Cache Storage that throws holds nothing.
 */
export async function neuralKept(
  env: Pick<NeuralEnv, "caches">,
  source: NeuralSource,
): Promise<boolean> {
  if (!env.caches) return false;
  try {
    if (!(await env.caches.keys()).includes(SCANNER_CACHE)) return false;
    const cache = await env.caches.open(SCANNER_CACHE);
    const names = shipsEvidence(source)
      ? [...NEURAL_FILES, ...NEURAL_EVIDENCE_FILES]
      : NEURAL_FILES;
    for (const name of names) {
      if (!(await cache.match(neuralPath(source.set, name), { ignoreVary: true }))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Where the status says the four are fetched from. One asset for four files, as on the desktop. */
export const NEURAL_PATH = NEURAL_PREFIX;
