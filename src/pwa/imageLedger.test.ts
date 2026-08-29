import { describe, expect, it } from "vitest";
import {
  AVG_IMAGE_BYTES,
  DEFAULT_CAP_BYTES,
  MAX_CAP_BYTES,
  admit,
  evictions,
  forget,
  measuredSize,
  parseLedger,
  serializeLedger,
  ledgerWriter,
  touch,
  withCap,
  type Ledger,
} from "@/pwa/imageLedger";

const KB = 65_000; // ~65 KB per image: 519 MB over 7 929 files in the live cache.

describe("the cap", () => {
  it("defaults to 256 MB, which is about 3 900 cards", () => {
    expect(DEFAULT_CAP_BYTES).toBe(256 * 1_000_000);
    expect(Math.floor(DEFAULT_CAP_BYTES / KB)).toBeGreaterThan(3_800);
  });

  it("is clamped to the range the reader is offered", () => {
    expect(withCap(parseLedger(null), 1)).toMatchObject({ cap: DEFAULT_CAP_BYTES });
    expect(withCap(parseLedger(null), 9e12)).toMatchObject({ cap: MAX_CAP_BYTES });
    expect(MAX_CAP_BYTES).toBe(1_000 * 1_000_000);
  });
});

describe("what gets thrown away", () => {
  it("throws away nothing while there is room", () => {
    let l = parseLedger(null);
    for (let i = 0; i < 10; i++) l = admit(l, `/img/${i}`, KB, i);
    expect(evictions(l)).toEqual([]);
  });

  it("throws away the least recently used first, and only until it is under the cap", () => {
    let l = withCap(parseLedger(null), DEFAULT_CAP_BYTES);
    l = admit(l, "/a", 100_000_000, 1);
    l = admit(l, "/b", 100_000_000, 2);
    l = admit(l, "/c", 100_000_000, 3);
    // 300 MB against 256: one 100 MB entry has to go, and it is the oldest *use*.
    expect(evictions(l)).toEqual(["/a"]);
  });

  it("counts a hit, so a card the reader keeps looking at outlives one they saw once", () => {
    let l = withCap(parseLedger(null), DEFAULT_CAP_BYTES);
    l = admit(l, "/a", 100_000_000, 1);
    l = admit(l, "/b", 100_000_000, 2);
    l = touch(l, "/a", 4);
    l = admit(l, "/c", 100_000_000, 5);
    expect(evictions(l)).toEqual(["/b"]);
  });

  it("re-admitting an entry replaces its size rather than adding to it", () => {
    let l = parseLedger(null);
    l = admit(l, "/a", 100, 1);
    l = admit(l, "/a", 200, 2);
    expect(l.bytes).toBe(200);
  });

  /**
   * **Not in the plan, and the ledger is a fiction without it.** `evictions` says what to
   * delete and changes nothing; the worker then deletes those entries from Cache Storage and
   * writes the ledger back. Written back unchanged, `bytes` still counts every file that was
   * just thrown away — so the next request evicts again, and again, until the cache is empty
   * and the arithmetic still says it is full.
   */
  it("forgets what was thrown away, and takes its bytes with it", () => {
    let l = withCap(parseLedger(null), DEFAULT_CAP_BYTES);
    l = admit(l, "/a", 100_000_000, 1);
    l = admit(l, "/b", 100_000_000, 2);
    l = admit(l, "/c", 100_000_000, 3);
    l = forget(l, evictions(l));
    expect(l.bytes).toBe(200_000_000);
    expect(Object.keys(l.size).sort()).toEqual(["/b", "/c"]);
    expect(l.used["/a"]).toBeUndefined();
    // And with the oldest gone it is under the cap again, which is the whole point.
    expect(evictions(l)).toEqual([]);
  });

  it("forgets a url it never held without going negative", () => {
    const l = forget(admit(parseLedger(null), "/a", 100, 1), ["/nope"]);
    expect(l.bytes).toBe(100);
  });
});

/**
 * An `<img>` fetch is `mode: "no-cors"`, so the response is **opaque**: `status` is 0, `ok` is
 * false and `blob().size` is 0 whatever came down the wire. Cache Storage stores it happily —
 * that is how every image cache on the web works — but the byte count has to come from
 * somewhere, and the live cache's own average is the only honest number available.
 */
describe("sizing a response the browser will not let us read", () => {
  it("takes the byte count when there is one", () => {
    expect(measuredSize(123_456)).toBe(123_456);
  });

  it("falls back to the measured average rather than to zero", () => {
    expect(measuredSize(0)).toBe(AVG_IMAGE_BYTES);
    expect(AVG_IMAGE_BYTES).toBe(65_000);
  });
});

describe("the ledger on disk", () => {
  it("round-trips", () => {
    let l = withCap(parseLedger(null), MAX_CAP_BYTES);
    l = admit(l, "/a", KB, 1);
    expect(parseLedger(serializeLedger(l))).toEqual(l);
  });

  /**
   * The ledger lives in the same Cache Storage as the images and is evicted with them — but not
   * necessarily *at the same moment*. A missing or corrupt ledger must cost the reader nothing
   * worse than one cold cache, never an exception in a `fetch` handler.
   */
  it("comes back empty from anything it cannot read", () => {
    for (const bad of [null, "", "{not json", "[]", '{"entries":3}']) {
      const l = parseLedger(bad);
      expect(l.bytes).toBe(0);
      expect(l.cap).toBe(DEFAULT_CAP_BYTES);
    }
  });
});

