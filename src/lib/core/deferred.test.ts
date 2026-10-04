import { describe, expect, it, vi } from "vitest";
import { deferredCore, refusedCore } from "./deferred";
import type { Core } from "./types";

/** A core that records what it was asked, and a way to emit through it. */
function recording() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const off = vi.fn();
  const core: Core = {
    call: vi.fn(() => Promise.resolve("answered")) as Core["call"],
    listen: vi.fn((event: string, handler: (payload: never) => void) => {
      handlers.set(event, handler as (payload: unknown) => void);
      return off;
    }) as Core["listen"],
  };
  return { core, off, emit: (event: string, payload: unknown) => handlers.get(event)?.(payload) };
}

describe("a core whose implementation has not arrived", () => {
  it("loads nothing until it is used, and then loads once", async () => {
    const { core } = recording();
    const load = vi.fn(() => Promise.resolve(core));
    const deferred = deferredCore(load);
    expect(load).not.toHaveBeenCalled();

    deferred.listen("startup:changed", () => {});
    await deferred.call("startup_status");
    await deferred.call("list_sets", { paper: true }, { headers: { a: "b" } });

    expect(load).toHaveBeenCalledTimes(1);
    expect(core.call).toHaveBeenNthCalledWith(1, "startup_status", undefined, undefined);
    expect(core.call).toHaveBeenNthCalledWith(
      2,
      "list_sets",
      { paper: true },
      { headers: { a: "b" } },
    );
  });

  it("answers a call with what the implementation answered", async () => {
    const { core } = recording();
    await expect(deferredCore(() => Promise.resolve(core)).call("list_sets")).resolves.toBe(
      "answered",
    );
  });

  it("subscribes once the implementation is there, and hands on its unsubscribe", async () => {
    const { core, off, emit } = recording();
    const seen: unknown[] = [];
    const stop = deferredCore(() => Promise.resolve(core)).listen("sync:progress", (payload) =>
      seen.push(payload),
    );
    await Promise.resolve();

    emit("sync:progress", { done: 1 });
    expect(seen).toEqual([{ done: 1 }]);
    stop();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("never subscribes a handler that was unsubscribed before the implementation came", async () => {
    // A component can unmount before the chunk lands; its handler must not be attached then.
    const { core } = recording();
    let arrive: ((core: Core) => void) | undefined;
    const deferred = deferredCore(() => new Promise<Core>((resolve) => (arrive = resolve)));

    const stop = deferred.listen("sync:progress", () => {});
    stop();
    arrive?.(core);
    await Promise.resolve();
    await Promise.resolve();

    expect(core.listen).not.toHaveBeenCalled();
  });

  it("rejects a call, and swallows a subscription, when the implementation never comes", async () => {
    const deferred = deferredCore(() => Promise.reject(new Error("chunk gone")));
    const stop = deferred.listen("sync:progress", () => {});
    await expect(deferred.call("list_sets")).rejects.toThrow("chunk gone");
    expect(() => stop()).not.toThrow();
  });
});

describe("a core for a host that could not be loaded", () => {
  it("tells the gate it failed and that a reload can cure it, and refuses everything else", async () => {
    const core = refusedCore("Could not finish loading.");
    // An answer, not a rejection: the gate reads a rejected ask as *still loading* and would
    // wait on it for ever.
    await expect(core.call("startup_status")).resolves.toEqual({
      state: "failed",
      message: "Could not finish loading.",
      reload: true,
    });
    await expect(core.call("list_sets")).rejects.toBe("Could not finish loading.");
    expect(() => core.listen("startup:changed", () => {})()).not.toThrow();
  });
});
