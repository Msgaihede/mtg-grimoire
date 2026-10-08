import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useIsFetching, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ipc, ipcError } from "@/lib/ipc";
import type { ScannerAssetDue, ScannerAssetsOwed, ScannerAssetsProgress } from "./types";
import { SCANNER_STATUS_KEY } from "./useScannerStatus";

// The status's cache entry is `useScannerStatus`' to name; said again from here so what marks it
// stale and what reads it are seen to be one key by anything that imports either.
export { SCANNER_STATUS_KEY };

/** The cache entry what-is-owed lives in. */
export const SCANNER_ASSETS_KEY = ["scanner", "assets"] as const;

/**
 * The cache entry the last fetch's failure lives in — the engine's sentence, or `null`.
 *
 * **In the cache and not in the hook, because a fetch outlives the view that pressed.** One that
 * fails while the reader is on another view has no mounted hook to tell; kept here, the view
 * that comes back reads why the last download did not work, instead of a plain Download button.
 * Never fetched: it is written by a fetch's end and cleared by the next press.
 */
export const SCANNER_ASSETS_FAILURE_KEY = ["scanner", "assets-failure"] as const;

/**
 * How often a view that found a fetch already running asks whether it still is.
 *
 * Its own press needs no poll — the command's answer is what ends it. This is for the fetch a
 * view that has since been left started, or one whose answer a reloaded page never received:
 * events are best effort, so the question is asked rather than waited for.
 */
export const SCANNER_ASSETS_POLL_MS = 2000;

export interface ScannerAssetsState {
  /**
   * The files this install lacks, as the host answered — **empty when it owes nothing, and
   * empty when the host refused or has not answered**, which is one rule for the page: no rows,
   * no offer.
   */
  owed: ScannerAssetDue[];
  /** All of {@link ScannerAssetsState.owed}, added up. */
  bytes: number;
  /** A fetch is running — this view's press, or one started before it mounted. */
  fetching: boolean;
  /**
   * A fetch has ended and the status on screen predates it: `scanner_status` is being asked
   * again. Its sentences are about files that may since have arrived, so nothing is drawn from
   * them until it answers.
   */
  loading: boolean;
  /** The last word the running fetch said, or `null` before its first. */
  progress: ScannerAssetsProgress | null;
  /** Why the last fetch failed, in the engine's sentence. Cleared by the next press. */
  error: string | null;
  /** Start the fetch. The reader's press and nothing else: no effect here ever calls it. */
  fetch: () => void;
}

const NOTHING_OWED: ScannerAssetDue[] = [];

/**
 * **The end of a fetch, written where every view will find it** — called from the press's own
 * promise, which outlives the hook that made it, so none of this depends on a view being
 * mounted.
 *
 * In this order, and each for a reason:
 *
 * 1. **The status is marked stale first**, before the entry says the fetch is over, so the
 *    first render that sees no fetch running already sees a status that is being read again —
 *    and no sentence about a missing file is drawn from the one read before the download. The
 *    engine let its session go for whatever landed, so the old answer describes a session that
 *    no longer exists. Unconditional: with the Scanner view gone, nothing else would ever mark
 *    it, and the page's query never goes stale by itself.
 * 2. **A read of what is owed still on its way is dropped**: it was asked before the fetch
 *    ended, and landing after this it would say a fetch is running that is not — which the poll
 *    would then see end a second time.
 * 3. The failure, or its absence, and what is owed now.
 */
async function settle(qc: QueryClient, now: ScannerAssetsOwed, failure: string | null) {
  void qc.invalidateQueries({ queryKey: SCANNER_STATUS_KEY });
  await qc.cancelQueries({ queryKey: SCANNER_ASSETS_KEY });
  qc.setQueryData<string | null>(SCANNER_ASSETS_FAILURE_KEY, failure);
  qc.setQueryData<ScannerAssetsOwed>(SCANNER_ASSETS_KEY, now);
}

/** Whether the status entry is waiting to be read again, or being read again right now. */
function statusIsBeingReread(qc: QueryClient, fetching: boolean): boolean {
  const state = qc.getQueryState(SCANNER_STATUS_KEY);
  // No answer yet is a first load, not a re-read; and a re-read that failed has said all it
  // will — the page's own handling of a status it cannot read is what is left.
  if (state === undefined || state.data === undefined || state.status === "error") return false;
  return state.isInvalidated || fetching;
}

