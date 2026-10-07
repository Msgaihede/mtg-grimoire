/**
 * **The engine's module, typed by hand.** `scripts/build-wasm.mjs` runs wasm-bindgen with
 * `--target web` over `crates/grimoire-web` and writes `grimoire_web.js` and
 * `grimoire_web_bg.wasm` to `dist-wasm/`, which is ignored — so the declarations wasm-bindgen
 * would write beside them are on no machine that has not built the module, and `tsc` runs on all
 * of them. This file is the contract instead, and it is the whole of it: four exports and the
 * initialiser.
 *
 * Nothing imports the module by this name. The Worker loads it by URL at runtime (`worker.ts`),
 * and what is taken from here is the type alone.
 */

/**
 * Instantiate the module. `module_or_path` is the `.wasm`'s URL; wasm-bindgen 0.2.127 deprecated
 * the bare positional form.
 */
export default function init(input?: { module_or_path: string }): Promise<unknown>;

/**
 * Install the OPFS pool and open both databases under `directory`. Answers JSON text —
 * `protocol.ts`'s `Opened`.
 */
export function open(directory: string): Promise<string>;

/**
 * One command of `grimoire_core::dispatch`. `args` is JSON text, `"null"` for a call with none.
 * Answers JSON text, `{"ok": value}` or `{"err": "message"}`, and never rejects — a rejection
 * here is a trap.
 */
export function call(name: string, args: string, body?: Uint8Array): Promise<string>;

/** Hand the engine its one event sink: every event's name, and its payload as JSON text. */
export function listen(handler: (name: string, payload: string) => void): void;

/**
 * Every printing's label as `card_scanner::labels` bytes — what the scanner's own module reads
 * names from (`grimoire_scan.d.ts`'s `load`). **No bytes** before `open` is ready and while
 * the corpus is empty — an answer. **Rejects, with one sentence, when the read failed or gave
 * up** on a corpus that kept changing under it: that is not an empty corpus, and the page's
 * scanner says so and asks again. The array is a copy out of the module's memory, the whole
 * of a buffer of its own, so it can be transferred.
 */
export function scanner_labels(): Promise<Uint8Array>;
