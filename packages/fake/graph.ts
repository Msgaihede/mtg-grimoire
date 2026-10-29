/**
 * The read graph's command, answered by the page's own graph (`@grimoire/ui/lib/graphql/`).
 *
 * The desktop answers `graphql_query` from SQLite (`crates/grimoire-graph`); the fake answers it by
 * running the same document through the TypeScript schema, whose resolvers call this fake's other
 * handlers. So a story or a suite reads exactly what the page's graph says the data is, and
 * `lib/graphql/parity.test.ts` holds the two schemas to the same shape.
 *
 * Round-tripped through JSON so the answer is what the command's wire carries — plain objects,
 * never graphql-js's `GraphQLError` instances.
 */
import { runQuery } from "@grimoire/ui/lib/graphql/execute";
import { isMarketplaceId } from "@grimoire/ui/lib/marketplace";

export function graphHandlers() {
  return {
    graphql_query: async (args: {
      query: string;
      variables?: Record<string, unknown> | null;
      operationName?: string | null;
      marketplace?: string | null;
    }): Promise<unknown> => {
      const marketplace =
        args.marketplace && isMarketplaceId(args.marketplace) ? args.marketplace : undefined;
      const result = await runQuery(
        { query: args.query, variables: args.variables, operationName: args.operationName },
        { marketplace },
      );
      return JSON.parse(JSON.stringify(result)) as unknown;
    },
  };
}
