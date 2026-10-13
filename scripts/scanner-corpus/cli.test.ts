import { describe, expect, it } from "vitest";
import { parseArgs, parseIdFile, removalIds } from "./cli.ts";

const none = { ids: [], fromFile: null, yes: false };

describe("scanner:corpus arguments", () => {
  it("reads status, pull and pull --drain", () => {
    expect(parseArgs(["status"])).toEqual({ command: "status", drain: false, ...none });
    expect(parseArgs(["pull"])).toEqual({ command: "pull", drain: false, ...none });
    expect(parseArgs(["pull", "--drain"])).toEqual({ command: "pull", drain: true, ...none });
  });

  it("refuses a flag it does not know, naming it", () => {
    expect(() => parseArgs(["pull", "--dry-run"])).toThrow('unknown argument "--dry-run"');
    expect(() => parseArgs(["remove", "a", "--force"])).toThrow('unknown argument "--force"');
  });

  it("refuses --drain on status, and a missing or unknown command", () => {
    expect(() => parseArgs(["status", "--drain"])).toThrow("--drain");
    expect(() => parseArgs([])).toThrow("say `status`, `pull`");
    expect(() => parseArgs(["push"])).toThrow("say `status`, `pull`");
  });

  it("reads remove with ids, --yes and --from-file, in any order", () => {
    expect(parseArgs(["remove", "a1", "b-2"])).toEqual({ command: "remove", drain: false, yes: false, ids: ["a1", "b-2"], fromFile: null });
    expect(parseArgs(["remove", "--yes", "a1", "--from-file", "ids.txt", "a1"])).toEqual({
      command: "remove",
      drain: false,
      yes: true,
      ids: ["a1"],
      fromFile: "ids.txt",
    });
  });

  it("refuses --drain on remove, and --yes and --from-file anywhere but remove", () => {
    expect(() => parseArgs(["remove", "a", "--drain"])).toThrow("--drain goes with `pull`");
    expect(() => parseArgs(["pull", "--yes"])).toThrow("--yes goes with `remove`");
    expect(() => parseArgs(["status", "--yes"])).toThrow("--yes goes with `remove`");
    expect(() => parseArgs(["pull", "--from-file", "x"])).toThrow("--from-file goes with `remove`");
  });

  it("refuses an id that is not a safe one, naming it, and a bare id on pull", () => {
    expect(() => parseArgs(["remove", "ok", "../etc"])).toThrow('not a scan id: "../etc"');
    expect(() => parseArgs(["remove", "a.bin"])).toThrow('not a scan id: "a.bin"');
    expect(() => parseArgs(["pull", "abc"])).toThrow('unknown argument "abc"');
  });

  it("refuses an id that starts with a dash as an unknown flag", () => {
    expect(() => parseArgs(["remove", "-x"])).toThrow('unknown argument "-x"');
    expect(() => parseArgs(["remove", "a", "--yes-really"])).toThrow('unknown argument "--yes-really"');
  });

  it("refuses --from-file given twice", () => {
    expect(() => parseArgs(["remove", "--from-file", "a.txt", "--from-file", "b.txt"])).toThrow("--from-file is given once");
  });

  it("refuses --from-file with no path", () => {
    expect(() => parseArgs(["remove", "--from-file"])).toThrow("--from-file needs");
    expect(() => parseArgs(["remove", "--from-file", "--yes"])).toThrow("--from-file needs");
  });
});

describe("a file of ids", () => {
  it("skips blank lines and # lines, trims, and collapses duplicates", () => {
    expect(parseIdFile("# bad scans\n\n  a1  \r\nb2\n#c3\na1\n")).toEqual(["a1", "b2"]);
  });

  it("refuses a line that is not an id, naming the line", () => {
    expect(() => parseIdFile("a1\nfoo/bar\n")).toThrow('line 2 of the id file: not a scan id: "foo/bar"');
    expect(() => parseIdFile("a1 b2")).toThrow("not a scan id");
  });

  it("refuses a line that would read as a flag, naming the line, and keeps the real shape of an id", () => {
    expect(() => parseIdFile("--yes\n")).toThrow('line 1 of the id file: not a scan id: "--yes"');
    expect(parseIdFile("20261011T101500Z-9f8a0c1d2e3f4a5b\n")).toEqual(["20261011T101500Z-9f8a0c1d2e3f4a5b"]);
  });

  it("joins the arguments' ids and the file's, each once, and refuses none", () => {
    expect(removalIds(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
    expect(() => removalIds([], [])).toThrow("name the scans to remove");
  });
});
