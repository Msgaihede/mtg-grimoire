/**
 * Read the graph from a component — `useQuery` over {@link runQuery}, kept as fresh as the
 * writes that change what the document reads.
 *
 * **Under its own `["graphql"]` root, and refreshed by the roots its fields name.** A document can
 * read the collection and the decks at once, and a TanStack key sits under one prefix, so no key
 * this hook could choose would be reached by both roots' invalidations. Instead it does what
 * `ActivityWidget`'s feed does for the same reason: a marker query under each root the document
 * reads (`rootsOf`), so an invalidation of that root always has something to match, and one
 * subscription to the query cache that turns an `invalidate` under any of those roots into an
 * invalidation of this document. Every write in the app already ends in one of those
 * invalidations, and `crossWindow.ts` raises them for another window's writes too, so a widget
 * built on this needs no write to learn its key.
 *
 * **Keyed on the window's marketplace** (`useMarketplace().marketplace`, after its host
 * fallback), which is what a priced field with no `marketplace` argument answers at. Switching
 * marketplace writes that key rather than invalidating anything (`useMarketplace`'s `select`), so
 * it has to be in this key for a document to be asked again.
 *
 * **Errors.** A document that answered nothing — a syntax error, a validation error, every field
 * refused — is the query's error, its messages joined (`ipcError` renders it). One that answered
 * in part is data with `errors` beside it, the specification's shape, so a widget can draw what
 * did arrive.
 */
import { useEffect, useMemo } from "react";
import { useQueries, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { ExecutionResult } from "graphql";
import { useMarketplace } from "@/lib/useMarketplace";
import { prepare, runQuery } from "./execute";

/** The root every document's own cache entry sits under. Nothing outside this file invalidates
 *  it; the bridge below is what does. */
export const GRAPHQL_ROOT = "graphql";

/** The marker's own segment under each root a document reads — one word no other reader of those
 *  roots uses, so a prefix walk (`setQueriesData(["collection", "list"])`) never reaches it. */
const GRAPHQL_MARKER = "graphqlReadMarker";

export interface UseGraphQLOptions {
  variables?: Record<string, unknown>;
  operationName?: string;
  /** `false` holds the read — and its bridge — until it is turned on. */
  enabled?: boolean;
}

export type GraphQLResult<TData> = ExecutionResult<TData>;

export function useGraphQL<TData = Record<string, unknown>>(
  query: string,
  { variables, operationName, enabled = true }: UseGraphQLOptions = {},
) {
  const client = useQueryClient();
  const { marketplace } = useMarketplace();
  const prepared = useMemo(() => prepare(query, operationName), [query, operationName]);
  const roots = prepared.roots;

  const queryKey: QueryKey = useMemo(
    () => [GRAPHQL_ROOT, query, operationName ?? null, variables ?? null, marketplace.id],
    [query, operationName, variables, marketplace.id],
  );
  const keyHash = JSON.stringify(queryKey);

  // Presence, never data: `staleTime: Infinity` so nothing refetches a marker on its own, and
  // `notifyOnChangeProps: []` so the refetch an invalidation causes re-renders nothing.
  useQueries({
    queries: roots.map((root) => ({
      queryKey: [root, GRAPHQL_MARKER],
      queryFn: () => true,
      staleTime: Infinity,
      notifyOnChangeProps: [] as [],
      enabled,
    })),
  });

  useEffect(() => {
    if (!enabled || roots.length === 0) return;
    return client.getQueryCache().subscribe((event) => {
      // The *action*: a query under these roots emits `fetch` and `success` on every ordinary
      // read, and re-running this document for a page that merely listed something would be a
      // read per keystroke of somebody else's search box.
      if (event.type !== "updated" || event.action.type !== "invalidate") return;
      const root = event.query.queryKey[0];
      if (typeof root !== "string" || !roots.includes(root)) return;
      // No loop: this invalidates under `["graphql"]`, which no document can name as a root.
      void client.invalidateQueries({ queryKey: JSON.parse(keyHash) as QueryKey, exact: true });
    });
  }, [client, enabled, roots, keyHash]);

  return useQuery({
    queryKey,
    enabled,
    queryFn: async (): Promise<GraphQLResult<TData>> => {
      const result = (await runQuery(
        { query, variables, operationName },
        { marketplace: marketplace.id },
      )) as GraphQLResult<TData>;
      if (result.data == null && result.errors && result.errors.length > 0) {
        throw new Error(result.errors.map((e) => e.message).join("\n"));
      }
      return result;
    },
  });
}
