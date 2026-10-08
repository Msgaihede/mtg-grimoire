import type { InfiniteData, Query, QueryClient } from "@tanstack/react-query";
import { ipc, type SearchResponse } from "./ipc";
import { OWNED_WRITE_KEYS } from "./query";

/**
 * A write to the reader's own tables, brought to the card searches on screen by **patching the
 * two badges it can have moved** rather than refetching every page they hold (issue #552).
 *
 * `useCardSearch` is an infinite query with no `maxPages`, so a search the reader scrolled deep
 * into holds up to 100 pages, and an invalidation refetches every one of them in sequence —
 * ~53 ms each against the real database, about five seconds behind every "+". What a collection
 * or wishlist write changes about a loaded search is `ownedQuantity` and `wishlisted` and nothing
 * else: every other field of a `CardSummary` is the corpus's. So a patchable search asks
 * `search_marks` for the ids it holds, in one statement, and rewrites those two fields in place.
 *
 * **Three kinds of search are refetched as before, because a patch cannot answer them**:
 *
 * - **one filtered by Owned or Missing**, where a write changes which rows *belong* on the wall
 *   and not only what their badges say — a patch can rewrite a row and never add or drop one;
 * - **one with a fetch in flight**, since a page arriving after the patch is built from the
 *   pages the fetch started with and would put the stale badges back;
 * - **anything under the prefix that did not stamp {@link SearchMarksMeta}** — the deck cover
 *   picker's search and any inactive query, which is only marked stale and refetches, as it
 *   always did, when it is next on screen.
 *
 * A patch that fails falls back to that same invalidation, so the worst case is the old cost
 * rather than a wrong badge. And **with nothing to patch the call is exactly the old one**,
 * `invalidateQueries({ queryKey: ["cards", "search"] })`, which is what every caller sent
 * before this existed.
 */
export const CARD_SEARCH_KEY = ["cards", "search"] as const;

/**
 * What `useCardSearch` stamps on its query's `meta` so a write can tell whether, and how, it
 * may patch that search — the two request fields that decide the grain and scope of a badge,
 * and whether the rows themselves depend on ownership.
 */
export interface SearchMarksMeta {
  /** The request's `collapse`: a collapsed row's badge counts every printing of its card. */
  collapse: boolean;
  /** The request's `availableForDeck`: whose copies count as the reader's. */
  availableForDeck: number | undefined;
  /** The request carries an `owned` filter, so a write can change which rows belong. */
  ownedFilter: boolean;
}

const META_KEY = "searchMarks";

/** The `meta` object for `useInfiniteQuery`, under the one key {@link refreshCardSearches} reads. */
export function searchMarksMeta(meta: SearchMarksMeta): Record<string, unknown> {
  return { [META_KEY]: meta };
}

type Pages = InfiniteData<SearchResponse, unknown>;

/** The meta a search stamped, when that search can be patched right now; `null` otherwise. */
function patchableMeta(query: Query): SearchMarksMeta | null {
  const meta = query.meta?.[META_KEY] as SearchMarksMeta | undefined;
  if (!meta || meta.ownedFilter) return null;
  if (!query.isActive() || query.state.fetchStatus !== "idle") return null;
  const data = query.state.data as Pages | undefined;
  return Array.isArray(data?.pages) ? meta : null;
}

async function patchOne(client: QueryClient, query: Query, meta: SearchMarksMeta): Promise<void> {
  const held = query.state.data as Pages;
  const ids = [...new Set(held.pages.flatMap((page) => page.items.map((row) => row.id)))];
  try {
    const marks = await ipc.searchMarks({
      ids,
      // Absent rather than `false`, as `useCardSearch` sends it: uncollapsed is the default.
      collapse: meta.collapse || undefined,
      availableForDeck: meta.availableForDeck,
    });
    const byId = new Map(marks.map((m) => [m.id, m]));
    client.setQueryData<Pages>(query.queryKey, (current) => {
      if (!current) return current;
      // Identity kept wherever nothing moved, so a "+" re-renders the rows it changed and not
      // the whole wall. A row the answer leaves out — a corpus swapped since the page loaded —
      // keeps what it said; the sync that swapped it refetches every search anyway.
      let changed = false;
      const pages = current.pages.map((page) => {
        let pageChanged = false;
        const items = page.items.map((row) => {
          const m = byId.get(row.id);
          if (!m || (m.ownedQuantity === row.ownedQuantity && m.wishlisted === row.wishlisted)) {
            return row;
          }
          pageChanged = true;
          return { ...row, ownedQuantity: m.ownedQuantity, wishlisted: m.wishlisted };
        });
        if (!pageChanged) return page;
        changed = true;
        return { ...page, items };
      });
      return changed ? { ...current, pages } : current;
    });
  } catch {
    await client.invalidateQueries({ queryKey: query.queryKey, exact: true });
  }
}

/**
 * Bring every cached card search up to date with a write to the collection or the wishlist —
 * see the module doc. The drop-in for `invalidateQueries({ queryKey: ["cards", "search"] })`
 * at every call site whose write moved an owned count or a wish and nothing about the corpus.
 */
export async function refreshCardSearches(client: QueryClient): Promise<void> {
  const patchable = client
    .getQueryCache()
    .findAll({ queryKey: CARD_SEARCH_KEY })
    .flatMap((query) => {
      const meta = patchableMeta(query);
      return meta ? [{ query, meta }] : [];
    });
  if (patchable.length === 0) {
    await client.invalidateQueries({ queryKey: CARD_SEARCH_KEY });
    return;
  }
  const patched = new Set(patchable.map(({ query }) => query.queryHash));
  await Promise.all([
    client.invalidateQueries({
      queryKey: CARD_SEARCH_KEY,
      predicate: (query) => !patched.has(query.queryHash),
    }),
    ...patchable.map(({ query, meta }) => patchOne(client, query, meta)),
  ]);
}

/**
 * `OWNED_WRITE_KEYS`, fired — with its `["cards", "search"]` member brought up to date by
 * {@link refreshCardSearches} rather than by an invalidation. The drop-in for the
 * `for (const queryKey of OWNED_WRITE_KEYS) invalidateQueries({ queryKey })` loop.
 */
export function invalidateOwnedWrite(client: QueryClient): void {
  for (const queryKey of OWNED_WRITE_KEYS) {
    const isSearch =
      queryKey.length === CARD_SEARCH_KEY.length &&
      CARD_SEARCH_KEY.every((part, i) => queryKey[i] === part);
    if (isSearch) void refreshCardSearches(client);
    else void client.invalidateQueries({ queryKey });
  }
}
