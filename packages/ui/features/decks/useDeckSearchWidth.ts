import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_PANEL_WIDTH_PX } from "@/features/search/CardSearchPanel";
import { ipc } from "@/lib/ipc";

/**
 * Where a deck's card search column keeps the width the reader dragged it to (issue #932).
 *
 * Exported for `HIDDEN_STACKS_KEY`'s reason: a test or a story that wants a deck to open with its
 * column already dragged seeds the cache rather than mocking the command. Per window, and on
 * `lib/crossWindow.ts`' `PER_WINDOW_KEYS`; **deliberately not under `["decks"]`**, which every
 * deck write invalidates — a refetch landing mid-drag would snap the column back for a frame.
 */
export const DECK_SEARCH_WIDTH_KEY = ["deckSearchWidth"];

const deckSearchWidthKey = (deckId: number) => [...DECK_SEARCH_WIDTH_KEY, deckId];

/**
 * How long the drag has to go quiet before the width is written, in ms —
 * `FOLDER_WIDTH_WRITE_DELAY_MS`' number and its reason: a drag is a stream of `pointermove`s, and
 * writing per event would put dozens of read-modify-writes of one row through the write connection
 * for values that were obsolete before they committed.
 */
export const DECK_SEARCH_WIDTH_WRITE_DELAY_MS = 400;

const query = (deckId: number) => ({
  queryKey: deckSearchWidthKey(deckId),
  queryFn: () => ipc.deckSearchWidth(deckId),
  // Read once per deck per window. Every change goes through the write below, which puts the
  // answer straight into the cache, so there is nothing to go stale against — and `gcTime:
  // Infinity` keeps a refused write's width for the session, `useFolderPane`'s reason.
  staleTime: Infinity,
  gcTime: Infinity,
});

/**
 * Start the read when the **editor** mounts rather than when the column does.
 *
 * The column mounts only once `deck_get` has answered, so a read started there is always a frame
 * or more behind it and the column would draw at {@link DEFAULT_PANEL_WIDTH_PX} and then jump to
 * the reader's width — `usePrefetchSearchOpen`'s measured failure in miniature. Started beside
 * `deck_get`, the one `app_meta` row has answered long before the deck has. A failure is swallowed:
 * {@link useDeckSearchWidth}'s own query asks again.
 */
export function usePrefetchDeckSearchWidth(deckId: number): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    void queryClient.prefetchQuery(query(deckId)).catch(() => {});
  }, [queryClient, deckId]);
}

/**
 * The width one deck's card search column is drawn at, remembered per deck and across restarts.
 *
 * `useFolderPane`'s shape for a width alone: an optimistic `setQueryData` on every drag step so the
 * edge follows the pointer, a trailing {@link DECK_SEARCH_WIDTH_WRITE_DELAY_MS} write of whatever
 * the cache holds then, and no rollback — a BUSY answer under a sync keeps the reader's width for
 * this session and costs only the next launch's.
 *
 * **One difference from `useFolderPane`: a pending write is flushed on unmount, not dropped.** The
 * editor is keyed by deck id, so leaving a deck unmounts this hook while the app goes on running —
 * a reader who drags and then opens another deck inside 400ms has a write to make, and the process
 * is still there to make it.
 *
 * **A drag is drawn from this hook's own state, and the cache is only where it is kept.** Query
 * delivers a `setQueryData` to its observers a tick later, which is a frame of the edge lagging
 * the pointer — and the column drew the drag synchronously for as long as it was a `useState` in
 * `CardSearchPanel`, which its suite holds it to. So a drag writes both, and draws the first.
 *
 * **What is read back is the reader's width, never clamped here.** The floor and the cap are
 * `CardSearchPanel`'s, against a row this hook never measures; clamping here would store one
 * narrow window's squeeze.
 */
export function useDeckSearchWidth(deckId: number): {
  /** The width to draw, in px — the reader's, or the default for a deck nobody has dragged. */
  width: number;
  setWidth: (width: number) => void;
} {
  const queryClient = useQueryClient();
  const stored = useQuery(query(deckId)).data;
  // The width dragged in this mount, drawn ahead of the cache — see the hook's doc.
  const [dragged, setDragged] = useState<number | undefined>(undefined);

  const write = useMutation({
    mutationFn: (width: number) => ipc.setDeckSearchWidth(deckId, width),
    // One write at a time, in drag order.
    scope: { id: "deckSearchWidth" },
  });
  const startWrite = write.mutate;

  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Read the cache at the moment of the write, never the value the timer was scheduled with, so
  // what is stored is whatever the reader settled on.
  const flush = useCallback(() => {
    const width = queryClient.getQueryData<number | null>(deckSearchWidthKey(deckId));
    // Rounded because the crate takes a whole number of pixels and a pointer reports fractions.
    if (typeof width === "number" && Number.isFinite(width)) startWrite(Math.round(width));
  }, [queryClient, deckId, startWrite]);

  const setWidth = useCallback(
    (width: number) => {
      setDragged(width);
      queryClient.setQueryData(deckSearchWidthKey(deckId), width);
      clearTimeout(pending.current);
      pending.current = setTimeout(() => {
        pending.current = undefined;
        flush();
      }, DECK_SEARCH_WIDTH_WRITE_DELAY_MS);
    },
    [queryClient, deckId, flush],
  );

  // The flush on unmount — see the hook's doc. A ref so the cleanup runs once, on unmount, with
  // the latest `flush` rather than on every change of it.
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);
  useEffect(
    () => () => {
      if (pending.current === undefined) return;
      clearTimeout(pending.current);
      pending.current = undefined;
      flushRef.current();
    },
    [],
  );

  return {
    // `null` (never dragged), a read in flight or failed, and a value that could never be a width
    // all draw the default.
    width:
      dragged ??
      (typeof stored === "number" && Number.isFinite(stored) && stored > 0
        ? stored
        : DEFAULT_PANEL_WIDTH_PX),
    setWidth,
  };
}
