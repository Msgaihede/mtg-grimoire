import { describe, expect, it } from "vitest";
import {
  claimDatabase,
  DATABASE_LOCK,
  RETRY_BOUND_MS,
  RETRY_DELAYS_MS,
  retryDelay,
  type LockManagerLike,
} from "./holder";

describe("the database's lock", () => {
  it("has one name, and it is asked for without waiting", async () => {
    const asked: { name: string; options: unknown }[] = [];
    const locks: LockManagerLike = {
      request(name, options, callback) {
        asked.push({ name, options });
        return Promise.resolve(callback(null));
      },
    };
    await claimDatabase(locks).claim;
    expect(DATABASE_LOCK).toBe("mtg-grimoire:database");
    // `ifAvailable`: a second tab must be told now, not queued behind the first for its life.
    expect(asked).toEqual([{ name: DATABASE_LOCK, options: { ifAvailable: true } }]);
  });

  it("is this document's when it was free, and is held until it is let go", async () => {
    let lockEnded = false;
    const locks: LockManagerLike = {
      request: (_name, _options, callback) =>
        Promise.resolve(callback({})).then(() => void (lockEnded = true)),
    };
    const claimed = claimDatabase(locks);
    await expect(claimed.claim).resolves.toBe("ours");
    await new Promise((done) => setTimeout(done, 0));
    // Held by a promise nothing settles: the browser ends it with the document.
    expect(lockEnded).toBe(false);

    claimed.release();
    await new Promise((done) => setTimeout(done, 0));
    expect(lockEnded).toBe(true);
  });

  it("is another document's when the browser hands back no lock", async () => {
    const locks: LockManagerLike = {
      request: (_name, _options, callback) => Promise.resolve(callback(null)),
    };
    const claimed = claimDatabase(locks);
    await expect(claimed.claim).resolves.toBe("elsewhere");
    // Nothing to let go, and letting go is still safe to call.
    expect(() => claimed.release()).not.toThrow();
  });

  it("is unknown where there is nobody to ask, where the ask is refused, and where it throws", async () => {
    await expect(claimDatabase(undefined).claim).resolves.toBe("unknown");
    const refusing: LockManagerLike = {
      request: () => Promise.reject(new DOMException("denied", "SecurityError")),
    };
    await expect(claimDatabase(refusing).claim).resolves.toBe("unknown");
    const throwing: LockManagerLike = {
      request: () => {
        throw new DOMException("no", "InvalidStateError");
      },
    };
    await expect(claimDatabase(throwing).claim).resolves.toBe("unknown");
  });
});

describe("asking again for a pool that is still held", () => {
  it("waits 200 ms, then 400, then 800 for every ask after", () => {
    expect(RETRY_DELAYS_MS).toEqual([200, 400, 800]);
    expect(retryDelay(1, 0)).toBe(200);
    expect(retryDelay(2, 200)).toBe(400);
    expect(retryDelay(3, 600)).toBe(800);
    expect(retryDelay(4, 1_400)).toBe(800);
    expect(retryDelay(9, 5_400)).toBe(800);
  });

  it("stops at ten seconds from the first refusal, and never waits past them", () => {
    // Three times the longest hold seen, a little over 3 s (`holder.ts`).
    expect(RETRY_BOUND_MS).toBe(10_000);
    expect(retryDelay(14, 9_800)).toBe(200);
    expect(retryDelay(15, 10_000)).toBeNull();
    expect(retryDelay(15, 12_000)).toBeNull();
  });
});
