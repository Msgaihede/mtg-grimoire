/**
 * **The scanner's module, typed by hand** — `grimoire_web.d.ts`'s twin, for its reason:
 * `scripts/build-wasm.ts` writes `grimoire_scan.js` and `grimoire_scan_bg.wasm` to
 * `dist-wasm/scanner/`, which is ignored, so the declarations wasm-bindgen writes beside them
 * are on no machine that has not built the module. `crates/grimoire-scan/CLAUDE.md` §1 is the
 * contract these mirror; the build fails if an export is missing from the glue.
 *
 * Nothing imports the module by this name. The scanner's Worker loads it by URL at runtime
 * (`scanWorker.ts`), and what is taken from here is the type alone.
 *
 * **Every function but the initialiser is synchronous, and every string is `{"ok": …}` or
 * `{"err": "<sentence>"}`.** A call that throws is a trap — the module is built with
 * `panic = "abort"` — and the instance is over: a new Worker is the only containment.
 */

/**
 * Instantiate the module. Rejects with a `WebAssembly.CompileError` in a browser without SIMD,
 * which this module is built for.
 */
export default function init(input?: { module_or_path: string }): Promise<unknown>;

/**
 * Build the session, replacing the one there was, with the labels the engine encoded — or none.
 * Answers `scanProtocol.ts`'s `LoadFacts` under `ok`; never an `err` for labels that would not
 * decode — the session then answers ids, and says it attached none.
 */
export function load(labels?: Uint8Array | null): string;

/**
 * Give the session the recogniser's four files — `card-neural`'s detector, embedder, gallery and
 * `neural.json`. **Not the envelope**: `undefined`, or the crate's sentence for files that would
 * not load. Into the session `load` built; a later `load` lets them go with it.
 */
export function load_neural(
  detector: Uint8Array,
  embedder: Uint8Array,
  gallery: Uint8Array,
  meta: Uint8Array,
): string | undefined;

/**
 * Give the session the recogniser's printing evidence — `card-neural`'s set symbol and collector
 * band networks and their galleries — after `load_neural` has taken the recogniser. **Not the
 * envelope**: `undefined`, or the crate's sentence — before the recogniser, without an
 * `evidence` section in its `neural.json`, or for files that would not load. A refusal leaves
 * the recogniser reading as it did.
 */
export function load_neural_evidence(
  symbol_net: Uint8Array,
  band_net: Uint8Array,
  symbols: Uint8Array,
  bands: Uint8Array,
): string | undefined;

/** One frame, a JPEG. Answers the verdict exactly as the desktop's `scanner_frame` serialises it. */
export function frame(jpeg: Uint8Array): string;

/** Forget the card in front of the lens, keeping the session. */
export function reset(): string;

/** Narrow every later frame. Before the first `load`, the filters are owed to it. */
export function set_filters(filters: string): string;

/** The module's linear memory in bytes. It never shrinks. */
export function memory_bytes(): number;
