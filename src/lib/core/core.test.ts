import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { tauriCore } from "@/lib/core/tauri";

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
});

describe("the Tauri core", () => {
  it("forwards a command name and its named arguments to invoke, untouched", async () => {
    invoke.mockResolvedValue({ ok: 1 });
    const out = await tauriCore.call("search_cards", { req: { text: "bolt" } });
    expect(invoke).toHaveBeenCalledWith("search_cards", { req: { text: "bolt" } });
    expect(out).toEqual({ ok: 1 });
  });

  it("calls a no-argument command with no argument object", async () => {
    invoke.mockResolvedValue([]);
    await tauriCore.call("list_sets");
    // One argument, not `("list_sets", undefined)`: `ipc.test.ts` writes twenty of its
    // assertions as `toHaveBeenCalledWith("sync_status")` and vitest compares the whole
    // argument list, so the arity is part of what this boundary must not change.
    expect(invoke).toHaveBeenCalledWith("list_sets");
  });

  it("hands the event payload to the handler, not the envelope", async () => {
    // Tauri wraps a payload in { event, id, payload }. Every caller in ipc.ts already
    // unwraps it; the Core interface makes that the boundary's job instead.
    let sink: ((e: { payload: unknown }) => void) | undefined;
    listen.mockImplementation((_name: string, cb: (e: { payload: unknown }) => void) => {
      sink = cb;
      return Promise.resolve(() => {});
    });
    const seen: unknown[] = [];
    tauriCore.listen("sync:progress", (p) => seen.push(p));
    await Promise.resolve();
    sink?.({ payload: { done: 3 } });
    expect(seen).toEqual([{ done: 3 }]);
  });

  it("swallows a subscription that never registers", async () => {
    // Outside a Tauri window the registration rejects. Six subscribers used to carry their own
    // `.catch(() => {})`; a synchronous listen leaves them nothing to attach one to, so this is
    // now the only place that rejection can be handled — and an unhandled one is the failure.
    listen.mockRejectedValue(new Error("not a tauri window"));
    const seen: unknown[] = [];

    const stop = tauriCore.listen("sync:progress", (p) => seen.push(p));
    await Promise.resolve();
    await Promise.resolve();

    expect(() => stop()).not.toThrow();
    expect(seen).toEqual([]);
  });

  it("returns a synchronous unsubscribe that survives being called before listen resolves", async () => {
    const off = vi.fn();
    let resolveListen: ((f: () => void) => void) | undefined;
    listen.mockReturnValue(new Promise<() => void>((r) => (resolveListen = r)));

    const stop = tauriCore.listen("sync:progress", () => {});
    // A component can unmount before Tauri's promise settles. Unsubscribing then must
    // still take effect once it does, or the handler outlives its component.
    stop();
    resolveListen?.(off);
    await Promise.resolve();
    await Promise.resolve();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("forwards a byte payload and its headers to invoke as the third argument", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await tauriCore.call("scanner_frame", bytes, { headers: { "x-scanner-options": "{}" } });
    expect(invoke).toHaveBeenCalledWith("scanner_frame", bytes, {
      headers: { "x-scanner-options": "{}" },
    });
  });
});

describe("the table core", () => {
  it("names the command inside one core_call, its arguments untouched", async () => {
    const { tableCore } = await import("@/lib/core/table");
    invoke.mockResolvedValue({ ok: 1 });
    const out = await tableCore.call("search_cards", { req: { text: "bolt" } });
    expect(invoke).toHaveBeenCalledWith("core_call", {
      name: "search_cards",
      args: { req: { text: "bolt" } },
    });
    expect(out).toEqual({ ok: 1 });
  });

  it("sends no args key for a command called with none", async () => {
    const { tableCore } = await import("@/lib/core/table");
    await tableCore.call("list_sets");
    expect(invoke).toHaveBeenCalledWith("core_call", { name: "list_sets" });
  });

  it("carries a byte payload as base64, its headers as the arguments", async () => {
    const { tableCore } = await import("@/lib/core/table");
    await tableCore.call("scanner_frame", new Uint8Array([0, 1, 2, 255]), {
      headers: { "x-scanner-options": "{}" },
    });
    expect(invoke).toHaveBeenCalledWith("core_call", {
      name: "scanner_frame",
      args: { "x-scanner-options": "{}" },
      body: "AAEC/w==",
    });
  });
});

describe("pickCore", () => {
  it("picks the table only for the mark the light host sets", async () => {
    const { pickCore, HOST_MARK } = await import("@/lib/core");
    const { tableCore } = await import("@/lib/core/table");
    // `mobile/src-tauri/src/lib.rs`'s HOST_MARK sets exactly this; its own test pins the string.
    expect(HOST_MARK).toBe("__GRIMOIRE_CORE__");
    expect(pickCore({ __GRIMOIRE_CORE__: "table" })).toBe(tableCore);
    expect(pickCore({})).toBe(tauriCore);
    expect(pickCore({ __GRIMOIRE_CORE__: "something else" })).toBe(tauriCore);
  });
});
