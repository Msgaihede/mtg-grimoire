import type { StartupStatus } from "@/lib/ipc";
import type { CallArgs, CallOptions, Core } from "./types";

/**
 * A `Core` whose implementation is a chunk that has not arrived yet.
 *
 * `core` is a value every module reads at import, and the web host's implementation is reached
 * by a dynamic import so that no other build carries it (`index.ts`). This is what stands in the
 * gap: a call waits for the chunk and is then the implementation's own, and a subscription is
 * `tauri.ts`'s — a synchronous unsubscribe that still takes effect if it is pressed before the
 * subscribing has happened.
 *
 * `load` runs once, on the first use, and never at import.
 */
export function deferredCore(load: () => Promise<Core>): Core {
  let loading: Promise<Core> | undefined;
  const loaded = (): Promise<Core> => (loading ??= load());

  return {
    call: <T>(command: string, args?: CallArgs, options?: CallOptions) =>
      loaded().then((core) => core.call<T>(command, args, options)),

    listen: <T>(event: string, handler: (payload: T) => void) => {
      let stopped = false;
      let off: (() => void) | undefined;
      void loaded().then(
        (core) => {
          if (!stopped) off = core.listen(event, handler);
        },
        // Every event has a polled counterpart that is the reliable half of its pair
        // (`tauri.ts`), and the call beside this one is what reports a chunk that never came.
        () => {},
      );
      return () => {
        stopped = true;
        off?.();
        off = undefined;
      };
    },
  };
}

/** The gate's command, answered by a host itself rather than by the engine's table. */
export const STARTUP_COMMAND = "startup_status";

/** The gate's event: the status a host settled on, once, when it leaves `loading`. */
export const STARTUP_CHANGED = "startup:changed";

/**
 * A `Core` for a host that could not be loaded at all: **the gate is told so, and told a reload
 * can cure it**; every other call is refused with the same sentence.
 *
 * Without it a host chunk that never arrives — offline, or a deploy that renamed it under a page
 * still open — is a rejected `startup_status`, which the gate reads as *still loading*
 * (`boot/useStartup.ts`), and the reader watches "Opening your collection…" for ever.
 */
export function refusedCore(message: string): Core {
  const status: StartupStatus = { state: "failed", message, reload: true };
  return {
    call: <T>(command: string) =>
      command === STARTUP_COMMAND ? Promise.resolve(status as T) : Promise.reject(message),
    listen: () => () => {},
  };
}