/**
 * What this install owes of the scanner's files, and the one press that fetches them.
 *
 * **The host answers; this never asks what kind of host it is.** A desktop release carries the
 * files and answers an empty list; a phone answers three rows; a host that cannot fetch them at
 * all refuses, and a refusal reads as the empty list.
 *
 * **The cache is the state — the `fetching` flag and the last failure included.** A press marks
 * the entry as fetching before the command goes out, and the command's answer is written over
 * it by {@link settle}, from the promise — which outlives this hook, so a reader who leaves the
 * Scanner view mid-download and comes back finds the entry saying so, hears the progress, and
 * sees it end; and one who comes back after it ended finds what is owed now, why it failed if
 * it did, and a status marked for re-reading. A view that finds a fetch running which it did
 * not start asks again every {@link SCANNER_ASSETS_POLL_MS} until it has.
 *
 * **When a fetch ends in front of this view — however it ends, whoever started it —
 * `onLoaded` is called, once.** The engine lets its loaded session go for files that arrived
 * (`ScannerState::forget`), so the next session is a new one: it has to be given the filters
 * again, and whatever the page is holding from the last one is stale. Both are the page's to
 * do, so both are `onLoaded`'s. A fetch that failed with nothing landed calls it too — pushing
 * the same filters again and dropping a verdict costs nothing, and telling the two apart would
 * mean a second question. **Only while this hook is mounted**: a filter push takes the
 * scanner's lease, and a view that has gone must not take it — the view that mounts next
 * pushes its filters as every mount does.
 *
 * **Another window's fetch is heard too** (a desktop build with nothing embedded, two windows):
 * the event reaches every window, so one that is not the fetcher asks what is owed again when
 * it first hears a fetch it did not know of, and again — with the status — when it hears it end.
 */
