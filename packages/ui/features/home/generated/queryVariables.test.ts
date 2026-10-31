import { describe, expect, it } from "vitest";
import GOLDEN from "./__golden__/query-variables.json";
import { declaredVariables, queryVariables } from "./queryVariables";

describe("declaredVariables", () => {
  it("reads each declaration once, in order, and never a use", () => {
    expect(
      declaredVariables("query ($b: Int!, $a: [String!] = []) { x(a: $a, b: $b) { y } }"),
    ).toEqual(["b", "a"]);
  });

  it("reads none from a block string", () => {
    expect(declaredVariables('{ x(text: """\n$a: no\n""") { y } }')).toEqual([]);
  });
});

/**
 * **The rule, as a file both sides hold.** The desktop's MCP tool `widget_preview` fills a query's
 * variables in Rust (`mcp::tools::query_variables`) so an agent's preview asks what the page will.
 */
describe("the shared query-variables golden", () => {
  it.each(GOLDEN.map((c) => [c.name, c] as const))("%s", (_, c) => {
    expect(queryVariables(c.query, c.settings) ?? null).toEqual(c.variables);
  });
});
