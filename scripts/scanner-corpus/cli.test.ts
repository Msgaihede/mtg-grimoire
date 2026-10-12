import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli.ts";

describe("scanner:corpus arguments", () => {
  it("reads status, pull and pull --drain", () => {
    expect(parseArgs(["status"])).toEqual({ command: "status", drain: false });
    expect(parseArgs(["pull"])).toEqual({ command: "pull", drain: false });
    expect(parseArgs(["pull", "--drain"])).toEqual({ command: "pull", drain: true });
  });

  it("refuses a flag it does not know, naming it", () => {
    expect(() => parseArgs(["pull", "--dry-run"])).toThrow('unknown argument "--dry-run"');
  });

  it("refuses --drain on status, and a missing or unknown command", () => {
    expect(() => parseArgs(["status", "--drain"])).toThrow("--drain");
    expect(() => parseArgs([])).toThrow("say `status` or `pull`");
    expect(() => parseArgs(["push"])).toThrow("say `status` or `pull`");
  });
});
