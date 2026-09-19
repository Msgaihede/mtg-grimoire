import { useEffect } from "react";
import { refreshForTables } from "@/lib/crossWindow";
import { ipc } from "@/lib/ipc";
import { queryClient } from "@/lib/query";

/**
 * Refresh this window when another one writes.
 *
 * `useDeviceSyncInvalidation`'s shape, for its reason: an event listener rather than a render, so
 * the module-level `queryClient`. Rust sends `db:changed` only while two or more windows are open,
 * so in a one-window session this subscribes and never hears anything.
 *
 * **Call this once.** `AppShell` does.
 */
export function useCrossWindowRefresh(): void {
  useEffect(() => ipc.onDbChanged((e) => refreshForTables(queryClient, e.tables)), []);
}
