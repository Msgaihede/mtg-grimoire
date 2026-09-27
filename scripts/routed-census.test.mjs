// `routedNames` against a hand-written `COMMANDS` block rather than the real `route.rs`: the rule
// is about how comments are read, and a fixture that says so in four lines cannot drift the way a
// count of the live array does.
import { describe, expect, it } from "vitest";
import { routedNames } from "./routed-census.mjs";

const ROUTE = `
pub const COMMANDS: &[&str] = &[
    // The read — a comment quoting \`cfg(not(target_family = "wasm"))\`, the kind that
    // counted a command that does not exist.
    "collection_list",
    "collection_summary", // a trailing note naming "ghost"
    //"commented_out",
    "set_shelf_folds",
];

fn call() { let _ = "after_the_array"; }
`;

describe("routedNames", () => {
  it("reads the quoted names in COMMANDS and nothing a comment quotes", () => {
    expect([...routedNames(ROUTE)]).toEqual([
      "collection_list",
      "collection_summary",
      "set_shelf_folds",
    ]);
  });

  it("stops at the array's own close, not at a quoted word after it", () => {
    expect(routedNames(ROUTE).has("after_the_array")).toBe(false);
  });
});
