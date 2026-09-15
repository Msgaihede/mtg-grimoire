import { useCallback, useEffect, useRef } from "react";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CollectionImportItem, ImportCommitOutcome } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import type { ScannerTrayRow } from "./types";

/** The cache entry the tray lives in. */
const TRAY_KEY = ["scanner", "tray"] as const;

/** Stable identity for "nothing scanned", so a consumer's memo does not see a new array each render. */
const EMPTY: readonly ScannerTrayRow[] = [];

/**
 * The tray's write queue: the tail every new write waits on (it never rejects, so a refused write
 * does not stall the next), how many writes are queued or on the wire, and whether a tray write is
 * queued and has not gone out yet.
 *
 * **One per query client rather than one per mount**, because the cache it writes is per client:
 * a view switch unmounts the tray with its flush still on the wire, and a remount that started a
 * queue of its own would put its first write — or a commit — beside that one instead of behind it.
 */
interface WriteQueue {
  tail: Promise<void>;
  pending: number;
  writeWaiting: boolean;
}
const queues = new WeakMap<QueryClient, WriteQueue>();

function queueFor(qc: QueryClient): WriteQueue {
  let queue = queues.get(qc);
  if (queue === undefined) {
    queue = { tail: Promise.resolve(), pending: 0, writeWaiting: false };
    queues.set(qc, queue);
  }
  return queue;
}

/**
 * How long the tray has to stay unchanged before it is written.
 *
 * The tray is stored whole, and a stepper held down or a pile swept in Fast mode is several
 * changes a second — so the store gets the tray once the reader pauses, and gets the last one.
 * Short enough that a crash loses at most the card that landed in the last moment.
 */
export const TRAY_QUIET_MS = 400;

/** How long a refused write waits before its one more try — `useScannerPrefs`' `PREFS_RETRY_MS`,
 *  for its reason: BUSY is a sync's tail, which is seconds. */
export const TRAY_RETRY_MS = 1500;

export interface TrayState {
  /** Newest first, exactly as `tray.ts`' reducer left them. Empty until the row loads. */
  rows: ScannerTrayRow[];
  loaded: boolean;
  /**
   * The tray as the last write left it, read now rather than at the last render — for the writers
   * that run outside a render (a decision from the pump, a printing handed back by a dialog, a
   * commit's answer), each of which can land after more cards were scanned than its closure knew.
   */
  latest: () => ScannerTrayRow[];
  /** On screen now; persisted after {@link TRAY_QUIET_MS} of quiet, and on unmount. */
  setRows: (rows: ScannerTrayRow[]) => void;
  /**
   * The tray into the collection through `scanner_tray_commit`, with `remaining(latest)` stored as
   * the tray **in the same transaction** — so no restart can bring back a row the collection
   * already holds.
   *
   * `remaining` is asked twice, both times of the rows as they are *then*: once when the write
   * actually goes out (it queues behind any tray write already on the wire), and once when it
   * answers, because the camera keeps running in between. A rejection keeps every row and is
   * the caller's to word.
   */
  commit: (
    items: CollectionImportItem[],
    folderId: number | null,
    remaining: (latest: ScannerTrayRow[]) => ScannerTrayRow[],
  ) => Promise<ImportCommitOutcome>;
}

/**
 * The review tray's `app_meta` row, held in memory and written behind the reader.
 *
 * **The cache entry is the tray.** `setRows` is a `setQueryData` on `["scanner", "tray"]`, so the
 * page draws one value and a view switch finds the rows where they were — `gcTime: Infinity`, or
 * five minutes on another page would hand a remount the stored copy and lose every card whose write
 * was still pending or refused. Nothing but this hook writes the row, so a refetch could only ever
 * be older than what is here, which is why `staleTime` is `Infinity` too.
 *
 * **Every write is single-flight, the commit included.** At most one `set_scanner_tray` or
 * `scanner_tray_commit` is on the wire; the next waits for it to settle, so they reach the backend
 * in the order they were asked for. Two tray writes racing could land old-after-new, and a tray
 * write that started before a commit and landed after it restored the rows the commit had just
 * filed — which the next launch offered again, and the next Add filed twice. A write asked for
 * while another is still waiting to go is the same write: it reads the rows when it goes, so the
 * queue never holds more than one.
 *
 * **A write that fails keeps the rows and says nothing.** `set_scanner_tray` answers BUSY while a
 * sync holds the write connection, and rows scanned during a sync are the reader's cards: the tray
 * stays on screen, the next change writes the whole tray again, and one more try after
 * {@link TRAY_RETRY_MS} is what lets a tray nobody touches again survive a restart.
 *
 * **Unmount flushes**, so leaving the Scanner inside the quiet window does not cost the card that
 * just landed. The flush reads the cache rather than a closure, so it writes the tray as it is.
 */
