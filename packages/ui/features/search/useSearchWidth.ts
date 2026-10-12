import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { DEFAULT_PANEL_WIDTH_PX } from "./CardSearchPanel";
import type { SearchSection } from "./useSearchOpen";

/**
 * Where the reader's dragged widths for the docked panels are kept for the life of the window —
 * `SEARCH_OPEN_KEY`'s sibling, over `app_meta.search_width` (one map, keyed by section).
 *
 * Exported so a test or a story that wants a panel to open at a width seeds the cache rather than
 * mocking the command.
 */
export const SEARCH_WIDTH_KEY = ["searchWidth"];

/**
 * How long a drag has to go quiet before the width is written, in ms — `useFolderPane`'s
 * `FOLDER_WIDTH_WRITE_DELAY_MS`, for its reason: a drag is a stream of `pointermove`s, and a
 * write per event would be a run of read-modify-writes of one row for values that were obsolete
 * before they committed. The tail it costs is a width settled on in the last 400ms before exit.
 */
export const SEARCH_WIDTH_WRITE_DELAY_MS = 400;

/** Read once per app run: nothing else writes this row, and every change goes through the
 *  mutation below, which writes the answer straight into the cache. */
const QUERY = {
  queryKey: SEARCH_WIDTH_KEY,
  queryFn: () => ipc.searchWidth(),
  staleTime: Infinity,
  gcTime: Infinity,
};

/**
 * Ask for the stored widths **at launch**, so a panel never draws at the default and then jumps
 * to the reader's width — `usePrefetchSearchOpen`'s measured 700ms flash, one row over.
 * `AppShell` is the one caller; a failure is swallowed, and {@link useSearchWidth} asks again.
 */
export function usePrefetchSearchWidth(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    void queryClient.prefetchQuery(QUERY).catch(() => {});
  }, [queryClient]);
}

/**
 * How wide one docked panel was last dragged — remembered across pages and restarts (issue #937:
 * the search page's tag sidebar opens at the size the reader left it).
 *
 * `useFolderPane`'s shape: the write is optimistic and debounced, never rolled back (a `BUSY`
 * under a sync keeps the reader's width for this session and says nothing), and a read that fails
 * or holds something that is not a usable width answers the default. **The floor and the cap are
 * not applied here**: they are facts about the row the panel is drawn in, which `CardSearchPanel`
 * clamps at draw time — clamping the stored value would make one narrow window permanent.
 */
export function useSearchWidth(section: SearchSection): {
  width: number;
  setWidth: (width: number) => void;
} {
  const queryClient = useQueryClient();
  const query = useQuery(QUERY);
  const write = useMutation({
    mutationFn: (width: number) => ipc.setSearchWidth(section, width),
  });
  const startWrite = write.mutate;
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const setWidth = useCallback(
    (width: number) => {
      const px = Math.round(width);
      // Only this section is touched, so a drag here never carries a stale answer for another
      // panel back into the cache — `useSearchOpen`'s spread, for its reason.
      queryClient.setQueryData(SEARCH_WIDTH_KEY, (stored: Record<string, number> | undefined) => ({
        ...stored,
        [section]: px,
      }));
      clearTimeout(pending.current);
      pending.current = setTimeout(() => {
        pending.current = undefined;
        // Read at the moment of the write, never captured when it was scheduled.
        const latest = queryClient.getQueryData<Record<string, number>>(SEARCH_WIDTH_KEY)?.[
          section
        ];
        if (typeof latest === "number") startWrite(latest);
      }, SEARCH_WIDTH_WRITE_DELAY_MS);
    },
    [queryClient, section, startWrite],
  );

  useEffect(
    () => () => {
      // A pending timer would fire into a page that is going away — and, in a test, into the
      // next one.
      clearTimeout(pending.current);
      pending.current = undefined;
    },
    [],
  );

  const stored = query.data?.[section];
  return {
    width:
      typeof stored === "number" && Number.isFinite(stored) && stored > 0
        ? stored
        : DEFAULT_PANEL_WIDTH_PX,
    setWidth,
  };
}
