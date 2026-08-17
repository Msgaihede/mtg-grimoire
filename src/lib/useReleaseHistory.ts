import { useQuery } from "@tanstack/react-query";
import { ipc, ipcError, type ReleaseNote } from "@/lib/ipc";

/** Stable identity for "no history", so a render with no releases is not a new array. */
const NONE: ReleaseNote[] = [];

/**
 * Every release the last update check saw, newest first.
 *
 * **Not polled, and never a network call of its own** — `useErrorLog`'s reasoning arrived at
 * from a different direction. `update_check` fetches one page of `/repos/…/releases` to
 * decide whether an update exists and caches the whole page in `app_meta`; this reads that
 * row. So the history is as fresh as the last check and no fresher, which is the honest
 * relationship: a changelog the app has not been told about does not exist yet.
 *
 * `lastCheckAt` is in the query key rather than being a parameter of the call, which is what
 * makes "Check now" refresh the list: the check writes a new timestamp, the key moves, and
 * TanStack refetches. Nothing here has to know what the button did.
 */
export function useReleaseHistory(lastCheckAt: string | null) {
  const query = useQuery({
    queryKey: ["releaseHistory", lastCheckAt],
    queryFn: () => ipc.updateHistory(),
    // The list a reader is looking at stays on screen while the next one is read. Without
    // this a moving key is `isPending` again, so pressing Check now — or merely the first
    // status landing after the panel mounts — would replace the history with "Reading the
    // version history…" and back, for a local `app_meta` read that takes no time.
    placeholderData: (previous) => previous,
  });

  return {
    releases: query.data ?? NONE,
    loading: query.isPending,
    /** Why the history could not be read. A failed *check* is the update panel's own line. */
    error: query.error ? ipcError(query.error) : null,
  };
}

export type ReleaseHistory = ReturnType<typeof useReleaseHistory>;
