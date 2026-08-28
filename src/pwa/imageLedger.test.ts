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
  touch,
  withCap,
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
