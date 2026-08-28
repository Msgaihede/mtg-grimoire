/**
 * What crosses `postMessage` between the page and the database Worker.
 *
 * The mirror of `src-tauri/src/web/wire.rs`, hand-written for the same reason every DTO in
 * `src/lib/ipc.ts` is: there is no generator, and a `serde` rename here is a `undefined`
 * there rather than a type error. `wire.rs`'s own tests pin the `kind` strings on the Rust
 * side; this file is what pins them on ours.
 *
 * **`open` carries a directory and no filename.** The data folder holds *two* databases —
 * `user.db`, the reader's collection, and `corpus.db`, Scryfall's — and the Rust side opens
 * the pair itself from fixed names. A `file` here would be a third opinion about which one
 * is which.
 */

/** Page → Worker. */
export type ToWorker =
  | { kind: "open"; directory: string }
  | { kind: "call"; id: number; command: string; args?: Record<string, unknown> }
  | { kind: "ingest-cards"; descriptorUrl: string };

/** Worker → page. */
export type FromWorker =
  | { kind: "opened"; opened: Opened }
  | { kind: "ok"; id: number; result: unknown }
  | { kind: "err"; id: number; message: string }
  | { kind: "event"; event: string; payload: unknown }
  | { kind: "corpus-done"; inserted: number; skipped: number }
  | { kind: "corpus-failed"; message: string };

/**
 * The answer to `open`. Mirrors `wire::Opened`.
 *
 * **Two journals, because the data folder is two files.** Both read `delete` on the OPFS
 * pool — the VFS refuses WAL — and they are reported apart because a journal is a property
 * of a *file*: the corpus is the half that writes the huge journal during an ingest.
 * `schemaVersion` is the **user** file's, which is the one that gates compatibility; the
 * corpus carries its own, incomparable number and a reader is never shown it.
 */
export type Opened =
  | { kind: "ready"; journal: string; corpusJournal: string; schemaVersion: number }
  | { kind: "already-open" }
  | { kind: "failed"; message: string };

/** The event the Worker emits while the corpus is being built. */
export const CORPUS_PROGRESS = "corpus-progress";
