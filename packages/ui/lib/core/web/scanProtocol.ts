/**
 * **What crosses `postMessage` between the page and the scanner's Worker** — the second wire of
 * the web host, beside `protocol.ts`'s, and hand-written for that file's reason: nothing
 * generates it. `scanProtocol.test.ts` pins the strings.
 *
 * **A plain module that both programs read**: the page's half (`./scanner.ts`) under the `DOM`
 * lib, the Worker's (`./scanWorker.ts`, `./scanSession.ts`) under `WebWorker`
 * (`packages/ui/tsconfig.web-worker.json`). So nothing here may name a global only one of the two has.
 *
 * The far end is `crates/grimoire-scan`: eight synchronous exports over one session, every string
 * of which is `{"ok": …}` or `{"err": "<sentence>"}` (`grimoire_scan.d.ts`) — but `load_neural`'s
 * and `load_neural_evidence`'s, a refusal or nothing, which the Worker turns into the same two
 * (`scanSession.ts`).
 */

/** What the module's `load` says it found — `Loaded` in `crates/grimoire-scan/src/scanner.rs`. */
export interface LoadFacts {
  /** Labels attached. Zero is a session that answers ids with no names. */
  labels: number;
  /** Filters this session would not take, in the crate's words; `null` when none is owed. */
  unapplied_filters: string | null;
}

/** Page → scanner Worker. Every message carries the id its answer comes back under. */
export type ToScanner =
  /**
   * Build the session, with the engine's labels or `null` where it gave none.
   * **`filters` is what the session before this one was searching under** — or what the page
   * set before there was a session — as `ScanFilters` JSON: handed to the module ahead of the
   * load, which owes them to it and says in `unapplied_filters` if they were not taken.
   */
  | { kind: "load"; id: number; filters: string | null; labels: Uint8Array | null }
  /**
   * The recogniser's four files, into the session the `load` built — posted once per Worker,
   * before its first frame (`scanner.ts`). Answered `ok` with `null`, or `err` with the crate's
   * sentence for files that would not load.
   */
  | {
      kind: "neural";
      id: number;
      detector: Uint8Array;
      embedder: Uint8Array;
      gallery: Uint8Array;
      meta: Uint8Array;
    }
  /**
   * The recogniser's printing evidence — the set symbol and collector band networks and their
   * galleries — into the session whose recogniser has taken the four: posted once per Worker,
   * in the background, after the `neural` hand-over has answered `ok` (`scanner.ts`). Answered
   * as that one is.
   */
  | {
      kind: "neural-evidence";
      id: number;
      symbolNet: Uint8Array;
      bandNet: Uint8Array;
      symbols: Uint8Array;
      bands: Uint8Array;
    }
  /** One frame: a JPEG. */
  | { kind: "frame"; id: number; jpeg: Uint8Array }
  | { kind: "reset"; id: number }
  | { kind: "filters"; id: number; filters: string }
  /** The module's linear memory in bytes — a high-water mark, which only ending the Worker lowers. */
  | { kind: "memory"; id: number };

/** Scanner Worker → page. */
export type FromScanner =
  | { kind: "ok"; id: number; result: unknown }
  /** The module's own `{"err": …}`: an answer about this call, and the session stands. */
  | { kind: "err"; id: number; message: string }
  /**
   * **There is no module to ask.** `unsupported` is a module this browser will not compile — the
   * scanner's is built with `simd128`, and a browser without it refuses the bytes with a
   * `CompileError` — which no retry changes; otherwise the files did not arrive, which one may.
   */
  | { kind: "unloaded"; id: number; unsupported: boolean; message: string }
  /**
   * **An export threw**, which for a module built with `panic = "abort"` is a trap: the instance
   * is over, its memory in whatever state the panic left it. The page ends this Worker and
   * builds another for the next command.
   */
  | { kind: "trapped"; id: number; message: string };

/** A message and what it hands over rather than copies. */
export interface ScanOutgoing {
  message: ToScanner;
  transfer: ArrayBuffer[];
}

/**
 * The buffers of `views`, each once, **for views that are the whole of their buffer or that
 * share one with each other** — what a message hands over. A view over part of a buffer nobody
 * here owns is left out, and so copied by the post: a transfer takes the buffer, and every
 * other view of it with it.
 */
