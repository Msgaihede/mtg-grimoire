import { useEffect, useState } from "react";
import { ipc, type StartupStatus, type Unlisten } from "@/lib/ipc";

/**
 * How often the gate asks again while the data folder is still opening.
 *
 * Short because it is the *reliable* half of the pair and a warm start is usually over in a few
 * of these: every tick is a start the reader waits through for no reason once Rust is ready.
 * Cheap because `startup_status` reads no database, and because the next ask is scheduled only
 * after the last one has answered, so a slow answer never stacks a second call behind it.
 */
export const STARTUP_POLL_MS = 150;

const READY: StartupStatus = { state: "ready" };
const LOADING: StartupStatus = { state: "loading" };

/**
 * Whether the native side has opened the data folder.
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
 * whichever half delivered it — and the poll is stopped there.
 *
 * **The listener is kept after `ready`, for the one move a host may still make: `ready` to
 * `failed`.** The web host makes it when its engine's Worker dies (`core/web/index.ts`'s
 * `crashed`): from then until a reload there is no app behind the page, which is a fact about the
 * whole window and belongs to the gate, not to each query that would otherwise find it out alone.
 * **Never the other way** — nothing comes back from `failed`, and a second `ready` is no news — so
 * the answer still cannot flap, and a `failed` ends the subscription for good. **The desktop and
 * the Android host never say anything after `ready`**: their engine cannot stop while the window
 * lives, so for them this is one registration that stays quiet, and the poll has stopped either
 * way. A failure after `ready` has no polled half — nothing asks again once the app is up — which
 * is honest only because the host that sends it delivers events in the page's own thread, with
 * nothing to drop them.
 *
 * **`enabled: false` answers `ready` at once and asks nothing** — for a host with no startup to
 * wait for. The light app's fake mode is the one caller: the Storybook fake answers no
 * `startup_status`, and this hook reads a rejected ask as *still loading*, so gating there would
 * wait for ever.
 */
export function useStartup(enabled: boolean = true): StartupStatus {
  const [status, setStatus] = useState<StartupStatus>(enabled ? LOADING : READY);

  useEffect(() => {
    if (!enabled) return;
    // `live` is the unmount; `at` is the answer so far. Separate because StrictMode runs this
    // effect twice, and the first run's in-flight ask must neither set state nor re-arm a timer.
    let live = true;
    let at: StartupStatus["state"] = "loading";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: Unlisten | undefined;

    const unsubscribe = () => {
      unlisten?.();
      unlisten = undefined;
    };

    const settle = (next: StartupStatus) => {
      if (!live || next.state === "loading") return;
      // The two moves there are: out of `loading`, and from `ready` to `failed`. Anything else —
      // a second `ready`, or any word after `failed` — is not news.
      if (at === "failed" || next.state === at) return;
      at = next.state;
      // Nothing is asked again once there is an answer; the listener outlives a `ready` alone.
      clearTimeout(timer);
      if (at === "failed") unsubscribe();
      setStatus(next);
    };

    unlisten = ipc.onStartupChanged(settle);

    const ask = () => {
      void ipc
        .startupStatus()
        .then(settle, () => undefined)
        .finally(() => {
          if (live && at === "loading") timer = setTimeout(ask, STARTUP_POLL_MS);
        });
    };
    ask();

    return () => {
      live = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [enabled]);

  return status;
}
