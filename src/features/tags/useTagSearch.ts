import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { DEBOUNCE_MS } from "@/features/search/useCardSearch";
import { ipc, type TagHit, type TagNamespace } from "@/lib/ipc";

/**
 * How many tags one type-ahead answers with. The cap is on the **merged** answer across both
 * taxonomies, so `"both"` still gets this many rows rather than twice it.
 *
 * There is no server-side clamp — `tag_search` sends whatever it is handed straight into
 * `LIMIT` — so the number has to be right here. One screenful plus slack, `PAGE_SIZE`'s
 * reasoning, over a list the exact hit is already ranked to the top of.
 */
export const TAG_SEARCH_LIMIT = 50;

/** A shared empty answer, so an idle box hands back the same array every render and nothing
 *  downstream re-runs on an identity that changed for no reason. */
const NO_HITS: TagHit[] = [];

/**
 * Type-ahead over the tag taxonomies — the Tags page's search box.
 *
 * **An empty box asks nothing at all, and that is the whole shape of this hook.** `tag_search`
 * answers *every* tag for an empty needle (deliberately: an untouched box could offer the
 * widest-reaching tags), and there are ~16 000 of them across the two files. Debouncing the
 * empty string would still send that request — on mount, on every remount, and again each time
 * the reader cleared the box — so the query is **skipped** rather than delayed. Both halves of
 * `enabled` are load-bearing: the debounced needle starts empty, so without it the first
 * request of the session would be exactly that whole-taxonomy read.
 *
 * `DEBOUNCE_MS` is the search box's own constant, imported rather than redeclared: two
 * type-aheads in one app that felt different at 300 ms and 250 ms would be a difference nobody
 * chose.
 *
 * No `staleTime` beyond the app client's 30 s, deliberately: muting a tag has to be able to
 * take it out of this list, and a taxonomy pinned with `Infinity` would keep offering it until
 * a reload.
 */
export function useTagSearch(
  text: string,
  namespace: TagNamespace | "both",
): { hits: TagHit[]; isPending: boolean } {
  const needle = text.trim();
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    // The `setState` is inside the timeout, not in the effect body — a synchronous one here
    // would be the reflexive derived-state sync `react-hooks` refuses, and it only fails at
    // `npm run verify`.
    const timer = setTimeout(() => setDebounced(needle), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [needle]);

  const query = useQuery({
    queryKey: ["tag-search", debounced, namespace],
    queryFn: () => ipc.tagSearch(debounced, namespace, TAG_SEARCH_LIMIT),
    // The live needle as well as the settled one: clearing the box has to stop the query in
    // the same render, not 300 ms later, and the settled one is empty until the first
    // debounce fires.
    enabled: needle.length > 0 && debounced.length > 0,
    // A changed needle keeps the previous rows on screen until the new ones land, so the list
    // does not blank between two keystrokes.
    placeholderData: keepPreviousData,
  });

  return {
    hits: needle.length > 0 ? (query.data ?? NO_HITS) : NO_HITS,
    // The debounce counts as pending: the reader typed and something is coming, and a list
    // that looked idle for 300 ms would read as a search that found nothing.
    isPending: needle.length > 0 && (needle !== debounced || query.isFetching),
  };
}
