/// <reference lib="webworker" />
import type { FromWorker, Opened, ToWorker } from "./protocol";
import { CORPUS_PROGRESS } from "./protocol";

/**
 * The database, and everything that touches it.
 *
 * **Not an optimisation — it is where the app is.** OPFS `SyncAccessHandle`s are only
 * obtainable off the main thread, so `opfs-sahpool` can only be installed here; and the pool
 * permits one connection, so there is nowhere else for the database to be. Every read and
 * every write in the web build queues through this file.
 */

interface Glue {
  default(init: { module_or_path: string }): Promise<unknown>;
  /**
   * A directory and no filename: the folder holds `user.db` and `corpus.db`, and which is
   * which is the Rust side's business rather than this Worker's.
   */
  open(directory: string): Promise<string>;
  call(requestJson: string): string;
  ingest_cards(descriptorUrl: string, onProgress: (n: number) => void): Promise<string>;
  /**
   * The three optional bulk feeds, each a `#[wasm_bindgen]` entry beside `ingest_cards`
   * rather than a routed command — a refresh is `async` and makes a network call, and
   * `web::route` answers neither.
   *
   * **`onProgress` receives one JSON string, not a number.** It is an
   * `{ event, payload }` envelope, and the event *name* comes from Rust — where
   * `combos::PROGRESS_EVENT`, `Dataset::progress_event` and
   * `marketplace_feed::PROGRESS_EVENT` already live. A second table of those strings on
   * this side would be a place for them to drift, and the symptom would be a progress line
   * that never moves rather than an error.
   */
  ingest_combos(force: boolean, onProgress: (json: string) => void): Promise<string>;
  ingest_tags(
    dataset: string,
    force: boolean,
    onProgress: (json: string) => void,
  ): Promise<string>;
  ingest_prices(marketplace: string, onProgress: (json: string) => void): Promise<string>;
  /**
   * Ask GitHub what has been released — the one network entry point here that downloads
   * nothing and reports no progress.
   *
   * It answers the same `{ kind, result }` envelope the three feeds do, so `handle` resolves
   * it through the same `ok`/`err` pair on the same id. The `result` is `UpdateStatus`, which
   * is what `ipc.updateCheck` already resolves with on a desktop.
   */
  update_check(force: boolean): Promise<string>;
  close(): void;
}

let glue: Glue | undefined;

/**
 * Loaded by URL rather than imported, and `@vite-ignore` is what keeps it that way.
 *
 * `web/public/wasm/` is written by `scripts/build-wasm.mjs` and is **gitignored**. A static
 * import would put it in the module graph, and then `vite build` for the *desktop* bundle
 * would fail on a machine that has never run the wasm build — for a branch the desktop build
 * folds away as dead code anyway.
 *
 * **The specifier is a variable and not a literal, and that is load-bearing.** `tsc` resolves
 * a literal one even inside `import()`, so `/wasm/mtg_grimoire_lib.js` is `TS2307: Cannot
 * find module` on every machine that has not run the wasm build — and `npm run build` runs
 * `tsc` before Vite, so the *desktop* build breaks on a path only the web build reaches.
 * `@vite-ignore` handles the bundler; a variable is what handles the type checker.
 *
 * **And it is an absolute URL with an origin, which is not cosmetic — a root-relative one
 * does not work in the dev server at all.** Vite rewrites every dynamic import whose
 * specifier it cannot read statically into `__vite__injectQuery(spec, 'import')`, and
 * `@vite-ignore` does not opt out of that. `injectQuery` opens with
 * `if (url[0] !== "." && url[0] !== "/") return url`, so `/wasm/…` comes back as
 * `/wasm/…?import` — which Vite then refuses, because importing an asset out of `publicDir`
 * from JavaScript is not allowed. Measured 2026-08-28 against the real page: the boot screen
 * read "The card database would not open — TypeError: Failed to fetch dynamically imported
 * module: http://localhost:5173/wasm/mtg_grimoire_lib.js?import". Giving the URL an origin
 * takes the early return and the query is never appended.
 *
 * `{ module_or_path }` and not a bare argument: wasm-bindgen 0.2.127 deprecated the
 * positional form.
 */
