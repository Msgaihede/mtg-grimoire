/**
 * **The scanner's module, typed by hand** — `grimoire_web.d.ts`'s twin, for its reason:
 * `scripts/build-wasm.mjs` writes `grimoire_scan.js` and `grimoire_scan_bg.wasm` to
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
 * Build the session from bytes, replacing the one there was. Each is optional. Answers
 * `scanProtocol.ts`'s `LoadFacts` under `ok`; never an `err` for a file that would not load —
 * that is a fact on its own asset.
 */
export function load(
  bundle?: Uint8Array | null,
  labels?: Uint8Array | null,
  detection?: Uint8Array | null,
  recognition?: Uint8Array | null,
): string;

/**
 * One frame. `options` is a `FrameOptions` as JSON; left out, empty, or text that is not one,
 * it is the defaults. Answers the verdict exactly as the desktop's `scanner_frame` serialises it.
 */
export function frame(
  jpeg: Uint8Array,
  detail?: Uint8Array | null,
  options?: string | null,
): string;

/** Forget the card in front of the lens, keeping the session. */
export function reset(): string;

/** Narrow every later frame. Before the first `load`, the filters are owed to it. */
export function set_filters(filters: string): string;

/** The module's linear memory in bytes. It never shrinks. */
export function memory_bytes(): number;
