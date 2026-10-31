/**
 * The read graph's command: the documents a world seeded, answered; everything else refused in
 * words.
 *
 * The graph is the desktop's alone (`crates/grimoire-graph`, answered from SQLite), and the page
 * holds no schema to answer it with — so a world that seeds a custom widget seeds the answer its
 * query would get ({@link FakeDb.graphAnswers}, keyed by {@link graphAnswerKey}), and a story or a
 * suite that draws something else over the graph hands it its answer itself
 * (`vi.spyOn(ipc, "graphqlQuery")`). Anything else that asks is told, in the specification's
 * shape rather than as a rejection, exactly as a bad document would be.
 */
import type { GraphResponse } from "@grimoire/ui/lib/ipc";
import type { FakeDb } from "./db";

/** What the fake says to every document it holds no answer for. */
export const GRAPH_ON_THE_DESKTOP = "The read graph is answered by the desktop app alone.";

/**
 * Where an answer is filed: the trimmed document, and — for a document asked with variables — the
 * variables after it as JSON, keys sorted, so `{ archived: true }` and `{ archived: false }` are two
 * answers. A document asked with variables that has no answer of its own falls back to its bare key.
 */
export function graphAnswerKey(query: string, variables?: Record<string, unknown> | null): string {
  const bare = query.trim();
  if (!variables || Object.keys(variables).length === 0) return bare;
  const sorted = Object.fromEntries(
    Object.keys(variables)
      .sort()
      .map((k) => [k, variables[k]]),
  );
  return `${bare}\n${JSON.stringify(sorted)}`;
}

export function graphHandlers(db: FakeDb) {
  return {
    graphql_query: (args: {
      query: string;
      variables?: Record<string, unknown> | null;
    }): GraphResponse => {
      const data =
        db.graphAnswers[graphAnswerKey(args.query, args.variables)] ??
        db.graphAnswers[graphAnswerKey(args.query)];
      if (data !== undefined) {
        return { data: structuredClone(data), extensions: { invalidatedBy: [] } };
      }
      return {
        data: null,
        errors: [{ message: GRAPH_ON_THE_DESKTOP }],
        extensions: { invalidatedBy: [] },
      };
    },
  };
}
