import { useEffect } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { ipc, type SyncProgressEvent } from "@/lib/ipc";
import { queryClient } from "@/lib/query";

/**
 * Every query root a finished sync can have made wrong.
 *
 * `["cards"]` covers the searches, `["collection"]`/`["wishlist"]` the two user lists and
 * their summaries (a repointed row changes both), `["card"]` the detail pane and its
 * printings list, and `["sets"]` the set picker — whose `staleTime` is `Infinity` once it
 * has rows, so nothing else in the app can ever refresh it.
 */
export const SYNC_INVALIDATED = [["cards"], ["collection"], ["wishlist"], ["card"], ["sets"]];

/** Mark all of it stale; only the queries actually on screen pay for a refetch. */
function invalidateAll(): void {
  for (const queryKey of SYNC_INVALIDATED) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

/**
 * Refresh the query cache when a sync finishes.
 *
 * A sync drops and recreates `cards` — all 116,590 rows of it — and reconciles the user's
 * own rows against Scryfall's id migrations. Nothing in the cache knows: TanStack Query
 * invalidates on writes *this* app makes, and an ingest is a write nobody in the frontend
 * made. Without this, every query mounted across those ~90 seconds went on answering with
 * pre-sync data until its view was remounted or the window refocused — and `["sets"]`
 * never at all, because the set picker holds its answer with `staleTime: Infinity`.
 *
 * Two triggers, because there are two ways a sync changes what is on screen:
 *
 * * the **`done` phase**, which every successful path emits (`sync::emit_done`) — the card
 *   corpus is new;
 * * **`collection:reconciled`**, which `sync::reconcile_ids` emits only when a migration
 *   actually moved one of the user's rows — a repoint, a fold, or a flag.
 *
 * The second currently always precedes the first, so it is the belt to the other's braces:
 * it is what keeps this right if a reconcile ever runs somewhere a `done` does not follow,
 * and it costs one listener.
 *
 * Takes the progress event as a **prop** rather than calling `useSyncProgress` itself:
 * that hook is one `listen` registration per call and `AppShell` is deliberately its only
 * caller. It uses the module's `queryClient` rather than `useQueryClient` for the same
 * reason `useSync` avoids the cache entirely — `AppShell` renders in its own tests with no
 * provider around it.
 */
export function useSyncInvalidation(progress: SyncProgressEvent | null): void {
  // The *phase*, not the event: `sync:progress` lands a new object every batch of an
  // ingest, and this effect must run on the transition into `done` rather than on each of
  // the hundred ticks that led to it.
  const phase = progress?.phase ?? null;
  useEffect(() => {
    if (phase === "done") invalidateAll();
  }, [phase]);

  useEffect(() => {
    let cancelled = false;
    let stop: UnlistenFn | undefined;
    ipc
      .onCollectionReconciled(invalidateAll)
      .then((off) => {
        // `listen` resolves a tick later than an unmount can happen, so the handle has to
        // be dropped here too — see `useSyncProgress`, which learned this first.
        if (cancelled) off();
        else stop = off;
      })
      // Registering fails outside a Tauri window (a plain `vite dev`). The `done` phase
      // arrives through the props either way, and that is the trigger that matters.
      .catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
}
