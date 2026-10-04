import type { StartupStatus } from "@/lib/ipc";
import { STARTUP_CHANGED, STARTUP_COMMAND } from "../deferred";
import { STORAGE_CLEARED, STORAGE_CLEARED_DISMISS, STORAGE_PERSISTENCE } from "../hostStorage";
import type { CallArgs, CallOptions, Core } from "../types";
import {
  callMessage,
  type FromWorker,
  type Opening,
  type Outgoing,
  type ToWorker,
} from "./protocol";
import {
  CLEARED_LINE,
  dismissCleared,
  forgiving,
  noteOpened,
  persistenceLine,
  readCleared,
  readPersistence,
  settlePersistence,
  type KeyStore,
  type PersistManager,
} from "./storage";

/**
 * The OPFS folder the databases live in. A bare name and not a path: the pool *is* the
 * filesystem. A directory and no file, because the engine opens `user.db` and `corpus.db` from
 * fixed names and a filename here would be a second opinion about which is which.
 */
export const OPFS_DIRECTORY = "mtg-grimoire";

/**
 * What a second tab is told. `opfs-sahpool` holds exclusive access handles, so one tab of an
 * origin has the database and the next is refused; spec §6 settles what to do about it — the
 * first tab wins and the second says so. The reader did nothing wrong, so it is a sentence and a
 * way out, never a code: reloading is the only way to find out whether the other tab has closed.
 */
export const ALREADY_OPEN =
  "MTG Grimoire is already open in another tab of this browser. Close that tab, then reload this one.";

/** What the reader is told when there was no engine to open anything with. */
const unloaded = (detail: string): string =>
  `MTG Grimoire could not load its card engine. Check your connection, then reload.\n\n${detail}`;

/** What the reader is told when the Worker died, with whatever it said on the way. */
const stopped = (detail: string | undefined): string =>
  detail
    ? `MTG Grimoire's card engine stopped. Reload to start it again.\n\n${detail}`
    : "MTG Grimoire's card engine stopped. Reload to start it again.";

/** One line for the console when the database opens: which journal each file got, and its rung. */
export const openedLine = (opened: Extract<Opening, { kind: "ready" }>): string =>
  `MTG Grimoire: database open in OPFS — journal ${opened.journal}, corpus journal ` +
  `${opened.corpusJournal}, schema ${opened.schemaVersion}`;

/** The open's outcome, as the gate reads one. */
function statusOf(opened: Opening): StartupStatus {
  switch (opened.kind) {
    case "ready":
      return { state: "ready" };
    case "already-open":
      return { state: "failed", message: ALREADY_OPEN, reload: true };
    case "unloaded":
      return { state: "failed", message: unloaded(opened.message), reload: true };
    case "failed":
      // The engine's own sentence, and no reload offered: a database that would not open will
      // not open the second time either.
      return { state: "failed", message: opened.message };
  }
}

/**
 * As much of a `Worker` as this needs — which is what lets the suite hand it a fake one. The
 * real one is assignable to it.
 */
