import { useEffect, useState } from "react";
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
 * **Call this once.** `AppShell` does. Every extra call is another `sync:live` `listen`
 * registration for the life of the app.
 */
export function useDeviceSyncLive(): LiveState {
  const [state, setState] = useState<LiveState>("off");

  useEffect(() => {
    let cancelled = false;
    void ipc
      .syncLiveState()
      .then((seeded) => {
        if (!cancelled) setState(seeded);
      })
      // No relay commands on the web target, and no Tauri window under a plain `vite dev` —
      // either way, staying at `"off"` is the honest answer and not worth taking the app down
      // for.
      .catch(() => {});

    const unlisten = ipc.onSyncLive((e) => setState(e.state));
    return () => {
      cancelled = true;
      unlisten();
    };
  }, []);

  return state;
}
