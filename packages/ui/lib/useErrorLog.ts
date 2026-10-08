import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, ipcError, type ErrorEntry } from "@/lib/ipc";

/** Stable identity for "nothing has failed", so a render with no rows is not a new array. */
const NONE: ErrorEntry[] = [];

/** How many rows the panel asks for. The backend caps at 200; this is what a person will
 *  scroll. A row is a *fault*, not an occurrence — repeats fold — so fifty is a lot. */
export const ERROR_LOG_LIMIT = 50;

/**
 * The error log, and the one write the UI can make to it.
 *
 * **Not polled.** Every other status surface in this app polls because it describes
 * something in flight; this one describes things that have already happened, and a panel
 * that reshuffled itself while being read would be worse at its one job. It loads when
 * Settings opens and refetches after a clear, which is when the answer can actually differ.
 */
export function useErrorLog() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["errorLog", ERROR_LOG_LIMIT],
    queryFn: () => ipc.errorLogList(ERROR_LOG_LIMIT),
  });

  const clear = useMutation({
    mutationFn: () => ipc.errorLogClear(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["errorLog"] }),
  });

  return {
    entries: query.data ?? NONE,
    loading: query.isPending,
    /** Why the log itself could not be read — which is its own small irony, and still has to
     *  be sayable. A refused clear reports here too; they are one line in the panel. */
    error: query.error ? ipcError(query.error) : clear.error ? ipcError(clear.error) : null,
    clear: () => clear.mutate(),
    clearing: clear.isPending,
  };
}

export type ErrorLog = ReturnType<typeof useErrorLog>;