export interface WorkerPort {
  postMessage(message: ToWorker, transfer: ArrayBuffer[]): void;
  addEventListener(type: "message", listener: (event: { data: FromWorker }) => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
}

/**
 * What the page's half asks of the browser itself, apart from the Worker — handed in so the
 * suite gives it a store and a clock of its own. `store` and `storage` are each absent in a
 * browser that has none, and neither may be a reason the database does not open.
 */
export interface Browser {
  /** `localStorage`: where the host's own records about storage are kept (`storage.ts`). */
  store?: KeyStore;
  /** `navigator.storage`: who is asked to keep this origin's data. */
  storage?: PersistManager;
  /** Unix milliseconds. */
  now: () => number;
}

/**
 * The page's own. **Each global is reached inside a `try`**: naming `localStorage` throws in a
 * profile that blocks site data, and this runs on the way to opening the database.
 */
function pageBrowser(): Browser {
  const reach = <T>(get: () => T): T | undefined => {
    try {
      return get();
    } catch {
      return undefined;
    }
  };
  return {
    store: reach(() => globalThis.localStorage),
    storage: reach(() => globalThis.navigator.storage),
    now: () => Date.now(),
  };
}

interface Pending {
  resolve: (value: unknown) => void;
  /** Rejected with the engine's sentence as a bare string — what a Tauri `invoke` rejects with. */
  reject: (message: string) => void;
}

/**
 * **The web host's `Core`: every command to the database Worker** (the light-app spec §3.5).
 *
 * - **One Worker, made on the first use and never again.** `spawn` is a factory so that nothing
 *   is created at import; the first call or subscription makes the Worker and asks it to open the
 *   database, and every later one finds both done. The page asks once however many times React
 *   mounts the gate — StrictMode runs its effect twice, and a face crossing mounts a new face's
 *   worth of queries — which is the page's half of the rule `engine.ts` states for the Worker.
 * - **Ids and not order.** The Worker answers a slow search after a fast one sent later, so a
 *   pending call is kept by its id and settled by that alone.
 * - **A call made before the database is open waits; it is not refused.** Calls are held here
 *   until the Worker says `opened` and sent in the order they were made. A database that did not
 *   open rejects them with the reason.
 * - **The startup gate is answered here**, from the open's outcome, without reaching the engine:
 *   `startup_status` is `loading` until the Worker reports, and `startup:changed` is emitted when
 *   it does — the two things the Android host answers in Rust (`mobile/src-tauri/src/startup.rs`),
 *   so `boot/useStartup.ts` is one gate on every host. **One thing this host says that no other
 *   does**: a Worker that dies after the database opened moves the status from `ready` to
 *   `failed`, once, with a reload (`crashed`) — the app is over until a new document, and the
 *   gate is where a whole window is told so.
 * - **A rejection is the engine's sentence as a string**, because that is what a Tauri command
 *   rejects with and the pages above read one (`ipcError`).
 * - **What the browser did with its storage is answered here too**, without the engine
 *   (`../hostStorage.ts` has the three commands). The moment the database opens this settles
 *   whether the browser is keeping it — asking where it has not said yes, no more than once a
 *   week — and every open, a failed one too, notes whether it found a database this browser had
 *   held gone. Both are said on the console beside the open's own line, and both are read back
 *   by a page through a command only this host answers, so the page never has to know it is in
 *   a browser to ask.
 * - **One subscriber's throw is that subscriber's alone.** Tauri calls each registration by
 *   itself; here one message fans out to every handler of the name in a loop, so a throw left to
 *   climb would take the event from every handler behind it — and the sync's `done` reaches the
 *   ribbon, the invalidation and the first-run screen through one `sync:progress`.
 */
export function createWebCore(
  spawn: () => WorkerPort,
  directory: string = OPFS_DIRECTORY,
  browser: Browser = pageBrowser(),
): Core {
  let started = false;
  let worker: WorkerPort | undefined;
  let status: StartupStatus = { state: "loading" };
  let nextId = 1;
  const pending = new Map<number, Pending>();
  /** Calls made while the database is opening, in the order they were made. */
  let held: Outgoing[] = [];
  /** Set once the Worker has died: what every later call is refused with. */
  let dead: string | undefined;
  const listeners = new Map<string, Set<(payload: never) => void>>();
  const store = forgiving(browser.store);
  /** Whether the first word about the open has been noted (`openedIn`). */
  let noted = false;
  /** This launch's look at persistence, once the database has opened. Unset where it never did. */
  let persistence: Promise<void> | undefined;
  /** Resolved when the gate leaves `loading`: what this host's own answers about storage wait on. */
  let settled!: () => void;
  const whenSettled = new Promise<void>((resolve) => (settled = resolve));

  const emit = (event: string, payload: unknown): void => {
    // A copy: a handler may unsubscribe itself, and the gate's does.
    for (const handler of [...(listeners.get(event) ?? [])]) {
      try {
        handler(payload as never);
      } catch (error) {
        console.error(`A subscriber to ${event} threw.`, error);
      }
    }
  };

  /**
   * Post one message. A post can throw — an argument that will not clone, a buffer its caller
   * detached while the call was held — and that is that call's failure alone: thrown out of the
   * flush of held calls, it would strand every call behind it and keep the gate from hearing.
   */
  const send = ({ message, transfer }: Outgoing): void => {
    try {
      worker?.postMessage(message, transfer);
    } catch (error) {
      if (message.kind !== "call") throw error;
      pending.get(message.id)?.reject(error instanceof Error ? error.message : String(error));
      pending.delete(message.id);
    }
  };

  const rejectAll = (message: string): void => {
    for (const call of pending.values()) call.reject(message);
    pending.clear();
  };

  /**
   * Leave `loading`, once. **The state never moves back** — not to `loading`, not to `ready` —
   * as on every other host; the one later move there is, `ready` to `failed` when the engine
   * dies, is {@link crashed}'s.
   */
  function settle(next: StartupStatus): void {
    if (status.state !== "loading" || next.state === "loading") return;
    status = next;
    const waiting = held;
    held = [];
    if (next.state === "ready") waiting.forEach(send);
    else if (next.state === "failed") rejectAll(next.message);
    settled();
    emit(STARTUP_CHANGED, next);
  }

  /**
   * What the first word about the open means for the browser's storage — once per page,
   * whatever the Worker repeats.
   *
   * **Whether the old database was found gone is noted for every open, one that failed
   * included** (`noteOpened` has the sequence that needs it: the open after a clearing creates
   * the folder and then fails, and the launch after that looks ordinary). **Synchronous, and
   * ahead of the gate**, so `storage_cleared`'s answer is settled before a page can ask.
   *
   * **Persistence is settled only for a database that opened** — there is nothing to keep
   * otherwise. It is the browser's own time: started here and waited for by nobody but the
   * command that reads the record back, and never past the point where a reader would have to
   * answer a prompt (`settlePersistence`).
   */
  function openedIn(existed: boolean | null, ready: boolean): void {
    if (noted) return;
    noted = true;
    if (noteOpened(store, existed, browser.now(), ready)) {
      console.warn(
        ready
          ? `${CLEARED_LINE} — a new, empty one was created`
          : `${CLEARED_LINE} — and a new one could not be opened`,
      );
    }
    if (!ready) return;
    persistence = settlePersistence(browser.storage, store, browser.now()).then(
      ({ record, from, answered }) => {
        // A fresh ask is said when the browser answers it, which for one that prompts is when
        // the reader does; everything else is known now.
        if (answered) {
          void answered.then((answer) => console.info(persistenceLine(answer, "asked")));
        } else {
          console.info(persistenceLine(record, from));
        }
      },
      // `settlePersistence` has no path that rejects; this is so that one found later costs
      // nothing on the way to opening a collection — least of all an unhandled rejection.
      () => undefined,
    );
  }

  /**
   * The commands this host answers itself, about the browser's storage. Each waits for the gate
   * to leave `loading`, because what an open found is half of every answer here.
   */
  function own(command: string): (() => unknown) | undefined {
    switch (command) {
      case STORAGE_CLEARED:
        return () => readCleared(store);
      case STORAGE_CLEARED_DISMISS:
        return () => {
          dismissCleared(store);
          return null;
        };
      case STORAGE_PERSISTENCE:
        // The record as it stands, once this launch has looked — never the browser's answer to
        // a fresh ask, which may be waiting on a reader. A host that never opened looked at
        // nothing: what an earlier launch recorded.
        return () => (persistence ?? Promise.resolve()).then(() => readPersistence(store));
      default:
        return undefined;
    }
  }

  function receive(message: FromWorker): void {
    switch (message.kind) {
      case "opened":
        if (message.opened.kind === "ready") {
          // The journal each file actually got, said where a bug report can carry it. The OPFS
          // pool refuses WAL, so `delete` is the expected answer and anything else is news.
          console.info(openedLine(message.opened));
        }
        openedIn(message.existed, message.opened.kind === "ready");
        return settle(statusOf(message.opened));
      case "ok":
        pending.get(message.id)?.resolve(message.result);
        pending.delete(message.id);
        return;
      case "err":
        pending.get(message.id)?.reject(message.message);
        pending.delete(message.id);
        return;
      case "event":
        return emit(message.event, message.payload);
    }
  }

  /**
   * The Worker's own `error`: its script never loaded, or something in it threw where no call
   * was waiting to catch it — a trap inside the engine's own task queue is that. It names no
   * call, so every call in flight is rejected with it: an answer that is never coming must not
   * be waited for.
   *
   * **And every later call is refused too.** A trap leaves the module's memory in whatever state
   * it was in, and its task queue may never run again — so a call sent after one can go
   * unanswered with no second `error` to say so, or be answered from a heap nobody should write
   * a collection through.
   *
   * **So the gate is told, even after it opened: `ready` moves to `failed`, with a reload, exactly
   * once.** Until a reload there is no app behind this page, and that is one fact about the whole
   * window — left for each page to find out by itself, it was a first-run bar that never moved
   * again (`useSync` keeps the last `syncing` it heard when a poll is refused), walls that
   * stopped answering, and the sentence shown only wherever a query happened to draw its error.
   * `startup:changed` says it once and the light app draws its boot screen in place of the faces,
   * with the way out. It is the one move this state makes after leaving `loading`, it is this
   * host's alone — a desktop's or a phone's engine cannot stop while its window lives — and it is
   * never a move *back*: nothing returns to `ready`, and only a new document opens a database.
   *
   * **Only from `loading` or `ready`.** A gate already `failed` — a second tab, a database that
   * would not open — keeps its own sentence: that is why there is no app, and a Worker that then
   * also errors has nothing to add. **And only the first time**: a dead engine can go on raising
   * `error`, and each one after the first changes nothing and says nothing.
   */
  function crashed(detail: string | undefined): void {
    if (dead !== undefined) return;
    dead = stopped(detail);
    const next: StartupStatus = { state: "failed", message: dead, reload: true };
    if (status.state === "loading") {
      settle(next);
    } else if (status.state === "ready") {
      status = next;
      // The gate before the calls: it takes the pages down, and what the rejections below would
      // have drawn in them is this same sentence, a query at a time.
      emit(STARTUP_CHANGED, next);
    }
    rejectAll(dead);
  }

  function start(): void {
    if (started) return;
    started = true;
    try {
      worker = spawn();
      worker.addEventListener("message", (event) => receive(event.data));
      worker.addEventListener("error", (event) => crashed(event.message));
      worker.postMessage({ kind: "open", directory }, []);
    } catch (error) {
      // No Worker at all — a browser without module workers, or a policy that refuses one.
      crashed(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    call<T>(command: string, args?: CallArgs, options?: CallOptions): Promise<T> {
      start();
      if (command === STARTUP_COMMAND) return Promise.resolve(status as T);
      // Ahead of the two refusals below: these are about the browser and not the engine, and a
      // notice that the storage was cleared is still true of a page whose engine then stopped.
      const answer = own(command);
      if (answer) return whenSettled.then(answer) as Promise<T>;
      if (dead !== undefined) return Promise.reject(dead);
      if (status.state === "failed") return Promise.reject(status.message);

      const id = nextId++;
      const outgoing = callMessage(id, command, args, options);
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        if (status.state === "ready") send(outgoing);
        else held.push(outgoing);
      });
    },

    listen<T>(event: string, handler: (payload: T) => void): () => void {
      // Synchronous, and there is nothing to wait for: the Worker forwards every event and
      // acknowledges no subscription.
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const registered = set;
      const entry = handler as (payload: never) => void;
      registered.add(entry);
      start();
      return () => {
        registered.delete(entry);
        if (registered.size === 0 && listeners.get(event) === registered) listeners.delete(event);
      };
    },
  };
}

/**
 * The page's one. **A module singleton**, so there is one Worker per page whatever mounts or
 * unmounts above it; the `new Worker(new URL(…))` form is the one Vite bundles a Worker from, and
 * it runs only when something first calls or listens.
 *
 * **This file is reached by a dynamic import in a web build and by nothing in any other**
 * (`../index.ts`) — which is what keeps the Worker's chunk out of the desktop's `dist/` and the
 * Android app's `dist-mobile/`. Vite emits a Worker for every file it transforms that spells one.
 */
export const webCore: Core = createWebCore(
  () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
);
