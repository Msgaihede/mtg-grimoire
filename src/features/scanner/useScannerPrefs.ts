import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ipc, ipcError } from "@/lib/ipc";
import type { ScanFilters, ScannerPrefs } from "./types";

/** The one cache entry the prefs live in — the query's key and every write's. */
const PREFS_KEY = ["scanner", "prefs"] as const;

/** The unrestricted filter: what a session holds before anything has been pushed to it. */
const NO_FILTERS: ScanFilters = { sets: [], released_from: null, released_to: null };

/**
 * What the page draws before the row has loaded — `ScannerPrefs::default()` in `scanner.rs`.
 *
 * **Spelled here rather than imported from `fixtures.ts`**, which holds the same value for the
 * fake and the tests: a fixtures module is a workbench file, and the app's bundle should not carry
 * every canned verdict to read six fields. `useScannerPrefs.test.ts` holds the two equal, so they
 * agree by a test rather than by hand.
 */
export const SCANNER_PREFS_BEFORE_LOAD: ScannerPrefs = {
  mode: "fast",
  filters: NO_FILTERS,
  finish: "nonfoil",
  condition: "NONE",
  folderId: null,
  developer: false,
};

/**
 * How long a refused write waits before its one more try.
 *
 * `set_scanner_prefs` refuses only with `db::BUSY`, which is a sync holding the write connection
 * — seconds, not minutes. A second and a half is long enough for the ordinary tail of an ingest
 * and short enough that a reader who flips a switch and quits straight away still has it next
 * launch.
 */
export const PREFS_RETRY_MS = 1500;

export interface ScannerPrefsState {
  /** The prefs as the reader last left them — {@link SCANNER_PREFS_BEFORE_LOAD} until the row loads. */
  prefs: ScannerPrefs;
  /** The row has loaded **and** its filters have reached the session, accepted or refused. */
  loaded: boolean;
  /** Applied at once; persisted whole. A `filters` change persists only once the session takes it. */
  update: (patch: Partial<ScannerPrefs>) => void;
  /** The last `scanner_set_filters` refusal, in the crate's words, or `null`. */
  filterError: string | null;
}

function current(qc: QueryClient): ScannerPrefs {
  return qc.getQueryData<ScannerPrefs>(PREFS_KEY) ?? SCANNER_PREFS_BEFORE_LOAD;
}

/**
 * The scanner's `app_meta` row — its mode, filters, the tray's defaults and the Developer switch —
 * and the one place the filters meet the session.
 *
 * **The cache entry is the state.** Every change is a `setQueryData` on `["scanner", "prefs"]`
 * rather than a `useState` beside the query, so the page draws one value, and a view switch and
 * back finds the prefs as the reader left them even while a write is still refused. `staleTime`
 * and `gcTime` are both `Infinity` for that reason: nothing else writes this row, so a refetch
 * could only ever hand back an older copy of what is already here.
 *
 * **Filters are the one field that is not the reader's alone to set.** `scanner_set_filters` can
 * refuse — no corpus to read names from, or no printing surviving the narrowing — and a refused
 * filter is a session still searching under the filters it had. So a filter change is drawn at
 * once, sent, and on a refusal put back to the last filters the session accepted, with the
 * sentence exposed for the popover; and **the row never stores a filter the session has not
 * taken**, because the next launch would push the refusal straight back at the reader. That rule
 * is spelled once, in {@link persistable}: every write, whichever field it is about, carries the
 * accepted filters.
 *
 * **On mount the stored filters are pushed before `loaded` goes true**, which is what lets the
 * page hold its first frame until the scanner is narrowed the way the popover says. Per mount and
 * not per cache entry: the session is the crate's, and a pushed filter is cheap to push again.
 *
 * **A write that fails keeps the prefs in memory and says nothing.** `set_scanner_prefs` refuses
 * only with BUSY while a sync holds the write connection; the next change writes the whole row
 * again, and one more try after {@link PREFS_RETRY_MS} is what keeps a change nobody follows up.
 */
export function useScannerPrefs(): ScannerPrefsState {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: PREFS_KEY,
    queryFn: ipc.scannerPrefs,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const [filterError, setFilterError] = useState<string | null>(null);
  // Whether the stored filters have been answered by the session on this mount. State, because
  // `loaded` is drawn from it; set only from a promise's callback, never in an effect's body.
  const [synced, setSynced] = useState(false);

  /** The filters the session last accepted, or `null` before it has accepted any. */
  const acceptedRef = useRef<ScanFilters | null>(null);
  /** Whether any push has settled — after one has, "nothing accepted" means unrestricted. */
  const settledRef = useRef(false);
  /** Which push is the newest; an older answer arriving late changes nothing on screen. */
  const seqRef = useRef(0);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pushedOnMountRef = useRef(false);

  /**
   * The filters a write may carry: the accepted ones; before any push has settled, the stored
   * ones (writing them back is no change); and after a refusal with nothing accepted yet, none.
   */
  const persistable = useCallback((): ScanFilters => {
    if (acceptedRef.current !== null) return acceptedRef.current;
    if (settledRef.current) return NO_FILTERS;
    return current(qc).filters;
  }, [qc]);

  const persist = useCallback(() => {
    const write = () => ipc.setScannerPrefs({ ...current(qc), filters: persistable() });
    if (retryRef.current !== null) {
      clearTimeout(retryRef.current);
      retryRef.current = null;
    }
    write().catch(() => {
      // A newer write has already been sent and carries the whole row; this one is superseded.
      if (retryRef.current !== null) return;
      retryRef.current = setTimeout(() => {
        retryRef.current = null;
        // Once more and no further — a write still refused waits for the next change.
        write().catch(() => {});
      }, PREFS_RETRY_MS);
    });
  }, [qc, persistable]);

  const push = useCallback(
    (filters: ScanFilters, persistOnAccept: boolean) => {
      const seq = ++seqRef.current;
      ipc.scannerSetFilters(filters).then(
        () => {
          acceptedRef.current = filters;
          settledRef.current = true;
          if (seq !== seqRef.current) return;
          setFilterError(null);
          setSynced(true);
          if (persistOnAccept) persist();
        },
        (e: unknown) => {
          settledRef.current = true;
          if (seq !== seqRef.current) return;
          setFilterError(ipcError(e));
          setSynced(true);
          // Back to what the session is actually searching under. Drawn and never re-sent: the
          // session already holds it, and a second push's success would clear the sentence the
          // reader has not read yet.
          qc.setQueryData<ScannerPrefs>(PREFS_KEY, { ...current(qc), filters: persistable() });
        },
      );
    },
    [qc, persist, persistable],
  );

  // The stored filters, to the session, once per mount. Everything this sets it sets from the
  // promise's callbacks, so the effect's own body writes no state.
  const data = query.data;
  useEffect(() => {
    if (data === undefined || pushedOnMountRef.current) return;
    pushedOnMountRef.current = true;
    push(data.filters, false);
  }, [data, push]);

  const update = useCallback(
    (patch: Partial<ScannerPrefs>) => {
      qc.setQueryData<ScannerPrefs>(PREFS_KEY, { ...current(qc), ...patch });
      if (patch.filters !== undefined) push(patch.filters, true);
      else persist();
    },
    [qc, push, persist],
  );

  return {
    prefs: data ?? SCANNER_PREFS_BEFORE_LOAD,
    // A row that could not be read is the defaults, which is what the command itself answers for
    // one — so a failed read is loaded too, rather than a scanner that never starts.
    loaded: query.isError || (data !== undefined && synced),
    update,
    filterError,
  };
}
