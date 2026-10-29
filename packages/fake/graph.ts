/**
 * The read graph's command, refused in words.
 *
 * The graph is the desktop's alone (`crates/grimoire-graph`, answered from SQLite), and the page
 * holds no schema to answer it with — so a story or a suite that draws a widget over the graph
 * hands that widget its answer itself (`vi.spyOn(ipc, "graphqlQuery")`), and anything else that
 * asks is told, in the specification's shape rather than as a rejection, exactly as a bad
 * document would be.
 */
import type { GraphResponse } from "@grimoire/ui/lib/ipc";

/** What the fake says to every document. */
export const GRAPH_ON_THE_DESKTOP = "The read graph is answered by the desktop app alone.";

export function graphHandlers() {
  return {
    graphql_query: (): GraphResponse => ({
      data: null,
      errors: [{ message: GRAPH_ON_THE_DESKTOP }],
      extensions: { invalidatedBy: [] },
    }),
  };
}
