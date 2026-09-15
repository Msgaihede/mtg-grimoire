import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import type { ScannerTrayRow } from "./types";

/** The cache entry the tray lives in. */
const TRAY_KEY = ["scanner", "tray"] as const;

/** Stable identity for "nothing scanned", so a consumer's memo does not see a new array each render. */
const EMPTY: readonly ScannerTrayRow[] = [];

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
  /** On screen now; persisted after {@link TRAY_QUIET_MS} of quiet, and on unmount. */
  setRows: (rows: ScannerTrayRow[]) => void;
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
  });

  const quietRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const write = useCallback(() => {
    const latest = () => qc.getQueryData<ScannerTrayRow[]>(TRAY_KEY) ?? [];
    if (retryRef.current !== null) {
      clearTimeout(retryRef.current);
      retryRef.current = null;
    }
    ipc.setScannerTray(latest()).catch(() => {
      // A newer write is already waiting to go, and it carries the whole tray.
      if (quietRef.current !== null || retryRef.current !== null) return;
      retryRef.current = setTimeout(() => {
        retryRef.current = null;
        // Once more and no further — a tray still refused waits for the next change.
        ipc.setScannerTray(latest()).catch(() => {});
      }, TRAY_RETRY_MS);
    });
  }, [qc]);

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
    setRows,
  };
}
