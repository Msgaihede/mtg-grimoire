import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ipc, type FacetResponse, type SearchRequest } from "@/lib/ipc";
import { facetsOrUndefined } from "./facets";

/**
 * Everything a facet request is allowed to carry: every filter, and nothing about the page.
 *
 * The omissions are the point. Facets depend on neither the sort nor the offset nor the
 * collapse — that is *why* `facet_cards` is a separate command from `search_cards` — so a
 * type that cannot express them is a facet key that cannot accidentally be recomputed on
 * every header press and every scroll. `limit`/`offset` are filled in below because
 * `SearchRequest` requires them and the backend ignores them here.
 */
export type FacetRequest = Omit<SearchRequest, "sort" | "collapse" | "limit" | "offset">;

/**
 * How often to ask again while the answer is **not ready**, and nothing at all once it is.
 *
 * A not-ready answer is the one state nothing else will ever correct. `ready: false` is not
 * an error and not stale data — React Query caches it as a perfectly good success and holds
 * it for `staleTime` (30 s), and the filter set has not changed, so no new key is minted and
 * no refetch is owed. The index meanwhile becomes ready ~767 ms later with nothing to say
 * about it. That is the bug this closes; see the hook below.
 *
 * 500 ms because the cold window is ~767 ms, so the counts land within about half a second
 * of existing — under the threshold where a reader notices a control changing on its own —
 * and a build that is already finished costs at most one extra call. It cannot run away: the
 * interval is a *function of the answer*, so the first ready response turns it off.
 */
export const COLD_POLL_MS = 500;

/**
 * Facet counts for the current filters, or `undefined` when nothing is known.
 *
 * **Keyed on the filters alone.** React Query hashes the request object with its keys
 * sorted and its `undefined` values dropped, so an unset filter costs no second key and two
 * differently-built requests for the same search share one answer.
 *
 * `keepPreviousData` so the chips hold their last answer while a new one is in flight rather
 * than flickering open and closed on every keystroke. The window is short — the worst
 * measured pass is 57 ms — and a stale answer one filter out of date is a better reader
 * experience than a row that blinks.
 *
 * **Everything that is not a ready answer comes back as `undefined`**, which is the whole
 * fail-open rule in one place: a first load, a cold index (`ready: false`, every map empty)
 * and a query that errored are three different states and all three mean "we don't know",
 * and a control that has to tell them apart is a control that will get it wrong.
 *
 * There is deliberately **no `isError` arm**, and the reason is not that it could not fire.
 * A failed *first* fetch and a failed fetch under a *new* key both leave `data` undefined —
 * the held previous answer goes with them — so `facetsOrUndefined` answers those on its own.
 * A failed re-read of a key that is **already loaded** is the third case and it is different:
 * React Query keeps the data and records the error beside it, which it names `isRefetchError`
 * (measured 2026-08-11 against 5.101.4: cache `status: "error"`, `errorUpdateCount: 1`, data
 * intact). That path is live here — the app's `QueryClient` runs `staleTime: 30_000`,
 * `retry: 1` and refetch-on-focus, so a window focus or a remount re-reads a loaded facet
 * key. An arm would have fired.
 *
 * It is unwanted because of what it would do when it fired. The retained answer is keyed on
 * *that exact filter set*, so it describes the search still on screen — counts that are still
 * true, thrown away to grey nothing over results they correctly describe. Failing open is for
 * not knowing, and here we know.
 *
 * A second-order note for anyone adding a read to this function: v5 notifies on the props a
 * render actually touched, and this one touches `data` alone. An error beside unchanged data
 * therefore does not even re-render — reading `query.isError` here would *make* it, which is
 * the mechanism behind the paragraph above rather than a reason for it.
 */
export function useCardFacets(req: FacetRequest): FacetResponse | undefined {
  const query = useQuery({
    queryKey: ["cards", "facets", req],
    queryFn: () => ipc.facetCards({ ...req, limit: 0, offset: 0 }),
    placeholderData: keepPreviousData,
    // **Ask again while the index is cold, and stop the moment it is not.**
    //
    // Without this the row can hold a not-ready answer indefinitely, and the path there is
    // the one every reader takes. `sync.rs`'s ingest calls `lifecycle::spawn_build` and then
    // `emit_done` on the next line — and `spawn_build` runs `clear` **synchronously on the
    // caller's thread** before handing the fill to a new one, so `done` is emitted over a
    // cold index by construction rather than by luck. `useSyncInvalidation` hears `done` and
    // invalidates `["cards"]`, which prefix-matches this key, so the one refetch a finished
    // sync produces lands squarely inside the ~767 ms window and caches `ready: false`. The
    // filters have not changed, so no new key is minted; `staleTime` is 30 s, so nothing is
    // stale; and the answer is a success, so no retry is owed. The unfiltered row then shows
    // no counts at all until the reader touches a filter (which mints a key and heals
    // instantly) or 30 s pass *and* a remount or a visibility change happens to fire.
    //
    // Reading `query.state.data` and not the observer's result is deliberate: under
    // `keepPreviousData` the observer may be showing the *previous* key's answer, and the
    // question here is only ever about **this** key's own.
    //
    // Chosen over the two backend fixes because it is keyed on the meaning rather than on
    // one cause. `ready: false` is the app's word for "we have not counted", so this covers
    // every way of being in that state at once — the launch build, a sync's rebuild, the
    // empty corpus that a first run sits in for its whole ~93 s opening sync, and a build
    // that failed outright and will never emit anything. Moving `emit_done` behind the join
    // would make every other query root (searches, collection, decks, the set picker) wait
    // ~767 ms on an index none of them reads and that `lifecycle`'s own docs call
    // non-fatal; a new event after `publish_build` would be a second hand-mirrored IPC
    // contract that covers only the paths which reach a publish.
    //
    // While not-ready the call is cheap at the source: `compute` returns at its
    // `ix.all.count() == 0` guard, and `run_facets` returns before that when there is no
    // index at all.
    refetchInterval: (query) => (query.state.data?.ready === false ? COLD_POLL_MS : false),
  });
  return facetsOrUndefined(query.data);
}