const GLUE_URL = new URL("/wasm/mtg_grimoire_lib.js", self.location.origin).href;
const WASM_URL = new URL("/wasm/mtg_grimoire_lib_bg.wasm", self.location.origin).href;

/**
 * Run `make` at most once, **including for callers that arrive while the first one is still
 * awaiting**.
 *
 * The distinction is the whole point, and getting it wrong is what broke the first run.
 * A guard that reads a variable the work only sets at the *end* is not a guard at all in a
 * message loop: two `postMessage`s that land in the same turn both find it unset, and both
 * do the work. Memoising the promise is what makes the second caller wait for the first
 * rather than race it.
 */
export function once<T>(make: () => Promise<T>): () => Promise<T> {
  let started: Promise<T> | undefined;
  return () => (started ??= make());
}

/**
 * Load the glue and instantiate the wasm module. Once per Worker, and that is load-bearing.
 *
 * **Two concurrent calls used to make two `WebAssembly.Memory`s, and that is what killed
 * every failing first run.** `wasm-bindgen`'s own re-entry guard is `if (wasm !== undefined)
 * return wasm`, read synchronously on entry — and `wasm` is assigned only after the
 * instantiate resolves, so two overlapping calls both sail past it and both instantiate.
 * The glue then holds *one* `wasm` binding pointing at the second instance while every
 * callback the first one registered — each `JsFuture`'s `then`, every `Closure` — is still
 * dispatched through it. Those carry pointers into a linear memory that is no longer the one
 * being indexed.
 *
 * Measured 2026-08-28 in the Worker: `distinctMemories=2`, then
 * `Error: closure invoked recursively or after being dropped` about 40 ms later, then a
 * `dealloc` of a chunk that was never allocated — `panicked at dlmalloc.rs:1201:
 * assertion failed: psize >= size + min_overhead`, which is dlmalloc checking a free
 * against its own header rather than running out of anything. The trap took the Worker with
 * it and the page sat on a frozen card count. `<React.StrictMode>` is what sent the two
 * messages (it invokes `WebBoot`'s effect twice), but any two calls arriving before the
 * module has finished loading would do it.
 */
const load = once(async (): Promise<Glue> => {
  const mod = (await import(/* @vite-ignore */ GLUE_URL)) as Glue;
  await mod.default({ module_or_path: WASM_URL });
  glue = mod;
  return mod;
});

const send = (message: FromWorker) => self.postMessage(message);

/** The one `open`, memoised on the first call — the answer included. See `case "open"`. */
let opening: Promise<Opened> | undefined;
function open(wasm: Glue, directory: string): Promise<Opened> {
  return (opening ??= wasm.open(directory).then((json) => JSON.parse(json) as Opened));
}

self.addEventListener("message", (e: MessageEvent<ToWorker>) => {
  void handle(e.data);
});

