import { useEffect, useState } from "react";
import App from "@/App";
import { ipc, type StartupStatus, type Unlisten } from "@/lib/ipc";
import { StartupScreen } from "./StartupScreen";

/**
 * How often the gate asks again while the data folder is still opening.
 *
 * Short because it is the *reliable* half of the pair and a warm start is usually over in a few
 * of these: every tick is a start the reader waits through for no reason once Rust is ready.
 * Cheap because `startup_status` reads no database, and because the next ask is scheduled only
 * after the last one has answered, so a slow answer never stacks a second call behind it.
 */
export const STARTUP_POLL_MS = 150;

/**
 * The desktop and Android root, and `WebBoot`'s counterpart: nothing that queries is mounted
 * until the native side says the data folder is open.
 *
 * **Why a gate at all.** Opening and migrating the two databases runs on a background thread, so
 * the window paints and the taskbar draws its icon instead of the process sitting "Not
 * responding" through a migration. The cost is a window that exists before the state every
 * command reads — and `App` fires its queries on its first render, so mounted early it would
 * fill every surface with an error about a database that is merely not open *yet*.
 *
 * **Two halves, and the poll is the one that cannot be missed.** `startup:changed` is the fast
 * path, but `listen` registers asynchronously: an emit that lands between the first
 * `startupStatus()` and the registration is dropped by Tauri, and a gate trusting the event would
 * then wait forever on a start that already finished. So the command is asked on mount and again
 * every {@link STARTUP_POLL_MS} until it says something other than `loading` — the rule
 * `core/tauri.ts` states for every event this app subscribes to.
 *
 * **A rejected ask is still loading, never a failure.** A call made before the command is
 * registered, or one the transport drops, says nothing about the data folder; the only failure
 * this screen reports is one Rust wrote a sentence for. The next tick asks again.
 *
 * The state only ever leaves `loading` once, so the first answer that is not `loading` wins —
 * whichever half delivered it — and both halves are stopped there.
 */
export function DesktopBoot() {
  const [status, setStatus] = useState<StartupStatus>({ state: "loading" });

  useEffect(() => {
    // `live` is the unmount; `settled` is the answer. Separate because StrictMode runs this
    // effect twice, and the first run's in-flight ask must neither set state nor re-arm a timer.
    let live = true;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: Unlisten | undefined;

    const stop = () => {
      clearTimeout(timer);
      unlisten?.();
      unlisten = undefined;
    };

    const settle = (next: StartupStatus) => {
      if (!live || settled || next.state === "loading") return;
      settled = true;
      stop();
      setStatus(next);
    };

    unlisten = ipc.onStartupChanged(settle);

    const ask = () => {
      void ipc
        .startupStatus()
        .then(settle, () => undefined)
        .finally(() => {
          if (live && !settled) timer = setTimeout(ask, STARTUP_POLL_MS);
        });
    };
    ask();

    return () => {
      live = false;
      stop();
    };
  }, []);

  if (status.state === "ready") return <App />;
  return <StartupScreen status={status} />;
}
