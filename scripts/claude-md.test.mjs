import { describe, expect, it } from "vitest";
import { checkClaudeBudgets, countLines, findClaudeFiles } from "./check-claude-md.mjs";

describe("CLAUDE.md size budget gate", () => {
  it("finds all expected repository CLAUDE.md files", () => {
    const files = findClaudeFiles(".");
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files.map((f) => f.replace(/\\/g, "/"))).toEqual(
      expect.arrayContaining([
        "CLAUDE.md",
        ".github/CLAUDE.md",
        ".storybook/CLAUDE.md",
        "crates/grimoire-core/CLAUDE.md",
        "crates/grimoire-web/CLAUDE.md",
        "mobile/CLAUDE.md",
        "src-tauri/CLAUDE.md",
        "src/CLAUDE.md",
        "src/features/decks/CLAUDE.md",
        "src/features/transfer/CLAUDE.md",
      ]),
    );
  });

  it("enforces that no CLAUDE.md file exceeds 200 lines", () => {
    const { ok, results } = checkClaudeBudgets(".");
    const overBudget = results.filter((r) => !r.ok);
    expect(overBudget).toEqual([]);
    expect(ok).toBe(true);
  });

  it("calculates line counts and catches documents over 200 lines", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("line 1\nline 2\nline 3")).toBe(3);
    expect(countLines("line 1\r\nline 2")).toBe(2);

    const exactly200 = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
    expect(countLines(exactly200)).toBe(200);

    const over200 = Array.from({ length: 201 }, (_, i) => `line ${i + 1}`).join("\n");
    expect(countLines(over200)).toBe(201);
  });
});
