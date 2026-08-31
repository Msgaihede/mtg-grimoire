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

/**
 * Which of the three optional bulk feeds a `feed-refresh` is asking for.
 *
 * **The corpus is not on this list**, and that is the one asymmetry worth reading twice:
 * `ingest-cards` is its own message because building the card database is what the boot
 * screen does before the app exists, with its own progress screen and its own two terminal
 * messages. These three are refreshes a reader presses in Settings, and each answers with a
 * status DTO through the ordinary `ok`/`err` pair.
 */
export type FeedRefresh =
  | { feed: "combos"; force: boolean }
  | { feed: "tags"; dataset: "oracle" | "art"; force: boolean }
  | { feed: "prices"; marketplace: string };

/** Page → Worker. */
export type ToWorker =
  | { kind: "open"; directory: string }
  | { kind: "call"; id: number; command: string; args?: Record<string, unknown> }
  | { kind: "ingest-cards"; descriptorUrl: string }
  | ({ kind: "feed-refresh"; id: number } & FeedRefresh);

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

/**
 * The four commands that are a **download** rather than a query, and the `feed-refresh` each
 * one becomes.
 *
 * **This map is the whole of the web target's answer to "a wasm export is not a routed
 * command".** `web::route::COMMANDS` is synchronous, takes the connection and makes no
 * network call; a refresh is none of those, so it is a `#[wasm_bindgen]` entry instead. That
 * would leave every Settings panel needing a `isWebTarget()` branch — so the *core* takes the
 * branch here, once, and `ipc.combosRefresh(true)` reaches the export on a browser and the
 * Tauri command on a desktop with no panel any the wiser.
 *
 * The argument names are the Rust commands' own (`force`, `marketplace`), which is what
 * `src/lib/ipc.ts` already sends.
 */
export function feedRefreshFor(
  command: string,
  args?: Record<string, unknown>,
): FeedRefresh | undefined {
  const force = args?.force === true;
  switch (command) {
    case "combos_refresh":
      return { feed: "combos", force };
    case "oracle_tags_refresh":
      return { feed: "tags", dataset: "oracle", force };
    case "art_tags_refresh":
      return { feed: "tags", dataset: "art", force };
    case "marketplace_feed_refresh":
      return { feed: "prices", marketplace: String(args?.marketplace ?? "") };
    default:
      return undefined;
  }
}
