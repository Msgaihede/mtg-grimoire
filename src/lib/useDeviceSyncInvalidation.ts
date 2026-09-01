import { useEffect } from "react";
import { ipc } from "@/lib/ipc";
import { DEVICE_SYNC_INVALIDATED, queryClient } from "@/lib/query";

/**
 * Refresh the screen when a device sync lands.
 *
 * **This is a bug fix, not a feature.** `sync_now`'s mutation invalidates only `SYNC_KEY`
 * (`SyncPanel.tsx`'s `onSettled`), so applying pulled ops to `collection_entries`,
 * `deck_cards`, `wishlist_entries` and the rest refreshed nothing on screen — on the automatic
 * path *and* on the manual button. It was invisible only because the button lives on the
 * Settings page; the moment a sync lands while the reader is standing on their collection,
 * stale data looks exactly like lost data.
 *
 * It **supplements** `SyncPanel`'s own invalidation rather than replacing it: that mutation
 * only fires for a trip *this window* started, and `sync:applied` is emitted for every trip —
 * including the automatic ones a background wake or another device's push can cause.
 *
 * Uses the module-level `queryClient` from `@/lib/query` rather than `useQueryClient()`: what
 * fires this is an event listener, not a render.
 *
 * **Call this once.** `AppShell` does. Every extra call is another `sync:applied` `listen`
 * registration for the life of the app.
 */
export function useDeviceSyncInvalidation(): void {
  useEffect(
    () =>
      ipc.onSyncApplied(() => {
        for (const queryKey of DEVICE_SYNC_INVALIDATED) {
          void queryClient.invalidateQueries({ queryKey });
        }
      }),
    [],
  );
}
