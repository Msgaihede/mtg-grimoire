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

/** Every share the group has published, newest answer the relay gave or the local cache. */
export function useShares() {
  return useQuery<ShareRow[]>({ queryKey: SHARE_LIST_KEY, queryFn: () => ipc.shareList() });
}
