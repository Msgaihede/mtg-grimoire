import type * as GlueModule from "./grimoire_web";
import type { FromWorker, Opening, ToWorker } from "./protocol";
import { answerOf, argsText, openedOf, readable } from "./protocol";

/**
 * **Everything the database Worker decides**, with the Worker itself left out: what loads the
 * module and what posts a message are handed in, so the suite drives this file with neither a
 * Worker nor a wasm module (`engine.test.ts`). `worker.ts` is the two handed in.
 */

/** The engine's four calls — the module's exports, less its initialiser. */
export type Glue = Pick<typeof GlueModule, "open" | "call" | "listen" | "scanner_labels">;

/**
 * Run `make` at most once, **including for callers that arrive while the first is still
 * awaiting**.
 *
 * A guard that reads a variable the work only sets at the *end* is no guard in a message loop:
 * two messages landing in one turn both find it unset, and both do the work. Memoising the
 * promise is what makes the second caller wait for the first rather than race it.
 */
export function once<T>(make: () => Promise<T>): () => Promise<T> {
  let started: Promise<T> | undefined;
  return () => (started ??= make());
}

/** What a call made to a Worker nobody has asked to open is refused with. */
export const NOT_OPENED = "The card database has not been opened.";

export interface Engine {
  /** Answer one message from the page. Never rejects: every outcome is a message back. */
  handle(message: ToWorker): Promise<void>;
}

/**
 * The Worker's engine: the module loaded once, the database opened once, and every call answered
 * by its id.
 *
 * **The module is instantiated once per Worker, and that is load-bearing.** wasm-bindgen's own
 * re-entry guard is `if (wasm !== undefined) return wasm`, read on entry — and `wasm` is assigned
 * only after the instantiate resolves, so two overlapping loads both pass it and both instantiate.
 * The glue then holds one binding, to the second instance, while every callback the first one
 * registered still runs through it with pointers into a memory that is no longer the one indexed.
 * Round one of this host measured exactly that (2026-08-28): two `WebAssembly.Memory`s, `closure
 * invoked recursively or after being dropped`, a `dlmalloc` assertion, and a first run that failed
 * two times in three. React's StrictMode sent the two messages then; any two that arrive before
 * the module has loaded would do it.
 *
 * **The database is opened once too, and a second `open` is answered with what the first was.**
 * The pool is registered by name and a second registration would be handed the first, so this is
 * hygiene rather than a fix — what a second open would make is a second connection, a second run
 * of every migration and a second build of the facet index, on a host that permits one connection.
 *
 * **Whether the database's folder was already there is asked before the open, and once.** `held`
 * answers it — `worker.ts` hands in the one that looks in OPFS — and the answer rides back on
 * `opened`. Before, because the open is what creates the folder: asked afterwards, every launch
 * would find one. It is how the page tells storage a browser cleared from a first run
 * (`storage.ts`); a browser that cannot be asked, or an ask that throws, is `null`, and never a
 * reason not to open.
 */
export function createEngine(
  load: () => Promise<Glue>,
  post: (message: FromWorker) => void,
  held: (directory: string) => Promise<boolean | null> = () => Promise.resolve(null),
): Engine {
  const loaded = once(async () => {
    const glue = await load();
    // One sink for the engine's life. A payload that is not JSON is the engine's bug, and is
    // dropped rather than handed to a subscriber as text it would read as an object.
    glue.listen((event, payload) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        console.error(`The card engine emitted ${event} with a payload that is not JSON.`);
        return;
      }
      post({ kind: "event", event, payload: parsed });
    });
    return glue;
  });

  /** What one open found: the engine's answer, and whether the folder was there beforehand. */
  interface Asked {
    opened: Opening;
    existed: boolean | null;
  }

  let opening: Promise<Asked> | undefined;

  /** The one open, memoised on the first ask — its answer included, a refusal too. */
  const open = (directory: string): Promise<Asked> =>
    (opening ??= (async (): Promise<Asked> => {
      // Beside the module's load rather than after it — neither waits on the other — and both
      // are done before `glue.open` runs, which is the only order that matters.
      const [existed, glue] = await Promise.all([
        Promise.resolve()
          .then(() => held(directory))
          .catch(() => null),
        loaded().then(
          (module) => ({ module }),
          (error: unknown) => ({ unloaded: readable(error) }),
        ),
      ]);
      if ("unloaded" in glue) {
        return { opened: { kind: "unloaded", message: glue.unloaded }, existed };
      }
      const opened = await glue.module.open(directory).then(
        openedOf,
        // `open` answers its refusals as JSON, so a rejection is the glue's own throw.
        (error: unknown): Opening => ({ kind: "failed", message: readable(error) }),
      );
      return { opened, existed };
    })());

  async function call(message: Extract<ToWorker, { kind: "call" }>): Promise<void> {
    const { id } = message;
    try {
      // The page holds its calls until it hears `opened`, so one that arrives early is asked of
      // an open already under way and waits for it. Refused only where nobody ever asked.
      if (opening === undefined) return post({ kind: "err", id, message: NOT_OPENED });
      const { opened } = await opening;
      if (opened.kind !== "ready") {
        const why = opened.kind === "already-open" ? NOT_OPENED : opened.message;
        return post({ kind: "err", id, message: why });
      }
      const glue = await loaded();
      post(answerOf(id, await glue.call(message.command, argsText(message.args), message.body)));
    } catch (error) {
      // What the glue throws *synchronously* — an argument it will not marshal, a module that
      // never loaded — and nothing else. **A trap inside the engine does not arrive here**: the
      // call's promise is driven from a microtask, a trap there is an uncaught error in the
      // Worker, and the promise never settles. The page hears that one as the Worker's own
      // `error` event, and its core rejects everything in flight (`index.ts`'s `crashed`).
      post({ kind: "err", id, message: readable(error) });
    }
  }

  /**
   * The labels for the scanner's Worker. **Refused exactly as a call is** — before an open, and
   * for a database that did not open — and otherwise the engine's bytes, which may be none: an
   * empty corpus is an answer, and the scanner then names nothing and says so.
   */
  async function labels(id: number): Promise<void> {
    try {
      if (opening === undefined) return post({ kind: "err", id, message: NOT_OPENED });
      const { opened } = await opening;
      if (opened.kind !== "ready") {
        const why = opened.kind === "already-open" ? NOT_OPENED : opened.message;
        return post({ kind: "err", id, message: why });
      }
      const glue = await loaded();
      post({ kind: "labels", id, bytes: await glue.scanner_labels() });
    } catch (error) {
      post({ kind: "err", id, message: readable(error) });
    }
  }

  return {
    handle(message: ToWorker): Promise<void> {
      switch (message.kind) {
        case "open":
          return open(message.directory).then(({ opened, existed }) =>
            post({ kind: "opened", opened, existed }),
          );
        case "call":
          return call(message);
        case "labels":
          return labels(message.id);
      }
    },
  };
}