async function handle(message: ToWorker): Promise<void> {
  try {
    const wasm = await load();
    switch (message.kind) {
      case "open": {
        // Memoised too, and this one is hygiene rather than a fix: removing it and letting
        // StrictMode's two effects each open the database was run as a mutation on
        // 2026-08-28 and **survived**, three clean first runs of three. `sqlite-wasm-vfs`
        // registers its pool by VFS name and hands the second caller the one already
        // registered, so a second open does not make a second pool. What it does make is a
        // second `Connection`, a second run of every migration, and a second build of the
        // facet index over all 117 606 rows — none of which a Worker that owns exactly one
        // database has any use for. One open, one answer, and the refusal is an answer.
        send({ kind: "opened", opened: await open(wasm, message.directory) });
        return;
      }
      case "call": {
        // `args` is omitted for a no-argument command, matching `core/tauri.ts`'s arity
        // rule; `wire::Request.args` carries a named serde default and reads an absent key
        // as `{}` — a named one rather than `#[serde(default)]`, which would give
        // `Value::Null`.
        const answer = JSON.parse(
          wasm.call(
            JSON.stringify({ id: message.id, command: message.command, args: message.args }),
          ),
        ) as FromWorker;
        send(answer);
        return;
      }
      case "ingest-cards": {
        const done = JSON.parse(
          await wasm.ingest_cards(message.descriptorUrl, (n: number) =>
            send({ kind: "event", event: CORPUS_PROGRESS, payload: { inserted: n } }),
          ),
        ) as { kind: string; inserted?: number; skipped?: number; message?: string };
        send(
          done.kind === "ok"
            ? { kind: "corpus-done", inserted: done.inserted ?? 0, skipped: done.skipped ?? 0 }
            : { kind: "corpus-failed", message: done.message ?? "the ingest failed" },
        );
        return;
      }
      case "feed-refresh": {
        // Progress arrives as the envelope Rust built and is forwarded verbatim, so it
        // reaches `core.listen("combos:progress", …)` on exactly the channel the desktop's
        // Tauri event uses. Nothing here knows which feed is running.
        const forward = (payload: string) => {
          const event = JSON.parse(payload) as { event: string; payload: unknown };
          send({ kind: "event", event: event.event, payload: event.payload });
        };
        const answer = JSON.parse(await runFeed(wasm, message, forward)) as
          | { kind: "ok"; result: unknown }
          | { kind: "err"; message: string };
        // **The ordinary `ok`/`err` pair, keyed on the id** — so `browser.ts` resolves it
        // through the same pending map every command uses, and a refresh that fails rejects
        // the mutation the panel is already watching.
        send(
          answer.kind === "ok"
            ? { kind: "ok", id: message.id, result: answer.result }
            : { kind: "err", id: message.id, message: answer.message },
        );
        return;
      }
      case "update-check": {
        // No progress channel: one request, one page of JSON, three `app_meta` rows. The
        // envelope and the id discipline are `feed-refresh`'s, so `useUpdate`'s
        // `.then(setStatus)` gets the `UpdateStatus` it gets on a desktop and its `.catch`
        // gets the rejection.
        const answer = JSON.parse(await runUpdateCheck(wasm, message)) as
          | { kind: "ok"; result: unknown }
          | { kind: "err"; message: string };
        send(
          answer.kind === "ok"
            ? { kind: "ok", id: message.id, result: answer.result }
            : { kind: "err", id: message.id, message: answer.message },
        );
        return;
      }
    }
  } catch (err) {
    // A wasm trap surfaces here and NOWHERE the page can read — probe 2 spent a run sitting
    // at "running…" for exactly this reason. Forwarding it by hand is the only way a failure
    // in the Worker becomes something a reader can be shown.
    const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
    if (
      message.kind === "call" ||
      message.kind === "feed-refresh" ||
      message.kind === "update-check"
    )
      send({ kind: "err", id: message.id, message: text });
    else if (message.kind === "open")
      send({ kind: "opened", opened: { kind: "failed", message: text } });
    else send({ kind: "corpus-failed", message: text });
  }
}

/**
 * One `feed-refresh` message onto the export it names.
 *
 * Exported so the suite can drive it without a Worker: the alternative is a test that stands
 * up `self.addEventListener`, and the branch worth pinning is which export a message reaches
 * with which arguments — a `force` dropped here is a Refresh button that does nothing for six
 * days out of seven, and nothing about that looks like a bug.
 */
export function runFeed(
  wasm: Glue,
  message: Extract<ToWorker, { kind: "feed-refresh" }>,
  onProgress: (json: string) => void,
): Promise<string> {
  switch (message.feed) {
    case "combos":
      return wasm.ingest_combos(message.force, onProgress);
    case "tags":
      return wasm.ingest_tags(message.dataset, message.force, onProgress);
    case "prices":
      return wasm.ingest_prices(message.marketplace, onProgress);
  }
}

/**
 * One `update-check` message onto the export it names — {@link runFeed}'s seam, for a
 * milder version of its reason.
 *
 * There is one export and one argument, so nothing here can reach the wrong function; what
 * it can do is drop the `force`. That is a Check now button that answers instantly with
 * yesterday's page for a day at a time, and nothing about that looks like a bug — the same
 * failure `runFeed`'s doc names, at one request out of sixty an hour rather than 27.5 MB.
 */
export function runUpdateCheck(
  wasm: Glue,
  message: Extract<ToWorker, { kind: "update-check" }>,
): Promise<string> {
  return wasm.update_check(message.force);
}

self.addEventListener("beforeunload", () => glue?.close());