export function useTray(): TrayState {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: TRAY_KEY,
    queryFn: ipc.scannerTray,
    staleTime: Infinity,
    gcTime: Infinity,
    // **`latest()` hands back the very rows the last write passed in.** Structural sharing would
    // rebuild any row whose index moved when a card landed at the head, and the page's commit tells
    // a row nobody touched from one bumped in flight by identity (`withoutCommitted`).
    structuralSharing: false,
  });

  const quietRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const latest = useCallback(() => qc.getQueryData<ScannerTrayRow[]>(TRAY_KEY) ?? [], [qc]);

  /**
   * Run `job` once everything queued before it has settled — **at once, in this tick, when nothing
   * is**, so an unmount's flush is on the wire before the component is gone rather than a microtask
   * later.
   */
  const enqueue = useCallback(
    <T>(job: () => Promise<T>): Promise<T> => {
      const queue = queueFor(qc);
      const run = queue.pending === 0 ? job() : queue.tail.then(job);
      queue.pending += 1;
      const settled = () => {
        queue.pending -= 1;
      };
      queue.tail = run.then(settled, settled);
      return run;
    },
    [qc],
  );

  /** Queue one tray write, unless one is already waiting to go. Resolves `false` when refused. */
  const queueWrite = useCallback((): Promise<boolean> | null => {
    const queue = queueFor(qc);
    if (queue.writeWaiting) return null;
    queue.writeWaiting = true;
    return enqueue(async () => {
      queue.writeWaiting = false;
      await ipc.setScannerTray(latest());
    }).then(
      () => true,
      () => false,
    );
  }, [enqueue, latest, qc]);

  const write = useCallback(() => {
    if (retryRef.current !== null) {
      clearTimeout(retryRef.current);
      retryRef.current = null;
    }
    void queueWrite()?.then((ok) => {
      // A newer write is already waiting to go, and it carries the whole tray.
      const newer = quietRef.current !== null || retryRef.current !== null || queueFor(qc).writeWaiting;
      if (ok || newer) return;
      retryRef.current = setTimeout(() => {
        retryRef.current = null;
        // Once more and no further — a tray still refused waits for the next change.
        void queueWrite();
      }, TRAY_RETRY_MS);
    });
  }, [qc, queueWrite]);

  const setRows = useCallback(
    (rows: ScannerTrayRow[]) => {
      qc.setQueryData<ScannerTrayRow[]>(TRAY_KEY, rows);
      if (quietRef.current !== null) clearTimeout(quietRef.current);
      quietRef.current = setTimeout(() => {
        quietRef.current = null;
        write();
      }, TRAY_QUIET_MS);
    },
    [qc, write],
  );

  const commit = useCallback(
    (
      items: CollectionImportItem[],
      folderId: number | null,
      remaining: (latest: ScannerTrayRow[]) => ScannerTrayRow[],
    ) =>
      enqueue(async () => {
        const sent = latest();
        const rest = remaining(sent);
        const outcome = await ipc.scannerTrayCommit(items, folderId, rest);
        const now = latest();
        if (now === sent) {
          // The store already holds exactly this: nothing to write behind it, and a quiet timer
          // still counting down would only write the same tray again.
          qc.setQueryData<ScannerTrayRow[]>(TRAY_KEY, rest);
          if (quietRef.current !== null) {
            clearTimeout(quietRef.current);
            quietRef.current = null;
          }
        } else {
          // Cards landed while it was on the wire: the tray without what the commit took, and
          // written behind the reader like any other change.
          setRows(remaining(now));
        }
        return outcome;
      }),
    [enqueue, latest, qc, setRows],
  );

  useEffect(
    () => () => {
      if (quietRef.current === null) return;
      clearTimeout(quietRef.current);
      quietRef.current = null;
      write();
    },
    [write],
  );

  return {
    rows: (query.data ?? EMPTY) as ScannerTrayRow[],
    // A row that could not be read is an empty tray, which is what the command answers for one.
    loaded: !query.isPending,
    latest,
    setRows,
    commit,
  };
}