function buffersOf(views: readonly (Uint8Array | null)[]): ArrayBuffer[] {
  const found = new Map<ArrayBuffer, number>();
  for (const view of views) {
    if (view === null || view.byteLength === 0) continue;
    const { buffer } = view;
    if (!(buffer instanceof ArrayBuffer)) continue;
    found.set(buffer, (found.get(buffer) ?? 0) + view.byteLength);
  }
  // Covered end to end by the views named.
  return [...found].filter(([buffer, covered]) => covered === buffer.byteLength).map(([b]) => b);
}

/** The `load` a session is built by. **The labels are handed over**: six megabytes with a full
 *  corpus, which the page keeps no copy of. */
export function loadMessage(
  id: number,
  filters: string | null,
  labels: Uint8Array | null,
): ScanOutgoing {
  return {
    message: { kind: "load", id, filters, labels },
    transfer: buffersOf([labels]),
  };
}

/**
 * The message that hands the Worker the recogniser's four files. **Every array is handed over**:
 * twenty-seven megabytes, which the page fetched for this post and keeps none of.
 */
export function neuralMessage(
  id: number,
  files: { detector: Uint8Array; embedder: Uint8Array; gallery: Uint8Array; meta: Uint8Array },
): ScanOutgoing {
  return {
    message: { kind: "neural", id, ...files },
    transfer: buffersOf([files.detector, files.embedder, files.gallery, files.meta]),
  };
}

/**
 * The message that hands the Worker the recogniser's printing evidence. **Every array is handed
 * over**, as {@link neuralMessage}'s are: the page fetched them for this post and keeps none.
 */
export function neuralEvidenceMessage(
  id: number,
  files: { symbolNet: Uint8Array; bandNet: Uint8Array; symbols: Uint8Array; bands: Uint8Array },
): ScanOutgoing {
  return {
    message: { kind: "neural-evidence", id, ...files },
    transfer: buffersOf([files.symbolNet, files.bandNet, files.symbols, files.bands]),
  };
}

/**
 * The `frame` a `scanner_frame` call becomes. **The body is the JPEG, and nothing rides beside
 * it** — the desktop's rule (`scanner::scanner_frame`).
 *
 * **Nothing is copied.** The body's buffer is what is handed over, so a frame's bytes cross once.
 * Only a body that is itself a view of part of something is copied first — `protocol.ts`'s rule
 * for the engine's calls.
 */
export function frameMessage(id: number, body: Uint8Array): ScanOutgoing {
  const whole = body.buffer instanceof ArrayBuffer && body.byteLength === body.buffer.byteLength;
  const jpeg = whole ? body : body.slice();
  return { message: { kind: "frame", id, jpeg }, transfer: buffersOf([jpeg]) };
}

/** What an unreadable answer is called, with the text that was not one. */
const unreadable = (text: string): string =>
  `The card scanner answered something unreadable: ${text.slice(0, 200)}`;

/**
 * One of the module's strings — `{"ok": value}` or `{"err": "sentence"}` — as the message the
 * page is sent. Anything else is an `err` that says so: an answer nobody can read must still
 * settle the call it belongs to.
 */
export function scanAnswerOf(id: number, text: string): FromScanner {
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    return { kind: "err", id, message: unreadable(text) };
  }
  if (typeof answer === "object" && answer !== null) {
    if ("err" in answer) return { kind: "err", id, message: String(answer.err) };
    if ("ok" in answer) return { kind: "ok", id, result: answer.ok };
  }
  return { kind: "err", id, message: unreadable(text) };
}

/** A `load`'s answer, read: the facts, or `null` for anything that is not them. */
export function loadFactsOf(value: unknown): LoadFacts | null {
  if (typeof value !== "object" || value === null) return null;
  const { labels, unapplied_filters } = value as Record<string, unknown>;
  if (typeof labels !== "number") return null;
  return {
    labels,
    unapplied_filters: typeof unapplied_filters === "string" ? unapplied_filters : null,
  };
}

/**
 * Whether a module's load failed because **this browser will not compile it** — a
 * `WebAssembly.CompileError`, which is what a build with `simd128` gets from a browser without
 * it ("Wasm SIMD unsupported"), or a `LinkError`. By name: the error may have crossed a realm.
 */
export function isUnsupported(error: unknown): boolean {
  const name = typeof error === "object" && error !== null && "name" in error ? error.name : "";
  return name === "CompileError" || name === "LinkError";
}
