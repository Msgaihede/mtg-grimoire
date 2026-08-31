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
    // **No target gate any more**, and its removal is the point rather than a tidy-up.
    // `update_history` is routed by `web::route` since 2026-08-31 and answers on every
    // target: two `app_meta` reads and no network, which is what its Rust doc has always
    // said. In a browser it answers `[]` — only `update_check` ever writes that row, and
    // `app_meta` is not one of the synced tables — which is the same "never fetched" state
    // the Tagger models, and `UpdatePanel` draws no history section there anyway.
    //
    // This hook read `enabled: !isWebTarget()` until then, added by PR #315 because the call
    // was printing `unknown command` on the Settings page. A build-time constant standing in
    // for an answer the backend could not give is exactly what that PR's own write-up named
    // as the general lesson; the backend gives it now.
    // The list a reader is looking at stays on screen while the next one is read. Without
    // this a moving key is `isPending` again, so pressing Check now — or merely the first
    // status landing after the panel mounts — would replace the history with "Reading the
    // version history…" and back, for a local `app_meta` read that takes no time.
    placeholderData: (previous) => previous,
  });

  return {
    releases: query.data ?? NONE,
    // **`fetchStatus`, not `isPending` alone.** A query that is disabled stays `pending`
    // for ever in TanStack v5 — it has no data and never will — so the plain read reports
    // "loading" permanently for one. `idle` is what tells the two apart: nothing is in
    // flight and nothing is going to be.
    //
    // **Kept after the `enabled` gate above was removed**, and deliberately: this is the
    // correct reading of "is something in flight" whether or not anything is currently
    // disabling the query, and the day one is again — a paused query, a suspended tab — the
    // plain `isPending` would put "Reading the version history…" on screen for ever.
    loading: query.isPending && query.fetchStatus !== "idle",
    /** Why the history could not be read. A failed *check* is the update panel's own line. */
    error: query.error ? ipcError(query.error) : null,
  };
}

export type ReleaseHistory = ReturnType<typeof useReleaseHistory>;
