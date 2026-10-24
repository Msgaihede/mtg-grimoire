import { describe, expect, it } from "vitest";
import { baselineName, baselineNote, commitLabel, parseArgs } from "./cli.ts";

describe("parseArgs", () => {
  it("reads nothing as the defaults", () => {
    expect(parseArgs([])).toEqual({
      baseline: null,
      saveBaseline: null,
      only: [],
      corpus: null,
      jobs: null,
      neuralEvidence: null,
      neuralEvidenceMeta: null,
      noBuild: false,
    });
  });

  it("reads every flag, and --only more than once", () => {
    const args = parseArgs([
      "--baseline", "first", "--save-baseline", "v2", "--only", "bolt", "--only", "abc",
      "--corpus", "c.db", "--jobs", "4",
      "--neural-evidence", "ev", "--neural-evidence-meta", "n.json", "--no-build",
    ]);
    expect(args).toEqual({
      baseline: "first",
      saveBaseline: "v2",
      only: ["bolt", "abc"],
      corpus: "c.db",
      jobs: "4",
      neuralEvidence: "ev",
      neuralEvidenceMeta: "n.json",
      noBuild: true,
    });
  });

  it("refuses a flag that is not one of ours, with a sentence", () => {
    expect(() => parseArgs(["--bulk", "x"])).toThrow('unknown argument "--bulk"');
    // The hash bundle and the OCR models left with the Fast and Exact scanner.
    expect(() => parseArgs(["--bundle", "b.bin"])).toThrow('unknown argument "--bundle"');
    expect(() => parseArgs(["--models", "m"])).toThrow('unknown argument "--models"');
  });

  it("refuses a flag with no value, even when another flag follows", () => {
    expect(() => parseArgs(["--only"])).toThrow("--only needs a value");
    expect(() => parseArgs(["--baseline", "--no-build"])).toThrow("--baseline needs a value");
  });

  it("refuses a --jobs that is not a positive whole number", () => {
    expect(() => parseArgs(["--jobs", "0"])).toThrow("--jobs needs a whole number");
    expect(() => parseArgs(["--jobs", "two"])).toThrow("--jobs needs a whole number");
  });

  it("refuses a bad baseline name on either flag", () => {
    expect(() => parseArgs(["--save-baseline", "../x"])).toThrow("not a baseline name");
    expect(() => parseArgs(["--baseline", "a/b"])).toThrow("not a baseline name");
  });
});

describe("baselineName", () => {
  it("accepts letters, digits, underscore, dot and hyphen", () => {
    for (const ok of ["first", "v2.1", "a_b-c", "2026-10-13", "x.json"]) {
      expect(baselineName("--save-baseline", ok)).toBe(ok);
    }
  });

  it("refuses a leading dot, a separator, a space and nothing", () => {
    for (const bad of [".hidden", "..", "a/b", "a\\b", "a b", "", "é"]) {
      expect(() => baselineName("--save-baseline", bad)).toThrow("is not a baseline name");
    }
  });
});

describe("commitLabel", () => {
  it("marks a tree with changes and a binary nobody rebuilt", () => {
    expect(commitLabel("abc1234", false, false)).toBe("abc1234");
    expect(commitLabel("abc1234", true, false)).toBe("abc1234+dirty");
    expect(commitLabel("abc1234", false, true)).toBe("abc1234+nobuild");
    expect(commitLabel("abc1234", true, true)).toBe("abc1234+dirty+nobuild");
  });
});

describe("baselineNote", () => {
  it("says a pull uploads a new baseline, and that it does not replace a changed one", () => {
    expect(baselineNote("first", "/b/first.json", false)).toContain("`pnpm scanner:corpus pull` puts it in the corpus bucket");
    const replaced = baselineNote("first", "/b/first.json", true);
    expect(replaced).toContain("replaced baseline first");
    expect(replaced).toContain("a pull does not replace the bucket's copy");
    expect(replaced).toContain("new name");
  });
});
