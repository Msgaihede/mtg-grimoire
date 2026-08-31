import { useEffect, useRef, useState } from "react";
import { ipc, type LiveState } from "@/lib/ipc";

/**
 * The relay socket's state, as the ribbon shows it.
 *
 * **Seeds from `ipc.syncLiveState()`, then subscribes to `sync:live`.** The Rust manager
 * deduplicates that event — it emits only on a *transition*, because otherwise `"off"` would
 * go out every five seconds forever on every installation that has paired nothing, which is
 * all of them today — and Tauri drops events emitted before the webview registered a listener.
 * A hook that only subscribed would therefore sit on its `"off"` default until the next
 * transition, which at launch is the common case rather than a rare race: a device already
 * connected when this mounts would read `"off"` for as long as the socket stays `"live"`.
 *
 * **The seed tolerates the command rejecting.** The web target has no relay commands at all —
 * `web/route.rs`'s `COMMANDS` list carries none of them — so `syncLiveState()` rejects there,
 * and this hook simply stays at `"off"` rather than throwing or leaving an unhandled rejection.
 *
 * **A `seeded` ref lets a real event always win over the seed, and the guard is load-bearing
 * rather than ceremony — the same dedup above is exactly what makes the race unrecoverable if
 * it is missing.** Walk it: the hook mounts, subscribes, and starts the seed fetch. The manager
 * emits a real `live` transition at +5 ms. The seed — read from the atomic *before* that
 * transition — resolves at +20 ms with the pre-transition value and, unguarded, would overwrite
 * the real one. Because `sync:live` only fires on a transition, **there is no second event to
 * correct it**: the ribbon would sit on the stale value until the next genuine transition, which
 * on a healthy socket may be hours away or never for the life of the session. So the listener
 * marks `seeded.current = true` on every event it receives, and the seed's `.then` only applies
 * its answer if no event has arrived first — a real transition always outranks a value read
 * before it.
 *
 * **Call this once.** `AppShell` does. Every extra call is another `sync:live` `listen`
 * registration for the life of the app.
 */
export function useDeviceSyncLive(): LiveState {
  const [state, setState] = useState<LiveState>("off");
  const seeded = useRef(false);

  useEffect(() => {
    // Subscribe first: a transition landing before the seed resolves must still flip `seeded`
    // before the seed's `.then` below gets a chance to check it.
    const unlisten = ipc.onSyncLive((e) => {
      seeded.current = true;
      setState(e.state);
    });

    void ipc
      .syncLiveState()
      .then((value) => {
        if (!seeded.current) setState(value);
      })
      // No relay commands on the web target, and no Tauri window under a plain `vite dev` —
      // either way, staying at `"off"` is the honest answer and not worth taking the app down
      // for.
      .catch(() => {});

    return unlisten;
  }, []);

  return state;
}
