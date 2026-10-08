import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { DEFAULT_PRINTING_GROUP_BY, isPrintingGroupBy, type PrintingGroupBy } from "./printings";

/**
 * Where the reader's grouping choice is kept for the life of the window.
 *
 * Exported for the same reason `MARKETPLACE_KEY` is: a test or a story that wants the pane to
 * open already grouped by set seeds the cache rather than mocking the command, and a key spelled
 * twice is a key that drifts.
 */
export const PRINTING_GROUP_BY_KEY = ["printingGroupBy"];

/**
 * How the card pane's printings list is grouped — remembered across cards and across restarts.
 *
 * TanStack Query rather than the zustand store, and rather than a `useState` in the pane, for
 * the two reasons `useMarketplace` gives: `store.ts` scopes itself to UI state and hands
 * anything backed by the database to Query, and this setting lives in `app_meta` so it outlives
 * the process. The cache is also what makes it survive a *card*: the pane's body is keyed on the
 * card id, so browsing from one printing to another throws this hook away and mounts a new one —
 * and a new observer over a resolved query is a read of the cache, not a round trip. A
 * `useState` here would reset the list to Artist on every row the reader clicked.
 *
 * **A read that fails is the default, never an error.** Nothing here surfaces `isError` and
 * nothing branches on it: a preference that cannot be read is not worth breaking a card pane
 * over, and the visible symptom of doing so would be a grey unsorted list under a card the
 * reader can otherwise see perfectly well. The stored value is narrowed rather than trusted —
 * the row is a string written by some build of this app, and a mode this build has never heard
 * of ({@link isPrintingGroupBy} says no) is the default too, by the same argument.
 *
 * **The write is optimistic, and it is deliberately not rolled back.** The cache is written
 * before the command is sent, so the list re-orders on the press rather than a round trip later —
 * the whole point of the control is that the reader is hunting through forty printings and wants
 * a different order *now*. And the command can legitimately fail: `set_printing_group_by` answers
 * `BUSY` while a sync holds the write connection, which is a state the app spends whole minutes
 * in on a first run. Undoing the reader's choice under their hand in that window would be the
 * worst of both — the order they asked for flicking back, with nothing on screen saying why, in
 * a pane whose only real job is showing a card. So a refused write keeps the chosen mode for
 * this session and says nothing; what is lost is only that the next launch opens on the mode
 * before it. There is no `onError` and nothing calls `mutateAsync`, so the rejection is settled
 * inside the mutation and never reaches a boundary.
 *
 * `gcTime: Infinity` is what makes "for this session" literal rather than a five-minute
 * accident. Without it the entry is collected once the last pane closes, and a card opened six
 * minutes later would re-read `app_meta` and get the value the refused write never stored — the
 * rollback this hook refuses to do, arriving late.
 */
export function usePrintingGroupBy(): {
  mode: PrintingGroupBy;
  setMode: (mode: PrintingGroupBy) => void;
} {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: PRINTING_GROUP_BY_KEY,
    queryFn: () => ipc.printingGroupBy(),
    // Read once per app run. Nothing else writes this row, so there is nothing to go stale
    // against — every change to it goes through the mutation below, which writes the answer
    // straight into the cache.
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const write = useMutation({
    mutationFn: (mode: PrintingGroupBy) => ipc.setPrintingGroupBy(mode),
  });

  const startWrite = write.mutate;
  const setMode = useCallback(
    (mode: PrintingGroupBy) => {
      // The optimistic half. `setQueryData` before `mutate`, not in an `onMutate`: the two are
      // the same commit either way, and doing it here says outright that the cache is the
      // reader's choice and the command is only how it is remembered.
      queryClient.setQueryData(PRINTING_GROUP_BY_KEY, mode);
      startWrite(mode);
    },
    [queryClient, startWrite],
  );

  const stored = query.data;
  return {
    // Narrowed on the way out rather than on the way in, so the optimistic write above cannot
    // put anything through here that this build does not understand either.
    mode: stored !== undefined && isPrintingGroupBy(stored) ? stored : DEFAULT_PRINTING_GROUP_BY,
    setMode,
  };
}
