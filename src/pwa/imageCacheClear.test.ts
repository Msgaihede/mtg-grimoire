import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheOutcome } from "@/features/settings/clearOutcome";
import { clearImageCache } from "@/pwa/imageCacheClear";
import type { ImageClearReport } from "@/pwa/imageLedger";

/**
 * A `ServiceWorker` with the one method this reaches, and the reply it plays back.
 *
 * The port arrives in `transfer[0]` exactly as it would at a real worker; posting on it is what
 * the worker's `event.ports[0]?.postMessage(report)` does. `reply` of `undefined` is the worker
 * that never answers — an older build whose message handler does not know the verb and falls
 * off the end of its own `if` chain.
 */
function fakeWorker(reply?: ImageClearReport) {
  return {
    posted: [] as unknown[],
    postMessage(data: unknown, transfer: readonly MessagePort[]) {
      this.posted.push(data);
      if (reply) transfer[0].postMessage(reply);
    },
  };
}

/** `configurable` so `afterEach` can take it off again — jsdom has no `serviceWorker` at all. */
function install(container: unknown) {
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "serviceWorker");
});

const FREED: ImageClearReport = { files: 63, bytes: 4_095_000, failed: 0 };

describe("clearing the picture cache from the page", () => {
  it("asks the controlling worker and answers in the panel's own DTO", async () => {
    const worker = fakeWorker(FREED);
    install({ controller: worker });

    await expect(clearImageCache()).resolves.toEqual({
      files: 63,
      bytes: 4_095_000,
      // Always 0 on this target: `images.rs` is gated out of the wasm crate, so nothing in a
      // browser has ever written an `image_cache` row for the sweep to drop.
      rows: 0,
      failed: 0,
    });
    expect(worker.posted).toEqual([{ type: "CLEAR_IMAGE_CACHE" }]);
  });

  it("carries the count of what would not go, which is not an error", async () => {
    install({ controller: fakeWorker({ files: 40, bytes: 2_600_000, failed: 2 }) });
    await expect(clearImageCache()).resolves.toMatchObject({ files: 40, failed: 2 });
  });

  /**
   * **`npm run web:dev` registers no service worker at all** — measured, and in
   * `pwa-shell.md` — and a private window may have none either. Nothing has ever written to
   * `IMAGE_CACHE` in that browser, because the worker is its only writer, so "nothing was
   * cached" is the fact rather than a shrug.
   */
  it("answers nothing-cached when the browser has no service worker at all", async () => {
    expect("serviceWorker" in navigator).toBe(false);
    await expect(clearImageCache()).resolves.toEqual({
      files: 0,
      bytes: 0,
      rows: 0,
      failed: 0,
    });
  });

  /**
   * The other half of that answer, and the reason it is a resolve rather than a rejection: the
   * sentence a reader ends up reading is true. A rejection would paint the panel red for a
   * button that did exactly what it should have.
   */
  it("reads as a sentence rather than as a failure", async () => {
    expect(cacheOutcome(await clearImageCache())).toBe("There was nothing cached to clear.");
  });

  /**
   * A document loaded around the worker — a shift-reload, or devtools' bypass — is uncontrolled
   * while a perfectly good worker is active with a full cache. Telling that reader there was
   * nothing cached would be a lie over 256 MB of card art.
   */
  it("falls back to the registration's active worker when the page is not controlled", async () => {
    const worker = fakeWorker(FREED);
    install({
      controller: null,
      getRegistration: () => Promise.resolve({ active: worker }),
    });

    await expect(clearImageCache()).resolves.toMatchObject({ files: 63 });
    expect(worker.posted).toEqual([{ type: "CLEAR_IMAGE_CACHE" }]);
  });

  it("answers nothing-cached when there is a container but no worker anywhere", async () => {
    install({ controller: null, getRegistration: () => Promise.resolve(undefined) });
    await expect(clearImageCache()).resolves.toMatchObject({ files: 0, bytes: 0 });
  });

  /**
   * **The failure this timeout exists for is silent.** `sw.ts`'s message handler is a chain of
   * `if`s with no `else`, so a worker that does not know the verb answers nothing at all — and
   * a reader who never pressed the update bar is still being served by that older build, by
   * design. Without the timeout the mutation stays `isPending` for the life of the page.
   */
  it("gives up rather than hanging when the worker never answers", async () => {
    install({ controller: fakeWorker() });
    await expect(clearImageCache({ timeoutMs: 5 })).rejects.toThrow(
      "The app's background worker did not answer",
    );
  });

  /**
   * **Written the obvious way, this test cannot fail.** The first draft answered, waited past
   * the timeout and asserted the promise had not rejected - which is true whether or not the
   * timer is cancelled, because rejecting a settled promise is a no-op. Deleting the
   * `clearTimeout` left it green (mutation round, 2026-08-31). What the cancel is actually
   * worth is a timer that does not sit for another thirty seconds holding the channel and its
   * closure alive, and the only way to see that from here is to watch the call.
   */
  it("cancels its own timer once the worker has answered", async () => {
    const cancelled = vi.spyOn(globalThis, "clearTimeout");
    install({ controller: fakeWorker(FREED) });

    await expect(clearImageCache({ timeoutMs: 5 })).resolves.toMatchObject({ files: 63 });

    expect(cancelled).toHaveBeenCalledTimes(1);
    cancelled.mockRestore();
  });
});
