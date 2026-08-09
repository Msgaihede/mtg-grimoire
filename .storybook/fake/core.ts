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
 */

/**
 * `never` in the argument position, not `unknown` and not `any`.
 *
 * It is what lets one `registerCommands` call carry handlers with differently-shaped args:
 * a parameter is checked contravariantly, `never` is assignable to every type, and so
 * `(args: { n: number }) => number` satisfies this while `(args: unknown) => …` would
 * reject it. The price is one cast at the single call site in `invoke`, which is the right
 * side of the trade — the handler maps are written once per fixture and read constantly.
 */
export type CommandHandler = (args: never) => unknown;

let handlers: Record<string, CommandHandler> = {};

/** Merge, not replace: a story adds a command or overrides one without restating the rest. */
export function registerCommands(next: Record<string, CommandHandler>): void {
  handlers = { ...handlers, ...next };
}

/** Drop every handler. The per-story decorator calls this before re-seeding. */
export function resetCommands(): void {
  handlers = {};
}

/**
 * Rejects with an `Error`, which is what the *IPC layer* throws. A Rust command's own
 * refusal is a bare string — all 30 `#[tauri::command]` functions return
 * `Result<_, String>` — and a handler models that by throwing an `Error` whose message is
 * the string, because `ipcError` renders both (`typeof e === "string"` and
 * `e instanceof Error` are its first two branches) and the distinction is invisible past it.
 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const handler = handlers[cmd];
  if (!handler) throw new Error(`No fake handler registered for command "${cmd}"`);
  return (await (handler as (a: unknown) => unknown)(args ?? {})) as T;
}
