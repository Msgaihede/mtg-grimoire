import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { registerUnsavedCheck } from "@/lib/crossWindow";
import { ipc, ipcError } from "@/lib/ipc";
import type { ScanFilters, ScannerPrefs } from "./types";
import { SCANNER_ELSEWHERE_KEY, SCANNER_ELSEWHERE_POLL_MS } from "./useScannerElsewhere";
import { refusalPasses, SCANNER_OPEN_ELSEWHERE } from "./verdictText";

/** The one cache entry the prefs live in — the query's key and every write's. */
const PREFS_KEY = ["scanner", "prefs"] as const;

/**
 * This client's prefs writes: how many are on the wire, a number for the newest one sent, a refused
 * write's next try if it is waiting, and whether the newest write was refused with nothing landed
 * since.
 *
 * **Per query client rather than per mount**, `useTray`'s queue's reason: the view that scheduled
 * a retry is usually gone by the time it runs, and `crossWindow.ts` asks about a client, not a
 * mount. Writes here are not single-flight, so `sent` is what lets an older write answering late
 * leave the newest one's answer standing.
 */
interface PrefsWrites {
  inFlight: number;
  sent: number;
  retry: ReturnType<typeof setTimeout> | null;
  refused: boolean;
}
const prefsWrites = new WeakMap<QueryClient, PrefsWrites>();

function writesFor(qc: QueryClient): PrefsWrites {
  let writes = prefsWrites.get(qc);
  if (writes === undefined) {
    writes = { inFlight: 0, sent: 0, retry: null, refused: false };
    prefsWrites.set(qc, writes);
  }
  return writes;
}

/**
 * **Whether this client's prefs hold a change the store has not confirmed** — what `crossWindow.ts`
 * asks before it drops an idle prefs entry on another window's `app_meta` change. A write on the
 * wire, a try waiting, or the newest write refused with nothing landed since: a sync or another
 * window's lease keeps the first two true for as long as it lasts, and the last is a refusal no
 * wait changes, after its one more try — `useTray`'s `hasUnsavedTray` has the whole case.
 */
function hasUnsavedPrefs(qc: QueryClient): boolean {
  const writes = prefsWrites.get(qc);
  return writes !== undefined && (writes.inFlight > 0 || writes.retry !== null || writes.refused);
}
registerUnsavedCheck(PREFS_KEY, hasUnsavedPrefs);

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
 * How long a refused write waits before it is tried again.
 *
 * `set_scanner_prefs` refuses with `db::BUSY` while a sync holds the write connection and with
 * `OPEN_ELSEWHERE` while another window holds the scanner. A second and a half is long enough for
 * the ordinary tail of an ingest and short enough that a reader who flips a switch and quits
 * straight away still has it next launch. **It is also what holds the lease**: every try admits
 * this window first, so it has to stay under `scanner::LEASE`'s two seconds for a window with an
 * unsaved change to keep the scanner through a sync that runs for minutes.
 */
export const PREFS_RETRY_MS = 1500;

