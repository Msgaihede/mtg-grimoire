/**
 * **What crosses `postMessage` between the page and the scanner's Worker** — the second wire of
 * the web host, beside `protocol.ts`'s, and hand-written for that file's reason: nothing
 * generates it. `scanProtocol.test.ts` pins the strings.
 *
 * **A plain module that both programs read**: the page's half (`./scanner.ts`) under the `DOM`
 * lib, the Worker's (`./scanWorker.ts`, `./scanSession.ts`) under `WebWorker`
 * (`packages/ui/tsconfig.web-worker.json`). So nothing here may name a global only one of the two has.
 *
 * The far end is `crates/grimoire-scan`: six synchronous exports over one session, every string
 * of which is `{"ok": …}` or `{"err": "<sentence>"}` (`grimoire_scan.d.ts`).
 */

/** What the module's `load` says it found — `Loaded` in `crates/grimoire-scan/src/scanner.rs`. */
export interface LoadFacts {
  bundle: { loaded: boolean; entries: number; error: string | null };
  /** Labels attached. Zero is a session that answers ids with no names. */
  labels: number;
  /** The two readers, which load as a pair or not at all. */
  models: { loaded: boolean; error: string | null };
  /** Filters this session would not take, in the crate's words; `null` when none is owed. */
  unapplied_filters: string | null;
}

/** Page → scanner Worker. Every message carries the id its answer comes back under. */
export type ToScanner =
  /**
   * Build the session from bytes. Each of the four is `null` where the page has none.
   * **`filters` is what the session before this one was searching under** — or what the page
   * set before there was a session — as `ScanFilters` JSON: handed to the module ahead of the
   * load, which owes them to it and says in `unapplied_filters` if they were not taken.
   */
  | {
      kind: "load";
      id: number;
      filters: string | null;
      bundle: Uint8Array | null;
      labels: Uint8Array | null;
      detection: Uint8Array | null;
      recognition: Uint8Array | null;
    }
  /** One frame: a JPEG, the same frame at the camera's resolution or `null`, the options' JSON. */
  | { kind: "frame"; id: number; jpeg: Uint8Array; detail: Uint8Array | null; options: string }
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
  // Covered end to end by the views named: the one whole view, or a frame and its detail.
  return [...found].filter(([buffer, covered]) => covered === buffer.byteLength).map(([b]) => b);
}

/** The `load` a session is built by. **Every array is handed over**: eighteen megabytes of files
 *  and six of labels are in one place at a time, and the page keeps none of them. */
export function loadMessage(
  id: number,
  filters: string | null,
  files: {
    bundle: Uint8Array | null;
    labels: Uint8Array | null;
    detection: Uint8Array | null;
    recognition: Uint8Array | null;
  },
): ScanOutgoing {
  return {
    message: { kind: "load", id, filters, ...files },
    transfer: buffersOf([files.bundle, files.labels, files.detection, files.recognition]),
  };
}

/** The header a frame's options ride in — `scanner::OPTIONS_HEADER`. */
export const OPTIONS_HEADER = "x-scanner-options";
/** The header that says how many of the body's bytes are the frame — `scanner::DETAIL_HEADER`. */
export const DETAIL_HEADER = "x-scanner-detail";

/**
 * The `frame` a `scanner_frame` call becomes, or the sentence it is refused with.
 *
 * **The body is the JPEG, or the JPEG with the detail image behind it**, split at
 * {@link DETAIL_HEADER}'s number — the desktop's rule (`scanner::frame_from`), and its
 * sentences word for word: a length that is no number, zero, or not short of the body is a
 * refusal, because a frame judged with the wrong half of its bytes is the quieter failure.
 *
 * **Nothing is copied.** The two halves are views of the one body and the body's buffer is
 * what is handed over, so a read frame's megabyte crosses once. Only a body that is itself a
 * view of part of something is copied first — `protocol.ts`'s rule for the engine's calls.
 *
 * `options` is the header's text as it came. The module reads it, and an unreadable one is the
 * defaults there as it is on the desktop.
 */
export function frameMessage(
  id: number,
  body: Uint8Array,
  headers: Record<string, string> | undefined,
): ScanOutgoing | string {
  const whole = body.buffer instanceof ArrayBuffer && body.byteLength === body.buffer.byteLength;
  const bytes = whole ? body : body.slice();
  const options = headers?.[OPTIONS_HEADER] ?? "";
  const length = headers?.[DETAIL_HEADER];
  if (length === undefined) {
    return {
      message: { kind: "frame", id, jpeg: bytes, detail: null, options },
      transfer: buffersOf([bytes]),
    };
  }
  // As Rust's `usize` parse reads one (`scanner::split_detail`): digits, with a `+` allowed
  // in front and nothing else — no sign, no space, no fraction.
  const n = /^\+?\d+$/.test(length) ? Number(length) : NaN;
  if (!Number.isSafeInteger(n)) {
    return `the frame's detail length is not a number: ${JSON.stringify(length)}`;
  }
  if (n === 0) return "the frame's detail length is zero, so there is no frame before it";
  if (n >= bytes.byteLength) {
    return (
      `the frame's detail length is ${n} bytes but the body is ${bytes.byteLength} — there is ` +
      "no detail image behind the frame"
    );
  }
  const jpeg = bytes.subarray(0, n);
  const detail = bytes.subarray(n);
  return {
    message: { kind: "frame", id, jpeg, detail, options },
    transfer: buffersOf([jpeg, detail]),
  };
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
  const { bundle, labels, models, unapplied_filters } = value as Record<string, unknown>;
  const fact = (asset: unknown): { loaded: boolean; error: string | null } | null => {
    if (typeof asset !== "object" || asset === null) return null;
    const { loaded, error } = asset as Record<string, unknown>;
    if (typeof loaded !== "boolean") return null;
    return { loaded, error: typeof error === "string" ? error : null };
  };
  const bundleFact = fact(bundle);
  const modelsFact = fact(models);
  if (bundleFact === null || modelsFact === null || typeof labels !== "number") return null;
  const entries = (bundle as Record<string, unknown>).entries;
  return {
    bundle: { ...bundleFact, entries: typeof entries === "number" ? entries : 0 },
    labels,
    models: modelsFact,
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