export function useScannerAssets(onLoaded?: () => void): ScannerAssetsState {
  const qc = useQueryClient();
  /** This view's own press is on the wire, so its answer — not a poll — is what ends it. */
  const [mine, setMine] = useState(false);
  /** The same, for the event's callback, which outlives the render that made it. */
  const mineRef = useRef(false);
  const [progress, setProgress] = useState<ScannerAssetsProgress | null>(null);

  const query = useQuery({
    queryKey: SCANNER_ASSETS_KEY,
    // A closure rather than the bare function: a test that mocks `ipc` without this command
    // then rejects here, as a host without it does, instead of handing the query `undefined`.
    queryFn: () => ipc.scannerAssets(),
    // Asked afresh on every visit — it is one cheap read, and the entry a left view wrote may
    // be a fetch that has since ended. A refusal is an answer, so it is not asked twice.
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (q) =>
      !mine && q.state.data?.fetching === true ? SCANNER_ASSETS_POLL_MS : false,
  });
  const data = query.data;
  const owed = data?.owed ?? NOTHING_OWED;
  const fetching = data?.fetching === true;

  // The last failure: a cache entry read as one, never fetched — see its key.
  const failure = useQuery<string | null>({
    queryKey: SCANNER_ASSETS_FAILURE_KEY,
    queryFn: () => null,
    enabled: false,
    initialData: null,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  // **A fetch ending is seen as it happens, in this render** — React's "adjusting state when a
  // prop changes", as `useScanLoop` does for its camera — so the frame that first shows the
  // fetch as over is already counted as one whose status is owed a re-read.
  const [wasFetching, setWasFetching] = useState(fetching);
  /** Fetches seen to end, and how many of those this hook has acted on. */
  const [ended, setEnded] = useState(0);
  const [acted, setActed] = useState(0);
  if (wasFetching !== fetching) {
    setWasFetching(fetching);
    if (!fetching) setEnded(ended + 1);
  }

  const onLoadedRef = useRef(onLoaded);
  useLayoutEffect(() => {
    onLoadedRef.current = onLoaded;
  });
  /** The last ending acted on — so a development double-run of the effect acts once. */
  const handledRef = useRef(0);
  /** The ending about to be seen is this view's own press's, which {@link settle} has marked. */
  const ownEndRef = useRef(false);
  useEffect(() => {
    if (ended === handledRef.current) return;
    handledRef.current = ended;
    onLoadedRef.current?.();
    // This view's own press has already marked the status ({@link settle}); a fetch somebody
    // else started — seen to end by the poll — has not, and is marked here. Never twice: a
    // second mark would cancel the re-read the first one started and ask again.
    const own = ownEndRef.current;
    ownEndRef.current = false;
    const state = qc.getQueryState(SCANNER_STATUS_KEY);
    const marked =
      own ||
      state?.isInvalidated === true ||
      qc.isFetching({ queryKey: SCANNER_STATUS_KEY }) > 0;
    const reread = marked
      ? Promise.resolve()
      : qc.invalidateQueries({ queryKey: SCANNER_STATUS_KEY });
    void reread.finally(() => setActed(ended));
  }, [ended, qc]);

  // The status's own re-read, watched: `useIsFetching` is what re-renders this when it starts
  // and when it ends, and the entry's state says whether it is a re-read at all.
  const statusFetching = useIsFetching({ queryKey: SCANNER_STATUS_KEY }) > 0;
  const loading = acted !== ended || statusIsBeingReread(qc, statusFetching);

  // The fetch's progress, heard only while there is a fetch to hear about or an offer that
  // could start one — a host that owes nothing never subscribes.
  const listening = owed.length > 0 || fetching;
  useEffect(() => {
    if (!listening) return;
    return ipc.onScannerAssets((e) => {
      setProgress(e);
      // Everything below is for a fetch this view did not start: its own is ended by the
      // command's answer, which carries more than an event can.
      if (mineRef.current) return;
      const over = e.phase === "done" || e.phase === "error";
      if (e.phase === "error" && e.message !== null) {
        qc.setQueryData<string | null>(SCANNER_ASSETS_FAILURE_KEY, e.message);
      }
      if (over) {
        // Another view's fetch — a left view's, or another window's — has ended: what is owed
        // and what is loaded are both new.
        void qc.invalidateQueries({ queryKey: SCANNER_STATUS_KEY });
        void qc.invalidateQueries({ queryKey: SCANNER_ASSETS_KEY });
        return;
      }
      // A fetch this view's entry does not know of: ask once, and the answer says it is
      // running — after which the entry knows, and the rest of its events ask nothing.
      const held = qc.getQueryData<ScannerAssetsOwed>(SCANNER_ASSETS_KEY);
      if (held !== undefined && !held.fetching) {
        void qc.invalidateQueries({ queryKey: SCANNER_ASSETS_KEY });
      }
    });
  }, [listening, qc]);

  const fetch = useCallback(() => {
    const held = qc.getQueryData<ScannerAssetsOwed>(SCANNER_ASSETS_KEY);
    if (held === undefined || held.fetching || held.owed.length === 0) return;
    mineRef.current = true;
    setMine(true);
    setProgress(null);
    qc.setQueryData<string | null>(SCANNER_ASSETS_FAILURE_KEY, null);
    // A poll's answer still on its way predates this press, and would un-mark the entry.
    void qc.cancelQueries({ queryKey: SCANNER_ASSETS_KEY });
    qc.setQueryData<ScannerAssetsOwed>(SCANNER_ASSETS_KEY, { ...held, fetching: true });
    ipc
      .scannerAssetsFetch()
      .then(
        (after) => {
          ownEndRef.current = true;
          return settle(qc, after, null);
        },
        async (e: unknown) => {
          const sentence = ipcError(e);
          // What is owed now: a file that landed before the failure is kept, so the next press
          // owes less. If even that cannot be read, what was owed before still is.
          const now = await ipc.scannerAssets().catch(() => ({ ...held, fetching: false }));
          // Still fetching means another call's fetch is running and this press was the one
          // refused — not a failure of the download, which the poll will see through.
          ownEndRef.current = !now.fetching;
          await settle(qc, now, now.fetching ? null : sentence);
        },
      )
      .finally(() => {
        mineRef.current = false;
        setMine(false);
      });
  }, [qc]);

  return {
    owed,
    bytes: data?.bytes ?? 0,
    fetching,
    loading,
    progress,
    error: failure.data ?? null,
    fetch,
  };
}