export interface ScannerPrefsState {
  /** The prefs as the reader last left them — {@link SCANNER_PREFS_BEFORE_LOAD} until the row loads. */
  prefs: ScannerPrefs;
  /** The row has loaded **and** its filters have reached the session, accepted or refused. */
  loaded: boolean;
  /** Applied at once; persisted whole. A `filters` change persists only once the session takes it. */
  update: (patch: Partial<ScannerPrefs>) => void;
  /**
   * The last `scanner_set_filters` refusal, in the crate's words, or `null` — never the lease's,
   * which is about another window rather than about the filters.
   */
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
 * and `gcTime` are both `Infinity` for that reason: only the window holding the scanner writes this
 * row — every write takes its lease — so a refetch could only ever hand back an older copy of what
 * is already here. Another window's `app_meta` change drops the entry once the view has gone, and
 * only once {@link hasUnsavedPrefs} says nothing in it is waiting to be stored.
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
 * with BUSY while a sync holds the write connection and with `OPEN_ELSEWHERE` while another window
 * holds the scanner, and neither is about the prefs: nothing reverts, the next change writes the
 * whole row again, and **the write is tried every {@link PREFS_RETRY_MS} until it lands** — through
 * a sync that runs for minutes, each try renewing this window's lease — which is what keeps a
 * change nobody follows up. A refusal no wait changes gets one more try and no further. **No write
 * stores what is not there**: each reads the cache as it goes out, and with
 * no entry — the view gone, the entry dropped — it is skipped rather than storing the defaults
 * {@link current} draws before a load.
 *
 * **A push the scanner's lease refuses is not answered at all.** `scanner_set_filters` also
 * refuses with `OPEN_ELSEWHERE` while another window holds the scanner, and that says nothing about
 * these filters. Treated as an ordinary refusal it put the filters back to none in a cache that
 * outlives the view, so the next visit pushed none and the next write stored none over the row. So
 * that refusal reverts nothing, marks nothing settled, keeps `loaded` false — no frame goes out
 * under filters the session does not have — and puts no sentence in the popover. It asks the
 * scanner gate again instead, which is what tells the reader and unmounts this view; and in case
 * the other window let go in between and the view stays, the push goes out again each
 * {@link SCANNER_ELSEWHERE_POLL_MS} — while mounted and never after, since an accepted push is the
 * lease, taken.
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
  const pushedOnMountRef = useRef(false);
  /** A push the lease refused, waiting to go out again; cleared by a newer push and on unmount. */
  const elsewhereRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Whether the view is still here — a refusal landing after it has gone schedules nothing. */
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (elsewhereRef.current !== null) clearTimeout(elsewhereRef.current);
      elsewhereRef.current = null;
    };
  }, []);

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
    const writes = writesFor(qc);
    /** The row as the cache holds it when this goes out — or nothing, with no cache to hold it. */
    const write = (): Promise<void> => {
      const cached = qc.getQueryData<ScannerPrefs>(PREFS_KEY);
      if (cached === undefined) {
        // Nothing is held here any more, so nothing held here is unsaved.
        writes.refused = false;
        return Promise.resolve();
      }
      const seq = ++writes.sent;
      writes.inFlight += 1;
      return ipc.setScannerPrefs({ ...cached, filters: persistable() }).then(
        () => {
          writes.inFlight -= 1;
          if (seq === writes.sent) writes.refused = false;
        },
        (e: unknown) => {
          writes.inFlight -= 1;
          if (seq === writes.sent) writes.refused = true;
          throw e;
        },
      );
    };
    /**
     * After a refused write: nothing more once a newer write has gone out, since it carries the
     * whole row and is trying on its own account; another try after {@link PREFS_RETRY_MS} for as
     * long as the refusal is one that passes, each on its own interval, so the loop can never run
     * faster than that; and one more try, no further, for any other refusal. At most one try is
     * ever waiting — `writes.retry` is a single slot, and a newer change clears it.
     */
    const settle = (e: unknown, seq: number, retried: boolean) => {
      if (seq !== writes.sent || writes.retry !== null) return;
      if (retried && !refusalPasses(ipcError(e))) return;
      writes.retry = setTimeout(() => {
        writes.retry = null;
        attempt(true);
      }, PREFS_RETRY_MS);
    };
    /** One write, and what follows it if it is refused. `write` numbers it synchronously. */
    const attempt = (retried: boolean) => {
      const going = write();
      const seq = writes.sent;
      going.catch((e: unknown) => settle(e, seq, retried));
    };
    if (writes.retry !== null) {
      clearTimeout(writes.retry);
      writes.retry = null;
    }
    attempt(false);
  }, [qc, persistable]);

  const push = useCallback(
    (filters: ScanFilters, persistOnAccept: boolean) => {
      const send = () => {
        const seq = ++seqRef.current;
        // A newer push supersedes one the lease turned away that is still waiting to go again.
        if (elsewhereRef.current !== null) {
          clearTimeout(elsewhereRef.current);
          elsewhereRef.current = null;
        }
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
            const sentence = ipcError(e);
            if (sentence === SCANNER_OPEN_ELSEWHERE) {
              // Another window holds the scanner: not an answer about these filters, so nothing
              // below happens — see the hook's doc. Ask the gate again, and send again later.
              if (seq !== seqRef.current || !mountedRef.current) return;
              void qc.invalidateQueries({ queryKey: SCANNER_ELSEWHERE_KEY });
              elsewhereRef.current = setTimeout(send, SCANNER_ELSEWHERE_POLL_MS);
              return;
            }
            settledRef.current = true;
            if (seq !== seqRef.current) return;
            setFilterError(sentence);
            setSynced(true);
            // Back to what the session is actually searching under. Drawn and never re-sent: the
            // session already holds it, and a second push's success would clear the sentence the
            // reader has not read yet. With no entry left there is nothing to put back, and
            // `current()`'s defaults put in its place would be what the next visit draws.
            const cached = qc.getQueryData<ScannerPrefs>(PREFS_KEY);
            if (cached !== undefined) {
              qc.setQueryData<ScannerPrefs>(PREFS_KEY, { ...cached, filters: persistable() });
            }
          },
        );
      };
      send();
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
