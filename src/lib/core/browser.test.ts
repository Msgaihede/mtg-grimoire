import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserCore } from "@/lib/core/browser";

/**
 * A Worker that never runs anything. `posted` is what the core sent; `reply` is how a test
 * plays the Worker's part, which is the only way to control the ordering this suite is
 * about.
 */
class FakeWorker {
  posted: unknown[] = [];
  terminated = false;
  private listeners = new Set<(e: MessageEvent) => void>();

  postMessage(data: unknown) {
    this.posted.push(data);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    if (type === "message") this.listeners.add(fn);
  }
  removeEventListener(_type: string, fn: (e: MessageEvent) => void) {
    this.listeners.delete(fn);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: unknown) {
    for (const fn of this.listeners) fn({ data } as MessageEvent);
  }
}

let worker: FakeWorker;
let spawned: number;
const core = () => {
  spawned = 0;
  worker = new FakeWorker();
  return createBrowserCore(() => {
    spawned += 1;
    return worker as unknown as Worker;
  });
};

beforeEach(() => {
  spawned = 0;
});

describe("the browser core", () => {
  it("does not spawn a Worker until something asks it to", () => {
    core();
    expect(spawned).toBe(0);
  });

  it("posts a command with its named arguments and resolves on the matching id", async () => {
    const c = core();
    const answer = c.call("search_cards", { req: { text: "bolt" } });
    expect(worker.posted).toEqual([
      { kind: "call", id: 1, command: "search_cards", args: { req: { text: "bolt" } } },
    ]);
    worker.reply({ kind: "ok", id: 1, result: { total: 1 } });
    await expect(answer).resolves.toEqual({ total: 1 });
  });

  it("sends no args key at all for a no-argument command", async () => {
    const c = core();
    const answer = c.call("list_sets");
    // `toStrictEqual` and NOT `toEqual`, and that is the whole test: `toEqual` treats a key
    // whose value is `undefined` as absent, so a core that always sent `args` would pass it.
    // Measured 2026-08-28 — the mutation this assertion exists to catch survived `toEqual`.
    expect(worker.posted[0]).toStrictEqual({ kind: "call", id: 1, command: "list_sets" });
    worker.reply({ kind: "ok", id: 1, result: [] });
    await expect(answer).resolves.toEqual([]);
  });

  /**
   * The reason ids exist. Two calls out, answered in the opposite order: each promise must
   * get its OWN result, not whichever arrived first.
   */
  it("resolves each call with its own answer whatever order they come back in", async () => {
    const c = core();
    const first = c.call<string>("search_cards", { req: { text: "slow" } });
    const second = c.call<string>("search_cards", { req: { text: "fast" } });

    worker.reply({ kind: "ok", id: 2, result: "fast" });
    worker.reply({ kind: "ok", id: 1, result: "slow" });

    await expect(first).resolves.toBe("slow");
    await expect(second).resolves.toBe("fast");
  });

  it("rejects with the Worker's own message", async () => {
    const c = core();
    const answer = c.call("search_cards", { req: {} });
    worker.reply({ kind: "err", id: 1, message: "unknown command `search_cards`" });
    await expect(answer).rejects.toThrow("unknown command `search_cards`");
  });

  it("hands an event's payload to every subscriber, and stops on unsubscribe", () => {
    const c = core();
    const a = vi.fn();
    const b = vi.fn();
    const offA = c.listen("sync-progress", a);
    c.listen("sync-progress", b);

    worker.reply({ kind: "event", event: "sync-progress", payload: { done: 2000 } });
    expect(a).toHaveBeenCalledWith({ done: 2000 });
    expect(b).toHaveBeenCalledWith({ done: 2000 });

    offA();
    worker.reply({ kind: "event", event: "sync-progress", payload: { done: 4000 } });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("ignores an event nobody is listening for", () => {
    const c = core();
    const seen = vi.fn();
    c.listen("sync-progress", seen);
    worker.reply({ kind: "event", event: "combo-progress", payload: {} });
    expect(seen).not.toHaveBeenCalled();
  });

  /**
   * A React cleanup cannot await, and a component can unmount before anything has
   * subscribed. `listen` is synchronous on the Tauri side for exactly this reason and must
   * be here too.
   */
  it("returns an unsubscribe that is callable immediately", () => {
    const c = core();
    const off = c.listen("sync-progress", vi.fn());
    expect(() => off()).not.toThrow();
    expect(() => off()).not.toThrow();
  });

  it("reuses one Worker across every call and subscription", async () => {
    const c = core();
    const one = c.call("list_sets");
    c.listen("sync-progress", vi.fn());
    const two = c.call("sync_status");
    expect(spawned).toBe(1);
    worker.reply({ kind: "ok", id: 1, result: [] });
    worker.reply({ kind: "ok", id: 2, result: {} });
    await Promise.all([one, two]);
  });
});
