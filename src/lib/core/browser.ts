import { feedRefreshFor } from "@/workers/protocol";
import type { FromWorker, Opened, ToWorker } from "@/workers/protocol";
import type { Core } from "./types";

/**
 * The web implementation of {@link Core}: everything goes to the database Worker.
 *
 * **Ids and not order.** The Worker answers a slow search after a fast one that was sent
 * later, so each pending call is keyed by an id and resolved by that id alone. A queue
 * resolved by arrival would hand the wrong rows to the wrong caller, and the symptom would
 * be a page that is intermittently wrong rather than one that is broken.
 */
export interface BrowserCore extends Core {
  /**
   * Install the OPFS pool and open the databases. Once, before anything else.
   *
   * **A directory and no filename.** The folder holds `user.db` and `corpus.db`; the Rust
   * side opens the pair from fixed names, so naming one here would be a second opinion
   * about which is which.
   *
   * **Not a method on {@link Core}**, because two of the three implementations have no
   * answer for it: a Tauri build's database is already open by the time the page exists.
   */
  open(directory: string): Promise<Opened>;
  /** Download and ingest Scryfall's bulk file. `onProgress` gets the running insert count. */
  buildCorpus(descriptorUrl: string, onProgress: (inserted: number) => void): Promise<void>;
  /** Testing seam: how many Workers this core has spawned. Always 0 or 1. */
  readonly spawned: () => number;
}

type Pending = { resolve: (value: never) => void; reject: (reason: Error) => void };

/**
 * `spawn` is a factory rather than a Worker so that nothing is created until something is
 * asked for — the Tauri build imports this module and folds the branch away, and a Worker
 * spawned at import time would be spawned there too.
 */
export function createBrowserCore(spawn: () => Worker): BrowserCore {
  let worker: Worker | undefined;
  let nextId = 1;
  let spawnCount = 0;
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<(payload: never) => void>>();
  let opening: ((opened: Opened) => void) | undefined;
  let corpus: { done: () => void; failed: (e: Error) => void } | undefined;
  let corpusProgress: ((inserted: number) => void) | undefined;

  function ensure(): Worker {
    if (!worker) {
      spawnCount += 1;
      worker = spawn();
      worker.addEventListener("message", (e: MessageEvent<FromWorker>) => receive(e.data));
    }
    return worker;
  }

  function receive(message: FromWorker) {
    switch (message.kind) {
      case "ok": {
        pending.get(message.id)?.resolve(message.result as never);
        pending.delete(message.id);
        return;
      }
      case "err": {
        pending.get(message.id)?.reject(new Error(message.message));
        pending.delete(message.id);
        return;
      }
      case "event": {
        if (message.event === "corpus-progress") {
          corpusProgress?.((message.payload as { inserted: number }).inserted);
        }
        for (const fn of listeners.get(message.event) ?? []) fn(message.payload as never);
        return;
      }
      case "opened": {
        opening?.(message.opened);
        opening = undefined;
        return;
      }
      case "corpus-done": {
        corpus?.done();
        corpus = undefined;
        return;
      }
      case "corpus-failed": {
        corpus?.failed(new Error(message.message));
        corpus = undefined;
        return;
      }
    }
  }

  const post = (message: ToWorker) => ensure().postMessage(message);

  return {
    call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      const id = nextId++;
      const answer = new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: never) => void, reject });
      });
      // **Four command names are a download rather than a query, and they are diverted
      // here.** `web::route::COMMANDS` is synchronous, takes the connection and makes no
      // network call, so each refresh is a `#[wasm_bindgen]` entry instead — and the branch
      // belongs in this one place rather than in every Settings panel. The answer still
      // comes back as `ok`/`err` on this id, so the promise, the rejection and the progress
      // events are the ones every other call already gets.
      const feed = feedRefreshFor(command, args);
      if (feed !== undefined) {
        post({ kind: "feed-refresh", id, ...feed });
        return answer;
      }
      // `args` omitted rather than sent as `undefined`, mirroring `core/tauri.ts`: the
      // key's absence is what `wire::Request`'s `#[serde(default)]` reads as `{}`.
      post(
        args === undefined ? { kind: "call", id, command } : { kind: "call", id, command, args },
      );
      return answer;
    },

    listen<T>(event: string, handler: (payload: T) => void): () => void {
      // Synchronous, because a React cleanup cannot await and a component can unmount
      // before anything has finished subscribing. There is nothing async to wait for here
      // anyway — the Worker does not acknowledge a subscription.
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const fn = handler as (payload: never) => void;
      set.add(fn);
      ensure();
      return () => {
        set.delete(fn);
        if (set.size === 0) listeners.delete(event);
      };
    },

    open(directory: string): Promise<Opened> {
      return new Promise<Opened>((resolve) => {
        opening = resolve;
        post({ kind: "open", directory });
      });
    },

    buildCorpus(descriptorUrl: string, onProgress: (inserted: number) => void): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        corpusProgress = onProgress;
        corpus = { done: resolve, failed: reject };
        post({ kind: "ingest-cards", descriptorUrl });
      });
    },

    spawned: () => spawnCount,
  };
}

/**
 * The one this build uses. The `new Worker(new URL(…))` form is what Vite recognises, and it
 * only runs when something first calls or listens.
 */
export const browserCore: BrowserCore = createBrowserCore(
  () => new Worker(new URL("../../workers/db.ts", import.meta.url), { type: "module" }),
);
