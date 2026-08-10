/**
 * The fake `invoke`, aliased over `@tauri-apps/api/core` for Storybook only.
 *
 * It sits *under* `src/lib/ipc.ts` rather than replacing it, so every story exercises the
 * hand-written Rust mirror as well as the component. `ipc.ts` is the file that can drift
 * silently from `#[serde(rename_all = "camelCase")]` structs — a renamed field becomes an
 * `undefined` the compiler is happy with — and a fake that replaced it would prove nothing
 * about it. The argument names are the half that only a dispatcher can check: `invoke`
 * matches them by name, so a typo here is a runtime rejection exactly as it is in the app.
 *
 * Handlers are registered rather than imported so this module stays a dispatcher with no
 * knowledge of the data — `db.ts` owns that, and a story's seed swaps it wholesale.
 *
 * **The table it dispatches into belongs to a story, not to this module.** `scope.ts` owns
 * the pointer and the four ways it is kept right; read its header before changing anything
 * here.
 */
import { activateScope, activeScope, createScope, resetScopes } from "./scope";
import type { CommandTable } from "./scope";

export type { CommandHandler, CommandTable } from "./scope";

/** Merge into the active scope's table, not replace it: a story adds a command or overrides
 *  one without restating the rest. */
export function registerCommands(next: CommandTable): void {
  const scope = activeScope();
  scope.commands = { ...scope.commands, ...next };
}

/** Drop every handler, and every world. `core.test.ts`'s `beforeEach`; `installWorld` builds
 *  a fresh scope instead, which is the same guarantee without reaching across stories. */
export function resetCommands(): void {
  resetScopes();
}

/** A world with these commands and no listeners, ready to be pointed at. */
export function commandScope(commands: CommandTable) {
  return createScope(commands);
}

/**
 * Rejects with an `Error`, which is what the *IPC layer* throws. A Rust command's own
 * refusal is a bare string — all 30 `#[tauri::command]` functions return
 * `Result<_, String>` — and a handler models that by throwing an `Error` whose message is
 * the string, because `ipcError` renders both (`typeof e === "string"` and
 * `e instanceof Error` are its first two branches) and the distinction is invisible past it.
 *
 * **The scope is read once, before the first `await`, and re-pointed at on the way out.**
 * Reading it once is what stops a story's call being answered from a world that became
 * active while its handler was in flight. Re-pointing is the other half, and it is for the
 * caller rather than for us: `useSync.ts:130` schedules its next poll in the continuation
 * *after* `await ipc.syncStatus()`, and a continuation runs as a microtask with whatever the
 * pointer says then. Setting it here lands it before that microtask, so the poll chain stays
 * inside the story that started it. Nothing restores it afterwards, deliberately — every
 * entry into the fake sets the pointer first, so a stale one is never read.
 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const scope = activeScope();
  const handler = scope.commands[cmd];
  if (!handler) throw new Error(`No fake handler registered for command "${cmd}"`);
  try {
    return (await (handler as (a: unknown) => unknown)(args ?? {})) as T;
  } finally {
    activateScope(scope);
  }
}
