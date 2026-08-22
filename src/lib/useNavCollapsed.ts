import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";

/**
 * Where the rail's collapsed state is kept for the life of the window.
 *
 * Exported for the same reason `PRINTING_GROUP_BY_KEY` is: a test or a story that wants the
 * shell to open already collapsed seeds the cache rather than mocking the command, and a key
 * spelled twice is a key that drifts.
 */
export const NAV_COLLAPSED_KEY = ["navCollapsed"];

/**
 * Whether the global navigation rail is collapsed — remembered across restarts.
 *
 * TanStack Query rather than the zustand store, for `usePrintingGroupBy`'s reason: `store.ts`
 * scopes itself to UI state and hands anything backed by the database to Query, and this setting
 * is one `app_meta` row that outlives the process. The cache is where the value *lives* — there
 * is no second home for it to be copied into. `AppShell` draws both the rail and the control
 * that folds it, so the query has exactly one subscriber and that subscriber is the thing the
 * value is about.
 *
 * **That is also why this is not shaped like `useCardZoomPersistence`**, the one stored
 * preference here that is deliberately not a query. Its argument is that `cardZoom` has to be in
 * the store — a wheel handler steps it fifty times a second and five walls read it during layout
 * — so a query there would be a cache entry with one consumer that copies its answer somewhere
 * else and is never read again, a launch-time seed wearing a cache's clothes. Every clause of
 * that points the other way here: one boolean, flipped by a deliberate press, read by the one
 * component that draws it, with nowhere else to be copied to.
 *
 * **A read that fails is `false` — the rail expanded — and never an error.** Nothing here
 * surfaces `isError` and nothing branches on it: `nav_collapsed` is infallible at the far end,
 * where a missing row, a junk row and an unreadable one all answer `false`, so the only failures
 * left are the IPC boundary itself and a `BUSY` under a sync. None of those is worth a shell that
 * will not draw, and the whole cost of falling back is a rail that opens wide on a launch it
 * would have opened narrow.
 *
 * **The write is optimistic, and it is deliberately not rolled back.** The cache is written
 * before the command is sent, so the rail moves on the press rather than a round trip later —
 * a fold is a direct manipulation, and a control that answers late reads as a control that did
 * not take. And the command can legitimately fail: `set_nav_collapsed` answers `BUSY` while a
 * sync holds the write connection, which is a state the app spends whole minutes in on a first
 * run. Snapping the rail back open under the reader's hand in that window, with nothing on
 * screen saying why, is worse than losing one launch's memory of it. So a refused write keeps
 * the reader's choice for this session and says nothing. There is no `onError` and nothing calls
 * `mutateAsync`, so the rejection settles inside the mutation and never reaches a boundary.
 *
 * `gcTime: Infinity` is what makes "for this session" literal rather than a five-minute
 * accident: the shell never unmounts, but a collected entry would re-read `app_meta` and get
 * the value the refused write never stored — the rollback this hook refuses to do, arriving
 * late.
 */
export function useNavCollapsed(): {
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
} {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: NAV_COLLAPSED_KEY,
    queryFn: () => ipc.navCollapsed(),
    // Read once per app run. Nothing else writes this row, so there is nothing to go stale
    // against — every change to it goes through the mutation below, which writes the answer
    // straight into the cache.
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const write = useMutation({
    mutationFn: (collapsed: boolean) => ipc.setNavCollapsed(collapsed),
  });

  const startWrite = write.mutate;
  const setCollapsed = useCallback(
    (collapsed: boolean) => {
      // The optimistic half. `setQueryData` before `mutate`, not in an `onMutate`: the two are
      // the same commit either way, and doing it here says outright that the cache is the
      // reader's choice and the command is only how it is remembered.
      queryClient.setQueryData(NAV_COLLAPSED_KEY, collapsed);
      startWrite(collapsed);
    },
    [queryClient, startWrite],
  );

  const stored = query.data;
  return {
    // `undefined` is the read that has not answered yet *and* the read that failed, and both
    // mean the same thing to the shell: draw the rail open. There is nothing to narrow beyond
    // that — a boolean has no vocabulary a newer build could have widened.
    collapsed: stored ?? false,
    setCollapsed,
  };
}
