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

  /**
   * **A refresh is a download, so it goes to a wasm export rather than to `web::route`** —
   * and the divert lives here so that no Settings panel needs an `isWebTarget()` branch.
   * `ipc.combosRefresh(true)` reaches the export on a browser and the Tauri command on a
   * desktop, and the panel cannot tell.
   */
  it("diverts the four download commands to a feed refresh", async () => {
    const c = core();
    const answer = c.call("combos_refresh", { force: true });
    expect(worker.posted).toEqual([{ kind: "feed-refresh", id: 1, feed: "combos", force: true }]);
    // The ordinary `ok` on the same id: the promise, the rejection and the progress events
    // are all the ones every other call already gets.
    worker.reply({ kind: "ok", id: 1, result: { combos: 105_478 } });
    await expect(answer).resolves.toEqual({ combos: 105_478 });
  });

  it("diverts both tag refreshes and the price feed too", () => {
    const c = core();
    c.call("oracle_tags_refresh", { force: false });
    c.call("art_tags_refresh", { force: true });
    c.call("marketplace_feed_refresh", { marketplace: "cardkingdom" });
    expect(worker.posted).toEqual([
      { kind: "feed-refresh", id: 1, feed: "tags", dataset: "oracle", force: false },
      { kind: "feed-refresh", id: 2, feed: "tags", dataset: "art", force: true },
      { kind: "feed-refresh", id: 3, feed: "prices", marketplace: "cardkingdom" },
    ]);
  });

  /**
   * The *status* reads share a prefix with the refreshes and must not be diverted: they are
   * ordinary routed commands, and sending one to an export that does not exist would hang
   * the panel's query for ever with nothing on screen to say why.
   */
  it("leaves the status commands as ordinary calls", () => {
    const c = core();
    c.call("combos_status");
    c.call("marketplace_feed_status");
    c.call("oracle_tags_status");
    expect(worker.posted).toEqual([
      { kind: "call", id: 1, command: "combos_status" },
      { kind: "call", id: 2, command: "marketplace_feed_status" },
      { kind: "call", id: 3, command: "oracle_tags_status" },
    ]);
  });

  /** A refresh that failed rejects the mutation the panel is already watching. */
  it("rejects a failed refresh on its own id", async () => {
    const c = core();
    const answer = c.call("combos_refresh", { force: true });
    worker.reply({ kind: "err", id: 1, message: "could not reach Commander Spellbook" });
    await expect(answer).rejects.toThrow("could not reach Commander Spellbook");
  });

  /**
   * The progress channel is the desktop's own event name, forwarded by the Worker — so
   * `ipc.onCombosProgress`, which is `core.listen("combos:progress", …)`, needs no browser
   * branch at all.
   */
  it("hands a feed's progress event to the listener the panel registered", () => {
    const c = core();
    const seen = vi.fn();
    c.listen("combos:progress", seen);
    worker.reply({
      kind: "event",
      event: "combos:progress",
      payload: { phase: "downloading", done: 1, total: 2 },
    });
    expect(seen).toHaveBeenCalledWith({ phase: "downloading", done: 1, total: 2 });
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
