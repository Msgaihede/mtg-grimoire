import { tableCore } from "./table";
import { tauriCore } from "./tauri";
import type { CallArgs, CallOptions, Core } from "./types";

export type { CallArgs, CallOptions, Core };

/**
 * The mark a host that answers through the command table sets before the page's first script
 * runs — the Android host, by `append_invoke_initialization_script`
 * (`mobile/src-tauri/src/lib.rs`'s `HOST_MARK`). **Read here and nowhere else**: which transport
 * carries a call is below the `Core` seam (the light-app spec §3.5), and no page may ask where it
 * runs (`mobile/phone/fence.test.ts`).
 */
export const HOST_MARK = "__GRIMOIRE_CORE__";

/** Which implementation a window with these globals calls through. */
export function pickCore(scope: object): Core {
  return (scope as Record<string, unknown>)[HOST_MARK] === "table" ? tableCore : tauriCore;
}

/**
 * The implementation every command goes through: Tauri's own IPC on the desktop (a typed command
 * per name), and on the light app's Android host one `core_call` that names the command.
 */
export const core: Core = pickCore(globalThis);
