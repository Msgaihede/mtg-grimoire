/**
 * Somebody else's shared collection, fetched from its link.
 *
 * **No membership and no token** (spec §9): viewing is open to everyone and the link is the whole
 * of the capability, so this hook is live on an installation that has connected nothing.
 */
import { skipToken, useQuery, type QueryKey } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { parseSnapshotValue, type ShareSnapshot } from "@/lib/shareSnapshot";
import { SHARE_KEY } from "./useShares";

/** One fetched binder, under the share root so a revoke can invalidate the lot. */
export const shareSnapshotKey = (url: string): QueryKey => [...SHARE_KEY, "snapshot", url];

/**
 * The snapshot behind `url`, or the sentence that says why there is none.
 *
 * Three things about the shape are decisions rather than defaults:
 *
 * * **`parseSnapshotValue`, never `parseSnapshot(JSON.stringify(v))`.** `ipc.shareOpen` answers
 *   `unknown` because the crate answers `serde_json::Value` — spec §10 wants a snapshot from a
 *   newer build *told about* rather than refused at the wrong layer — so the value is already
 *   parsed when it arrives here. Re-serialising it is a full JSON round trip over what a
 *   50 000-card binder weighs (2.07 MB measured) to learn nothing new.
 * * **`staleTime: Infinity`.** A snapshot does not change on its own: it is what the publisher
 *   uploaded, and it changes when they publish again and not before. Refetching on a remount
 *   would spend the publisher's Worker requests to be handed the same document. The view offers
 *   a *Check for an update* press, which is `refetch()`.
 * * **`retry: false`**, against the app's default of one. Every refusal the crate returns is a
 *   sentence and every one of them is terminal — withdrawn, no longer available, not a shared
 *   collection link, not finished publishing — so a retry buys a second request to be told the
 *   same thing, and doubles the delay before the reader is told anything.
 */
export function useSharedSnapshot(url: string | null) {
  return useQuery<ShareSnapshot>(
    url === null
      ? // A stable key for the nothing-open case; `skipToken` means nothing is ever filed under it.
        { queryKey: shareSnapshotKey(""), queryFn: skipToken }
      : sharedSnapshotQuery(url),
  );
}

/**
 * The same query as an options object, for the paste dialog's `fetchQuery`.
 *
 * **One definition rather than two call sites agreeing.** The dialog opens a link by *fetching*
 * it — a link that never answers is not a binder the reader has opened, so the refusal belongs
 * beside the box they typed it into — and the snapshot it fetches is the one the view then draws.
 * Written twice, the two would be free to disagree about `staleTime`, and the dialog's fetch
 * would land in the cache under options the view's own `useQuery` then replaced: the view would
 * refetch a document it had just been handed.
 */
export function sharedSnapshotQuery(url: string) {
  return {
    queryKey: shareSnapshotKey(url),
    queryFn: async (): Promise<ShareSnapshot> => parseSnapshotValue(await ipc.shareOpen(url)),
    staleTime: Infinity,
    retry: false,
  };
}
