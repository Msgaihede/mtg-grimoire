import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  ipc,
  type OracleTagPhase,
  type OracleTagProgressEvent,
  type OracleTagStatus,
} from "@/lib/ipc";

/**
 * Everything the Oracle tag taxonomy is cached under.
 *
 * A **prefix**, and it is the seam a completed refresh acts on: the taxonomy has just been
 * replaced underneath every pile every deck screen has already drawn, and no key moved — the
 * cards are the same cards. So {@link useOracleTagProgress} invalidates this whole subtree when
 * a refresh lands, and **any read of `oracleTagsForPrintings`/`oracleTagsForCards` keyed under
 * it regroups for free**. A tag read keyed anywhere else will not.
 */
export const ORACLE_TAGS_KEY = ["oracleTags"];

/** The taxonomy's freshness — one small table, no network, safe before the first ingest. */
export const ORACLE_TAGS_STATUS_KEY = ["oracleTags", "status"];

/**
 * What each phase is called on screen — the label on the ribbon's status line and its mana
 * line, and **total over the union** exactly as `PHASE_LABEL` is over `SyncPhase`.
 *
 * `OracleTagPhase` is a hand-mirrored copy of `oracle_tags::PHASES`, and a phase Rust emits
 * that is missing here renders `undefined` while the refresh runs perfectly — nothing fails
 * except what the reader is told. `useOracleTagProgress.test.ts` pins this list against the
 * Rust one, which `the_progress_phases_are_the_ones_the_frontend_mirrors` pins from its side.
 *
 * The words say **tags** and never "categories": Rust stores slugs and knows nothing about a
 * pile called Removal, and a sentence promising the reader their categories were updated would
 * be describing a conclusion `features/decks` draws somewhere else entirely.
 */
export const ORACLE_TAG_PHASE_LABEL: Record<OracleTagPhase, string> = {
  checking: "Checking for card tag updates",
  downloading: "Downloading card tags",
  // No count, and that is a fact about the backend rather than a choice made here: `refresh`
  // hands `ingest_gz` a `&mut |_| {}` and emits `("ingesting", 0, 0)` exactly once, so there is
  // no number to print and the bar is indeterminate for the whole ingest.
  ingesting: "Importing card tags",
  done: "Card tags are up to date",
  error: "Card tag refresh failed",
};

/** The taxonomy's state, and whether it is being replaced right now. */
export interface OracleTagRefresh {
  /** The backend's row, or `null` while the status read has not answered (or could not).
   *  **Never a rejection to guard against**: a database that has never ingested answers every
   *  field `null` with `stale: true`. */
  status: OracleTagStatus | null;
  /** A refresh is in flight — this window's or the one the backend starts at launch. */
  refreshing: boolean;
  /** The latest `oracle-tags:progress` event, for the one surface that counts bytes. `null`
   *  until one arrives, which is most of the time. */
  progress: OracleTagProgressEvent | null;
}

/** The phases that mean a refresh is still running. `done` and `error` are terminal and their
 *  event outlives the run, so neither may be read as "in flight". */
const RUNNING: OracleTagPhase[] = ["checking", "downloading", "ingesting"];

/**
 * Subscribe to `oracle-tags:progress` and say whether the taxonomy is being replaced.
 *
 * **Call this once.** `AppShell` is that one caller — `useSyncProgress`'s rule, for its reason:
 * every extra call is another `listen` registration on the same event for the life of the app.
 * A second consumer reads the result as a prop, or reads {@link ORACLE_TAGS_STATUS_KEY} out of
 * the cache; it does not start a second subscription.
 *
 * **The status read is the reliable half of the pair, and it is why this hook is not the event
 * alone.** Tauri drops events emitted before the webview registered its listener, and
 * `oracle_tags::refresh_if_due` is spawned at launch — so the ordinary case is a refresh that
 * began before this window existed, whose `checking` and first `downloading` events nobody
 * heard. `OracleTagStatus.refreshing` is process-wide and answers for that run; the event is
 * what carries the *numbers* once one arrives, and what says when it ended.
 *
 * A terminal event invalidates {@link ORACLE_TAGS_KEY}, which is what makes a refresh nobody in
 * this window started visible: the flag goes false on the refetched status, and every tag read
 * cached under that prefix asks again against a taxonomy that has just been swapped.
 */
export function useOracleTagProgress(): OracleTagRefresh {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<OracleTagProgressEvent | null>(null);

  /**
   * Not `staleTime: Infinity`: this is a fact about a table a refresh rewrites, and it is
   * re-read after every one. A rejection is not guarded against because the command does not
   * have one — `oracle_tags_status` answers a database with no meta row rather than refusing,
   * so `data` being `undefined` here means the read has not landed, never that it failed.
   *
   * **It polls while it believes a refresh is running, and that is not belt-and-braces — it is
   * the only thing that ends the line in the ordinary case.** Measured in the shipped window
   * 2026-08-14 (`tauri dev`, debug): the ribbon read *"Updating card tags"* indefinitely while
   * a direct `oracle_tags_status()` answered `refreshing: false` with the ingest long finished.
   * The invalidation below never ran, because the terminal event was emitted **before this
   * window registered its listener** — exactly the case this hook's own doc calls the ordinary
   * one. Deriving `refreshing` from a cached status that only a *missed* event invalidates is
   * circular, and the activity row never clears.
   *
   * 1.5 s against a local SQLite read of one row, and only while the flag is up, so an idle
   * window polls nothing at all.
   */
  const status =
    useQuery({
      queryKey: ORACLE_TAGS_STATUS_KEY,
      queryFn: () => ipc.oracleTagsStatus(),
      refetchInterval: (query) => (query.state.data?.refreshing === true ? 1500 : false),
    }).data ?? null;

  useEffect(() => {
    let cancelled = false;
    let stop: UnlistenFn | undefined;
    ipc
      .onOracleTagProgress((event) => {
        setProgress(event);
        // Both terminal phases, not just `done`. A failed refresh leaves the previous taxonomy
        // exactly where it was — so there is nothing new to read — but `refreshing` is still
        // true on the status this window last read, and only a refetch takes it down.
        if (event.phase === "done" || event.phase === "error") {
          void queryClient.invalidateQueries({ queryKey: ORACLE_TAGS_KEY });
        }
      })
      .then((unlisten) => {
        // `listen` resolves a tick later than the unmount can happen, so the handle has to be
        // dropped here too — otherwise it outlives the component for the app's lifetime.
        if (cancelled) unlisten();
        else stop = unlisten;
      })
      // Registering a listener fails outside a Tauri window (a plain `vite dev`, a story).
      // Losing the fast path is not worth taking the app down for, and it costs less here than
      // anywhere else in the app: the status read still answers, and a taxonomy that never
      // arrives costs categories filed by card type rather than by what a card does.
      .catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [queryClient]);

  return {
    status,
    // **Two sources, and neither is redundant.** The backend's flag is the authoritative one
    // and is only as fresh as the last status read; the event is what starts the line moving
    // for a refresh that began after that read, and what ends it.
    refreshing:
      status?.refreshing === true || (progress !== null && RUNNING.includes(progress.phase)),
    progress,
  };
}