/**
 * **The race that shipped, and the control that proves this test can see it.**
 *
 * A wall of card art fires dozens of concurrent cache misses, each running
 * `read → mutate → write` on one stored ledger. Interleaved, all but the last write back a copy
 * that predates the others. Measured in the shipped web build on 2026-08-29 from an empty cache:
 * **78 pictures cached, 9 in the ledger** — an 8.7× under-count, which put the 256 MB cap out of
 * reach of anything short of ~2.2 GB.
 *
 * The first case below is the **unserialised** shape, written out rather than imported: it is
 * what `sw.ts` did, and it is here so that this file demonstrably reproduces the defect rather
 * than merely passing over the fix. If it ever starts passing, the store has stopped
 * interleaving and the second case has stopped proving anything.
 */
describe("ledgerWriter", () => {
  /** A ledger store whose read and write both yield, which is what lets callers interleave. */
  function store() {
    let stored = serializeLedger(parseLedger(null));
    let writes = 0;
    return {
      writes: () => writes,
      current: () => parseLedger(stored),
      read: async () => {
        await Promise.resolve();
        return parseLedger(stored);
      },
      write: async (ledger: Ledger) => {
        await Promise.resolve();
        writes += 1;
        stored = serializeLedger(ledger);
      },
    };
  }

  const urls = Array.from({ length: 40 }, (_, i) => `https://cards.example/${i}.webp`);

  it("loses all but a handful of concurrent writes without serialisation — the shipped bug", async () => {
    const s = store();

    await Promise.all(
      urls.map(async (url) => {
        const ledger = await s.read();
        await s.write(admit(ledger, url, 1000, 1));
      }),
    );

    const kept = Object.keys(s.current().size).length;
    expect(kept).toBeLessThan(urls.length);
    // Not a tautology dressed as an assertion: 40 interleaved read-modify-writes keep a very
    // small number, and the live measurement's ratio was 9 of 78. If this ever reaches 40 the
    // fake has stopped interleaving and the case below is worthless.
    expect(kept).toBeLessThanOrEqual(2);
  });

  it("keeps every concurrent write", async () => {
    const s = store();
    const mutate = ledgerWriter(s.read, s.write);

    await Promise.all(urls.map((url) => mutate((ledger) => admit(ledger, url, 1000, 1))));

    const led = s.current();
    expect(Object.keys(led.size)).toHaveLength(urls.length);
    expect(led.bytes).toBe(urls.length * 1000);
  });

  /**
   * **It re-reads every time on purpose, and a memo is the thing that was tried and removed.**
   * The worker is the only writer, so caching the ledger in memory looks free — but the image
   * cache can be deleted underneath it by storage eviction or by a reader clearing site data,
   * and a memoised writer then keeps describing files that are gone. Driven in a real browser
   * on 2026-08-29 the memoised draft produced 45 images cached and no ledger at all. The reads
   * are serialised anyway and the blob is small; this is correctness bought cheaply.
   */
  it("re-reads the store for every mutation rather than trusting a cached copy", async () => {
    const s = store();
    let reads = 0;
    const mutate = ledgerWriter(async () => {
      reads += 1;
      return s.read();
    }, s.write);

    await Promise.all(urls.map((url) => mutate((ledger) => admit(ledger, url, 1000, 1))));

    expect(reads).toBe(urls.length);
    expect(s.writes()).toBe(urls.length);
    // The point of re-reading is that every mutation still sees its predecessors.
    expect(Object.keys(s.current().size)).toHaveLength(urls.length);
  });

  it("survives a failed write and re-reads rather than trusting a value that never landed", async () => {
    const s = store();
    let failNext = true;
    const mutate = ledgerWriter(s.read, async (ledger) => {
      if (failNext) {
        failNext = false;
        throw new Error("cache write failed");
      }
      await s.write(ledger);
    });

    await expect(mutate((l) => admit(l, urls[0], 1000, 1))).rejects.toThrow("cache write failed");

    // The queue must not stay rejected: a single failure that poisoned it would stop the ledger
    // being written for the life of the worker, which is the 256 MB cap silently switching off.
    await mutate((l) => admit(l, urls[1], 2000, 2));

    const led = s.current();
    expect(Object.keys(led.size)).toEqual([urls[1]]);
    expect(led.bytes).toBe(2000);
  });

  it("runs mutations in the order they were queued", async () => {
    const s = store();
    const mutate = ledgerWriter(s.read, s.write);
    const order: number[] = [];

    await Promise.all(
      [1, 2, 3].map((n) =>
        mutate((ledger) => {
          order.push(n);
          return admit(ledger, `https://cards.example/${n}.webp`, n, n);
        }),
      ),
    );

    expect(order).toEqual([1, 2, 3]);
  });
});
