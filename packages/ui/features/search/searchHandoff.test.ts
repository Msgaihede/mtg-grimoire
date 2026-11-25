import { describe, expect, it } from "vitest";
import type { SearchHandoff } from "@/lib/ipc";
import { parseQuery } from "./queryLanguage";
import { chipsOf, handoffReport, type HandoffWall } from "./searchHandoff";

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

  /** Rust groups an agent's text holding an `or` before it appends a keyword: the group is one
   *  term and the keyword another, both narrowing the whole wall. */
  it("reads an agent's grouped `or` and the keyword after it as two terms", () => {
    const parsed = parseQuery("(t:goblin or t:elf) is:gamechanger");
    expect(parsed.text).toBe("");
    expect(parsed.tags).toEqual([]);
    expect(parsed.predicates).toHaveLength(2);
    // Ungrouped, the keyword is the elf's alone: the whole is one `or`.
    expect(parseQuery("t:goblin or t:elf is:gamechanger").predicates).toHaveLength(1);
  });
});

describe("handoffReport", () => {
  const wall = (over: Partial<HandoffWall> = {}): HandoffWall => ({
    total: 143,
    totalIsCapped: false,
    keywords: ["t:creature"],
    words: "",
    unknownTags: [],
    failure: null,
    resolving: false,
    settled: true,
    ...over,
  });

  it("waits while tags resolve or the rows are the last search's", () => {
    expect(handoffReport(wall({ resolving: true }))).toBeNull();
    expect(handoffReport(wall({ settled: false }))).toBeNull();
  });

  it("reports the wall once it has answered", () => {
    expect(handoffReport(wall())).toEqual({
      total: 143,
      totalIsCapped: false,
      keywords: ["t:creature"],
      words: "",
      unknownTags: [],
      failure: null,
    });
  });

  it("reports at once when a typed tag names none or a lookup failed, rows or not", () => {
    expect(
      handoffReport(wall({ settled: false, unknownTags: ["nonesuch"], total: 0 }))?.unknownTags,
    ).toEqual(["nonesuch"]);
    expect(
      handoffReport(wall({ settled: false, failure: "The tag list could not be read." }))?.failure,
    ).toMatch(/could not/);
  });
});
