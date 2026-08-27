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
    // unwraps it; the Core interface makes that the boundary's job instead, so a browser
    // implementation does not have to fake an envelope it has no reason to have.
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
});
