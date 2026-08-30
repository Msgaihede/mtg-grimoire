import { useQuery } from "@tanstack/react-query";
import { ipc, ipcError, type ReleaseNote } from "@/lib/ipc";
import { isWebTarget } from "@/pwa/target";

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
    // **Never on the web target**, where `update_history` is one of the commands §6.3 keeps
    // desktop-only: a PWA updates through its service worker, so there is no portable `.exe`
    // whose releases this would list. Driven on the phone 2026-08-30, this was the *only*
    // `unknown command` left in the app after PR 10 — printed on the Settings page, where the
    // documented behaviour is that those commands are hidden rather than broken.
    //
    // `enabled` rather than a caller-side `if`, because the hook is called unconditionally by
    // `SettingsPage` and this is the same shape `useWebStorage` already has one line away:
    // inert on the target it does not apply to, and a build-time constant deciding it.
    enabled: !isWebTarget(),
    // The list a reader is looking at stays on screen while the next one is read. Without
    // this a moving key is `isPending` again, so pressing Check now — or merely the first
    // status landing after the panel mounts — would replace the history with "Reading the
    // version history…" and back, for a local `app_meta` read that takes no time.
    placeholderData: (previous) => previous,
  });

  return {
    releases: query.data ?? NONE,
    // **`fetchStatus`, not `isPending` alone.** A query that is `enabled: false` stays
    // `pending` for ever in TanStack v5 — it has no data and never will — so the plain read
    // would report "loading" permanently on the web target. `idle` is what tells the two
    // apart: nothing is in flight and nothing is going to be.
    loading: query.isPending && query.fetchStatus !== "idle",
    /** Why the history could not be read. A failed *check* is the update panel's own line. */
    error: query.error ? ipcError(query.error) : null,
  };
}

export type ReleaseHistory = ReturnType<typeof useReleaseHistory>;
