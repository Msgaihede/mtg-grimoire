import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { DEVICE_SYNC_INVALIDATED } from "@/lib/crossWindow";
import { ipc } from "@/lib/ipc";
import { queryClient, SYNC_KEY } from "@/lib/query";

/**
 * Refresh the screen when a device sync lands.
 *
 * **This is a bug fix, not a feature.** `sync_now`'s mutation invalidates only `SYNC_KEY`
 * (`SyncPanel.tsx`'s `onSettled`), so applying pulled ops to `collection_entries`,
 * `deck_cards`, `wishlist_entries` and the rest refreshed nothing on screen — on the automatic
 * path *and* on the manual button. It was invisible only because the button lives on the
 * Settings page; the moment a sync lands while the reader is standing on their collection,
 * stale data looks exactly like lost data. **What it refreshes is `DEVICE_SYNC_INVALIDATED`**,
 * the cross-window table map read at the synced tables, whose comment has the second half of this
 * story — the same bug, still open for sticky notes, tags and the card modal's holdings, until
 * that list stopped being written by hand.
 *
 * It **supplements** `SyncPanel`'s own invalidation rather than replacing it: that mutation
 * only fires for a trip *this window* started, and `sync:applied` is emitted for every trip —
 * including the automatic ones a background wake or another device's push can cause.
 *
 * **A trip that changed nothing here refreshes `SYNC_KEY` alone**, and `RelayOutcome.changed` is
 * the whole of that test. Rust emits the event when a trip pushed or changed something, and
 * `changed` is true when it applied or mooted an op, brought a row back, broke a folder cycle or
 * ran a conversion behind its pull — so a push-only trip, which every write of the reader's own
 * ends in, changed no row a query reads: the window that wrote has settled its own keys and every
 * other window heard `db:changed`. **It gated on `pulled > 0` for one review round**, and that
 * missed a trip whose pull only mooted — the moot arm deletes rows and counts them in `moot`,
 * never in `applied` — or whose conversions wrote the only rows. Refreshing the whole
 * set there would re-read a deep search, an open card and the Tags page after every press — and a
 * read under one of those roots that ever wrote a synced table would push, firing the event that
 * re-ran it: `multi-window.md`'s refresh loop, with the relay inside it.
 *
 * **The client is the module-level `queryClient` from `@/lib/query` unless a caller hands one
 * in**, and never `useQueryClient()` read in here: what fires this is an event listener, not a
 * render. The desktop shell says nothing and gets the app's one client. The light app's phone
 * face hands in the client its own provider holds (`apps/light/phone/cardData.ts`) — the same object
 * in the shipped app, and the fake world's own under a test, which is the only way a test of that
 * face can watch one of its lists refetch.
 *
 * **Call this once per face.** `AppShell` does for the desktop, and the desktop face of the light
 * app is that shell; the phone face has no shell of the desktop's and mounts it beside its other
 * listeners. Every extra call is another `sync:applied` `listen` registration for the life of the
 * face that made it.
 */
export function useDeviceSyncInvalidation(client: QueryClient = queryClient): void {
  useEffect(
    () =>
      ipc.onSyncApplied((outcome) => {
        for (const queryKey of outcome.changed ? DEVICE_SYNC_INVALIDATED : [SYNC_KEY]) {
          void client.invalidateQueries({ queryKey });
        }
      }),
    [client],
  );
}
