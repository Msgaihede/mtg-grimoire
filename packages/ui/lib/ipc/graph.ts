/**
 * The read graph's one command: a GraphQL document in, a GraphQL response out.
 *
 * **A domain of `../ipc.ts`**, read through `@/lib/ipc` only. The graph is the desktop host's —
 * `crates/grimoire-graph`, answered from SQLite by `apps/desktop/src-tauri/src/graph.rs` — and the
 * page holds no schema and no GraphQL library of its own: a document is a string here, and every
 * check is Rust's. Read through `lib/graphql/useGraphQL.ts`, never called directly.
 *
 * **A web or phone host refuses it** — it is on the desktop's `DESKTOP_ONLY` list (the owner's
 * decision, 2026-10-29) — and the fake answers it with an error (`packages/fake/graph.ts`).
 *
 * **Never a rejection for a bad document**: a syntax, validation or resolver error is an entry in
 * `errors`, beside whatever `data` the rest of the document answered — the specification's shape.
 */
import type { MarketplaceId } from "@/lib/marketplace";
import { invoke } from "./invoke";

/** One error of a {@link GraphResponse}: the backend's sentence, and where it happened. */
export interface GraphError {
  message: string;
  /** Line and column in the document, both from 1. */
  locations?: { line: number; column: number }[];
  /** The answer's path to the field that failed — names and list indexes. */
  path?: (string | number)[];
}

/** What `graphql_query` answers: async-graphql's `Response`, serialised. */
export interface GraphResponse<TData = Record<string, unknown>> {
  /** `null` when nothing answered; a root field that failed is `null` inside it. */
  data?: TData | null;
  errors?: GraphError[];
  extensions?: {
    /** The query-cache roots the document's root fields are stale under — `useGraphQL`'s. */
    invalidatedBy?: string[];
  };
}

export const graphCommands = {
  /**
   * Run one read of the graph. `marketplace` is what a priced field with no `marketplace`
   * argument answers at — the window's, after its host fallback; `null` reads the stored choice.
   */
  graphqlQuery: <TData = Record<string, unknown>>(
    query: string,
    variables: Record<string, unknown> | null,
    operationName: string | null,
    marketplace: MarketplaceId | null,
  ) =>
    invoke<GraphResponse<TData>>("graphql_query", {
      query,
      variables,
      operationName,
      marketplace,
    }),
};
