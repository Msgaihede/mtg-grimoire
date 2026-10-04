import type { CallArgs, CallOptions } from "../types";

/**
 * **What crosses `postMessage` between the page and the database Worker** — the web host's wire
 * (the light-app spec §6), hand-written like every mirror in `src/lib/ipc.ts` and for its reason:
 * nothing generates it, so a renamed `kind` is an `undefined` on the far side rather than a type
 * error. `protocol.test.ts` pins the strings.
 *
 * **A plain module, and both programs read it.** The page's half (`./index.ts`) is checked by the
 * root `tsc` program with the DOM lib; the Worker's (`./worker.ts`, `./engine.ts`) by
 * `tsconfig.web-worker.json` with the `WebWorker` lib. So nothing here may name a global only one
 * of the two has.
 */

/**
 * What the engine's `open` answers, as JSON text — `crates/grimoire-web`'s shape, mirrored.
 *
 * **Two journals, because the data folder is two files.** Both read `delete` on the OPFS pool —
 * its VFS refuses WAL — and they are reported rather than assumed. `schemaVersion` is the user
 * file's.
 */
export type Opened =
  | { kind: "ready"; journal: string; corpusJournal: string; schemaVersion: number }
  /** Another tab of this origin holds the database. Not a fault: the first tab wins. */
  | { kind: "already-open" }
  | { kind: "failed"; message: string };

/**
 * What the Worker reports about the open: the engine's own answer, or **`unloaded`** — there was
 * no engine to ask, because the module never arrived or would not instantiate. Kept apart from
 * `failed` because the cure differs: a module that did not load is a reload away, and a database
 * that would not open is not.
 */
export type Opening = Opened | { kind: "unloaded"; message: string };

/** Page → Worker. */
export type ToWorker =
  /** A directory and no file: the folder holds `user.db` and `corpus.db`, and the engine names them. */
  | { kind: "open"; directory: string }
  /**
   * One command of the engine's table. `args` is **absent** for a call made with none, and the
   * Worker spells that `"null"` to the engine. `body` is a byte payload, transferred rather than
   * copied, whose headers ride as `args` — `table.ts`'s convention for the same call.
   */
  | {
      kind: "call";
      id: number;
      command: string;
      args?: Record<string, unknown>;
      body?: Uint8Array;
    };

/** Worker → page. */
export type FromWorker =
  | { kind: "opened"; opened: Opening }
  /** An answer, **matched by `id` and never by arrival**: a slow search is overtaken by a fast one. */
  | { kind: "ok"; id: number; result: unknown }
  | { kind: "err"; id: number; message: string }
  /** An engine event, its payload already parsed. */
  | { kind: "event"; event: string; payload: unknown };

/** A message and what it hands over rather than copies. */
export interface Outgoing {
  message: ToWorker;
  transfer: ArrayBuffer[];
}

/**
 * The `call` a page-side `Core.call` becomes.
 *
 * **Bytes are transferred**, so a camera frame crosses without a copy — and the caller's array is
 * emptied by it, which is what a transfer means. **Only an array that is the whole of its
 * buffer**: a transfer hands over the buffer and not the view, so a `subarray` would take every
 * other view of that memory with it. Such a view, and one over memory that cannot be handed over
 * at all (a shared buffer), is copied, and the copy is what crosses.
 */
export function callMessage(
  id: number,
  command: string,
  args?: CallArgs,
  options?: CallOptions,
): Outgoing {
  if (args instanceof Uint8Array) {
    const { buffer } = args;
    const whole = buffer instanceof ArrayBuffer && args.byteLength === buffer.byteLength;
    const body = whole ? args : args.slice();
    return {
      message: { kind: "call", id, command, args: options?.headers ?? {}, body },
      transfer: [body.buffer as ArrayBuffer],
    };
  }
  return {
    message:
      args === undefined ? { kind: "call", id, command } : { kind: "call", id, command, args },
    transfer: [],
  };
}

/** A call's arguments as the JSON text the engine reads: `"null"` when the page sent none. */
export function argsText(args: Record<string, unknown> | undefined): string {
  return args === undefined ? "null" : JSON.stringify(args);
}

/**
 * The engine's answer to a call — `{"ok": value}` or `{"err": "message"}` as text — as the message
 * the page is sent. Anything else is an `err` that says so: an answer nobody can read must still
 * settle the call it belongs to.
 */
export function answerOf(id: number, text: string): FromWorker {
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    return { kind: "err", id, message: `The card engine answered something unreadable: ${text}` };
  }
  if (typeof answer === "object" && answer !== null) {
    if ("err" in answer) return { kind: "err", id, message: String(answer.err) };
    if ("ok" in answer) return { kind: "ok", id, result: answer.ok };
  }
  return { kind: "err", id, message: `The card engine answered something unreadable: ${text}` };
}

/** The engine's answer to `open`, read from its JSON text. An unreadable one is a failure. */
export function openedOf(text: string): Opened {
  let opened: unknown;
  try {
    opened = JSON.parse(text);
  } catch {
    return { kind: "failed", message: `The card engine answered something unreadable: ${text}` };
  }
  if (typeof opened === "object" && opened !== null && "kind" in opened) {
    const { kind } = opened;
    if (kind === "ready" || kind === "already-open" || kind === "failed") return opened as Opened;
  }
  return { kind: "failed", message: `The card engine answered something unreadable: ${text}` };
}

/** An error as one line a reader can be shown: a wasm trap is a `RuntimeError` with a short message. */
export function readable(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
