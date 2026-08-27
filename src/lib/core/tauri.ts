import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Core } from "./types";

/** The desktop and Android implementation: Tauri's own IPC. */
export const tauriCore: Core = {
  // `args === undefined` forwards as a ONE-argument call rather than as an explicit
  // `undefined` second argument. Tauri cannot tell the difference, but twenty assertions
  // in `ipc.test.ts` are written `toHaveBeenCalledWith("sync_status")` and vitest compares
  // argument *lists*, so a core that always passes two arguments moves what those tests see.
  call: <T,>(command: string, args?: Record<string, unknown>) =>
    args === undefined ? invoke<T>(command) : invoke<T>(command, args),

  listen: <T,>(event: string, handler: (payload: T) => void) => {
    let stopped = false;
    let off: (() => void) | undefined;
    void listen<T>(event, (e) => handler(e.payload)).then((fn) => {
      // Unsubscribed before Tauri finished subscribing: honour it now rather than leaving
      // a handler attached to a component that is already gone.
      if (stopped) {
        fn();
        return;
      }
      off = fn;
    });
    return () => {
      stopped = true;
      off?.();
      off = undefined;
    };
  },
};
