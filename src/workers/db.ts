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
 * `{ module_or_path }` and not a bare argument: wasm-bindgen 0.2.127 deprecated the
 * positional form.
 */
const GLUE_URL = "/wasm/mtg_grimoire_lib.js";

async function load(): Promise<Glue> {
  if (!glue) {
    const mod = (await import(/* @vite-ignore */ GLUE_URL)) as Glue;
    await mod.default({ module_or_path: "/wasm/mtg_grimoire_lib_bg.wasm" });
    glue = mod;
  }
  return glue;
}

const send = (message: FromWorker) => self.postMessage(message);

self.addEventListener("message", (e: MessageEvent<ToWorker>) => {
  void handle(e.data);
});

async function handle(message: ToWorker): Promise<void> {
  try {
    const wasm = await load();
    switch (message.kind) {
      case "open": {
        const opened = JSON.parse(await wasm.open(message.directory)) as Opened;
        send({ kind: "opened", opened });
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
    }
  } catch (err) {
    // A wasm trap surfaces here and NOWHERE the page can read — probe 2 spent a run sitting
    // at "running…" for exactly this reason. Forwarding it by hand is the only way a failure
    // in the Worker becomes something a reader can be shown.
    const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
    if (message.kind === "call") send({ kind: "err", id: message.id, message: text });
    else if (message.kind === "open")
      send({ kind: "opened", opened: { kind: "failed", message: text } });
    else send({ kind: "corpus-failed", message: text });
  }
}

self.addEventListener("beforeunload", () => glue?.close());
