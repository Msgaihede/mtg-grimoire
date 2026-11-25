import { describe, expect, it } from "vitest";
import type { SearchHandoff } from "@/lib/ipc";
import { parseQuery } from "./queryLanguage";
import { chipsOf } from "./searchHandoff";

describe("chipsOf", () => {
  it("turns the agent's tags into include chips", () => {
    expect(
      chipsOf({ tags: [{ slug: "ramp", label: "Ramp", namespace: "oracle" }] } as SearchHandoff),
    ).toEqual([{ slug: "ramp", label: "Ramp", namespace: "oracle", mode: "include" }]);
  });
});

describe("the text an agent's search puts in the box", () => {
  /** The strings Rust composes (`mcp/show.rs`' `handoff`) must be terms this page reads. */
  it("reads the keywords Rust puts in the box as keywords, not words", () => {
    for (const text of ["is:gamechanger", "f:premodern", "r:special", "(r:rare or r:special)"]) {
      expect(parseQuery(text).text).toBe("");
      expect(parseQuery(text).predicates).toHaveLength(1);
    }
  });
});
