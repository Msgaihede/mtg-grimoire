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
    void listen<T>(event, (e) => handler(e.payload)).then(
      (fn) => {
        // Unsubscribed before Tauri finished subscribing: honour it now rather than leaving
        // a handler attached to a component that is already gone.
        if (stopped) {
          fn();
          return;
        }
        off = fn;
      },
      // Registering fails outside a Tauri window — a plain `vite dev`, a story, a jsdom test.
      // Every subscriber used to carry its own `.catch(() => {})` for this; a *synchronous*
      // listen gives them nothing to attach one to, so the boundary owns it. Swallowing is the
      // right answer rather than a shrug: every event this app subscribes to has a polled or
      // prop-borne counterpart that is the reliable half of its pair, so the cost is the fast
      // path and never the fact, and an unhandled rejection would be the louder failure.
      () => {},
    );
    return () => {
      stopped = true;
      off?.();
      off = undefined;
    };
  },
};
