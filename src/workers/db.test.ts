import { describe, expect, it } from "vitest";
import { once } from "./db";

/**
 * `once` is what stops the Worker instantiating the wasm module twice, which is what killed
 * roughly two first runs in three until 2026-08-28. The failure it prevents is specifically
 * *concurrent* re-entry — two `postMessage`s landing before the first `await` resolves — so
 * the concurrent case is the one worth asserting. A test that only calls it twice in
 * sequence passes against the broken `if (!glue)` guard as well, and did.
 */
describe("once", () => {
  it("runs the work once for callers that overlap, and hands them all the same promise", async () => {
    let calls = 0;
    let release: (value: string) => void = () => {};
    const guarded = once(() => {
      calls += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });

    // Both callers arrive while the work is still in flight — the shape a Worker message
    // loop produces, and the shape the old guard could not see.
    const first = guarded();
    const second = guarded();
    expect(calls).toBe(1);

    release("ready");
    await expect(first).resolves.toBe("ready");
    await expect(second).resolves.toBe("ready");
    expect(await guarded()).toBe("ready");
    expect(calls).toBe(1);
  });

  it("does not run the work again after it failed", async () => {
    let calls = 0;
    const guarded = once(() => {
      calls += 1;
      return Promise.reject(new Error("no wasm here"));
    });

    // A retry would be a second instantiate of a module that may already be half-built,
    // which is the thing being prevented. The page's answer to a failed open is a reload.
    await expect(guarded()).rejects.toThrow("no wasm here");
    await expect(guarded()).rejects.toThrow("no wasm here");
    expect(calls).toBe(1);
  });
});
