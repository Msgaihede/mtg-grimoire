/**
 * The shares this group has published, as the app has them cached.
 *
 * **`share_list` is the only one of the five commands that reconciles against the relay before
 * answering**, and a failure — or no membership at all — answers the local cache instead. So
 * this is a read that is allowed to be offline and never one that reports being offline; a
 * caller draws whatever comes back.
 */
import { useQuery, type QueryKey } from "@tanstack/react-query";
import { ipc, type ShareRow } from "@/lib/ipc";

/**
 * The root everything about sharing is filed under.
 *
 * Declared here rather than in `@/lib/query` because the surfaces that write to it — the
 * cabinet's Share control, and anything that revokes — already import this hook, so there is no
 * pair of files agreeing on a string literal without one importing the other. That is
 * `COMBOS_KEY`'s rule met, rather than skipped: what it forbids is two features spelling one
 * prefix two ways.
 *
 * `invalidateQueries` matches by prefix, so a publish or a revoke invalidates this and reaches
 * both the list and every fetched snapshot under it.
 */
export const SHARE_KEY: QueryKey = ["share"];

/** The group's published shares — `ipc.shareList`. */
export const SHARE_LIST_KEY: QueryKey = ["share", "list"];

/**
 * Every share the group has published, newest answer the relay gave or the local cache.
 *
 * ⚠️ **`enabled` is required rather than defaulted, and it is about the _write connection_
 * rather than about what the control draws.**
 *
 * `share_list` is the only one of these commands that reconciles, and `share::commands` runs it
 * inside `on_the_write_connection` → `sync::with_write` — so it holds the exclusive write lock
 * across a relay round trip, and every other user write in the app answers `BUSY` after
 * `WRITE_LOCK_WAIT` (5 s) while it does. That is `sync_now`'s shape, but `sync_now` is a
 * **press**: this is a query mounted with `CollectionPage`, and TanStack refetches on window
 * focus by default. So an unconnected device asks nothing at all — it has no membership, the
 * Share control is hidden for it anyway, and the answer would be the local cache it already has —
 * and a connected one asks on a mount and on a write, never on a focus.
 *
 * `refetchOnWindowFocus: false` for the same trip: this list changes when somebody presses
 * publish or revoke, and both of those invalidate {@link SHARE_KEY} themselves.
 */
export function useShares(enabled: boolean) {
  return useQuery<ShareRow[]>({
    queryKey: SHARE_LIST_KEY,
    queryFn: () => ipc.shareList(),
    enabled,
    refetchOnWindowFocus: false,
  });
}
