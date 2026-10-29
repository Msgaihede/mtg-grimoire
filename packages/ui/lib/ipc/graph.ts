/**
 * The read graph's one command: a GraphQL document in, a GraphQL response out.
 *
 * **A domain of `../ipc.ts`**, read through `@/lib/ipc` only. The command is the desktop host's
 * (`apps/desktop/src-tauri/src/graph.rs`) over `crates/grimoire-graph`, which answers from SQLite;
 * the fake answers it from the page's own graph (`lib/graphql/`), so every story and suite runs
 * the same documents. Read through `lib/graphql/useGraphQL.ts`, never called directly.
 *
 * **A web or phone host refuses it** — it is on the desktop's `DESKTOP_ONLY` list (the owner's
 * decision, 2026-10-29).
 *
 * **Never a rejection for a bad document**: a syntax, validation or resolver error is an entry in
 * `errors`, beside whatever `data` the rest of the document answered — the specification's shape,
 * which is graphql-js's `FormattedExecutionResult` verbatim.
 */
import type { FormattedExecutionResult } from "graphql";
import type { MarketplaceId } from "@/lib/marketplace";
import { invoke } from "./invoke";

export const graphCommands = {
  /**
   * Run one read of the graph. `marketplace` is what a priced field with no `marketplace`
   * argument answers at — the window's, after its host fallback; `null` reads the stored choice.
   */
  graphqlQuery: (
    query: string,
    variables: Record<string, unknown> | null,
    operationName: string | null,
    marketplace: MarketplaceId | null,
  ) =>
    invoke<FormattedExecutionResult>("graphql_query", {
      query,
      variables,
      operationName,
      marketplace,
    }),
};
