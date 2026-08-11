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
  });
  return facetsOrUndefined(query.data);
}
