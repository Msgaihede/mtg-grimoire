import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { ipc, type SyncPhase, type SyncProgressEvent } from "@/lib/ipc";

/** What each phase is called on screen — the label under the bar and on the mana line. */
export const PHASE_LABEL: Record<SyncPhase, string> = {
  checking: "Checking for card data updates",
  downloading: "Downloading card data",
  ingesting: "Importing cards",
  sets: "Updating set list",
  // Once per database, ever: the one-time conversion to incremental auto-vacuum. It rides
  // the mana line like every other phase, with no denominator — `VACUUM` reports no
  // progress of any kind, so claiming a fraction would be an invention.
  compacting: "Compacting database…",
  done: "Card data is up to date",
  error: "Sync failed",
};

/**
 * The latest `sync:progress` event, or `null` if none has arrived.
 *
 * Never a complete account of a sync: Tauri drops events nobody is listening for, the
 * startup sync emits its first ones before this component exists, and a run inside the
 * 24 h check window emits none at all. Everything that has to survive that is in
 * `sync_status` instead — which is why `SyncProgress` takes an `error` prop rather than
 * trusting these events to tell it when something went wrong.
 *
 * **Call this once.** `AppShell` is that one caller; the ribbon's mana line and the
 * first-run overlay both read the result as a prop. Every extra call is another `listen`
 * registration on the same event for the life of the app — the hook lives in its own
 * module so both consumers can share one subscription, not so both can start one.
 */
export function useSyncProgress(): SyncProgressEvent | null {
  const [progress, setProgress] = useState<SyncProgressEvent | null>(null);

  useEffect(() => {
    let cancelled = false;
    let stop: UnlistenFn | undefined;
    ipc
      .onSyncProgress(setProgress)
      .then((unlisten) => {
        // `listen` resolves a tick later than the unmount can happen, so the handle has
        // to be dropped here too — otherwise it outlives the component for the app's
        // lifetime.
        if (cancelled) unlisten();
        else stop = unlisten;
      })
      // Registering the listener fails outside a Tauri window (a plain `vite dev`, say).
      // Losing the fast path for progress is not worth taking the app down for: the
      // status poll still answers, and it is the reliable half of the pair.
      .catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  return progress;
}
