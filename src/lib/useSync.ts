import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, ipcError, type SyncStatus } from "@/lib/ipc";

/** How often the header re-reads `sync_status` when nothing is happening. */
const POLL_IDLE_MS = 30_000;
/** …and while a sync is in flight, where the count and the phase are moving. */
const POLL_SYNCING_MS = 1_000;

/**
 * Fold a fresh poll into what the UI already knows.
 *
 * `sync::status` answers without waiting for the database lock, so during an ingest —
 * which holds it for minutes — all four database-derived fields come back `null`. That
 * is "not readable right now", not "zero" and not "cleared". Rendering it literally
 * would blank the card count and throw away an error banner every time a sync starts.
 *
 * `cardCount` is the discriminator: `status()` fills it in for *every* poll that got the
 * lock (a failed count reads as 0, never as `None`), so a non-null count means the whole
 * group was read and its nulls are real — including a `lastError` that the run just
 * cleared, which must be allowed to land.
 */
export function mergeStatus(prev: SyncStatus | null, next: SyncStatus): SyncStatus {
  if (next.cardCount !== null) return next;
  return {
    ...next,
    cardCount: prev?.cardCount ?? null,
    lastCheckAt: prev?.lastCheckAt ?? null,
    bulkUpdatedAt: prev?.bulkUpdatedAt ?? null,
    lastError: prev?.lastError ?? null,
  };
}

/** The date part of Scryfall's `updated_at` (`2026-08-03T21:16:27.869+00:00`). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/**
 * The header's one-line summary: `116,568 cards · data from 2026-08-03`.
 *
 * Every part is optional, because every part can genuinely be unknown before the first
 * sync finishes — so this drops what it does not have rather than printing `null cards`
 * or a zero that reads as "your collection is empty".
 */
export function statusLine(status: SyncStatus | null): string | null {
  if (!status) return null;
  if (status.cardCount === 0) return "No card data yet";

  const parts: string[] = [];
  if (status.cardCount !== null) parts.push(`${status.cardCount.toLocaleString("en-US")} cards`);
  const date = status.bulkUpdatedAt?.match(ISO_DATE)?.[0];
  if (date) parts.push(`data from ${date}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export interface Sync {
  /** The last readable status, or `null` before the first poll answers. */
  status: SyncStatus | null;
  /** What the banner should say: this session's failure, else the persisted one. */
  error: string | null;
  /** Start a forced sync (skipping the 24 h check window). */
  refresh: () => void;
  /** True from the click until `sync_run` settles. */
  refreshing: boolean;
}

/**
 * Polls `sync_status` and owns the Refresh action.
 *
 * The spinner is driven by the `sync_run` promise rather than by `sync:progress`,
 * because a run inside the 24 h check window returns *without emitting a single event* —
 * a spinner waiting for one would never stop. For the same reason the status is re-read
 * as soon as that promise settles, instead of waiting for the poll timer.
 *
 * Plain hooks rather than TanStack Query: this is one endpoint with a bespoke merge rule
 * and an adaptive interval, and keeping it out of the query cache means `AppShell` needs
 * no provider to be rendered or tested.
 */
export function useSync(): Sync {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  // Bumped to restart the poll loop immediately; see `refresh`.
  const [pollNonce, setPollNonce] = useState(0);
  // The merge needs the previous value, and reading it from a ref keeps the state
  // updater pure (StrictMode invokes updaters twice in development).
  const latest = useRef<SyncStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const next = await ipc.syncStatus();
        if (cancelled) return;
        const merged = mergeStatus(latest.current, next);
        latest.current = merged;
        setStatus(merged);
      } catch {
        // A status read that failed is not worth a banner: the next one is seconds away,
        // and a sync that failed has already persisted its reason to `lastError`.
        if (cancelled) return;
      }
      // Chained timeouts, not an interval: the cadence depends on the answer, and two
      // polls must never overlap.
      timer = setTimeout(poll, latest.current?.syncing ? POLL_SYNCING_MS : POLL_IDLE_MS);
    };
    void poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pollNonce]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setRunError(null);
    ipc
      .syncRun(true)
      .catch((e: unknown) => setRunError(ipcError(e)))
      .finally(() => {
        setRefreshing(false);
        setPollNonce((n) => n + 1);
      });
  }, []);

  return { status, refreshing, refresh, error: runError ?? status?.lastError ?? null };
}
