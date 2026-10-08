import { describe, expect, it, beforeEach } from "vitest";
import { invoke, registerCommands, resetCommands } from "./core";

describe("the fake invoke", () => {
  beforeEach(() => resetCommands());

  it("dispatches to a registered handler by name", async () => {
    registerCommands({ ping: (args: { n: number }) => args.n + 1 });
    await expect(invoke("ping", { n: 1 })).resolves.toBe(2);
  });

  it("rejects an unregistered command by name, the way Tauri does", async () => {
    await expect(invoke("nope")).rejects.toThrow(/nope/);
  });

  it("surfaces a handler's throw as a rejection carrying its message", async () => {
    registerCommands({
      boom: () => {
        throw new Error("The collection is busy. Try again.");
      },
    });
    await expect(invoke("boom")).rejects.toThrow("The collection is busy. Try again.");
  });
});
