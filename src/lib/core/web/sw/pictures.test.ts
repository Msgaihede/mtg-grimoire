import { describe, expect, it } from "vitest";
import { IMAGE_VARIANTS, WEB_IMAGE_PREFIX } from "../../../images";
import {
  clearPictures,
  isFetchable,
  isStale,
  overBudget,
  PICTURE_CACHE,
  PICTURE_LIMIT,
  pictureOf,
  readSource,
  REFRESH_AFTER_MS,
  type CacheLike,
  type CachesLike,
} from "./pictures";

const ORIGIN = "https://mtg-grimoire.app";
const ID = "0000419b-0bba-4488-8f7a-6194544ce91d";

describe("a picture's path", () => {
  it("is the protocol's own path under the prefix, for each variant the cache stores", () => {
    for (const variant of IMAGE_VARIANTS) {
      expect(pictureOf(ORIGIN, `${WEB_IMAGE_PREFIX}/${variant}/${ID}/0`)).toEqual({
        key: `${ORIGIN}${WEB_IMAGE_PREFIX}/${variant}/${ID}/0`,
        path: `/${variant}/${ID}/0`,
      });
    }
  });

  it("addresses the back face separately", () => {
    const front = pictureOf(ORIGIN, `/mtgimg/display/${ID}/0`);
    const back = pictureOf(ORIGIN, `/mtgimg/display/${ID}/1`);
    expect(front).not.toEqual(back);
    expect(back).toMatchObject({ path: `/display/${ID}/1` });
  });

  it("is not a picture's at all outside the prefix", () => {
    for (const path of ["/", "/search", "/decks/12", "/mtgimgs/display/a/0", "/display/a/0"]) {
      expect(pictureOf(ORIGIN, path)).toBeNull();
    }
  });

  it("is refused under the prefix when it names no picture", () => {
    for (const path of [
      "/mtgimg",
      "/mtgimg/",
      "/mtgimg/display",
      `/mtgimg/display/${ID}`,
      `/mtgimg/display/${ID}/`,
      `/mtgimg/display/${ID}/front`,
      `/mtgimg/display/${ID}/0/extra`,
      `/mtgimg/png/${ID}/0`,
      `/mtgimg/cover/7`,
      `/mtgimg/display//0`,
      `/mtgimg/display/${ID}/9999`,
    ]) {
      expect(pictureOf(ORIGIN, path), path).toBe("malformed");
    }
  });
});

describe("the engine's answer", () => {
  it("is read as one of the three it can be", () => {
    expect(readSource({ kind: "uri", uri: "https://cards.scryfall.io/a.webp?1" })).toEqual({
      kind: "uri",
      uri: "https://cards.scryfall.io/a.webp?1",
    });
    expect(readSource({ kind: "missing", svg: "<svg/>" })).toEqual({ kind: "missing", svg: "<svg/>" });
    expect(readSource({ kind: "unknown" })).toEqual({ kind: "unknown" });
  });

  it("is nothing when it is anything else — an older engine's refusal, a half answer", () => {
    for (const value of [null, undefined, "uri", 7, {}, { kind: "uri" }, { kind: "missing" },
      { kind: "uri", uri: 7 }, { kind: "later" }]) {
      expect(readSource(value)).toBeNull();
    }
  });

  it("is fetched only from Scryfall's picture host, over https", () => {
    expect(isFetchable("https://cards.scryfall.io/large/front/a/b/abc.webp?1783948684")).toBe(true);
    for (const uri of [
      "http://cards.scryfall.io/large/front/a/b/abc.webp",
      "https://errors.scryfall.com/soon.jpg",
      "https://cards.scryfall.io.evil.example/a.webp",
      "https://example.com/?https://cards.scryfall.io/",
      "/mtgimg/display/abc/0",
      "",
    ]) {
      expect(isFetchable(uri), uri).toBe(false);
    }
  });
});

describe("the picture budget", () => {
  const keys = (count: number) => Array.from({ length: count }, (_, at) => `k${at}`);

  it("deletes nothing at or under the limit", () => {
    expect(overBudget(keys(PICTURE_LIMIT))).toEqual([]);
    expect(overBudget([])).toEqual([]);
  });

  it("deletes the oldest, which the cache lists first, down to the limit", () => {
    expect(overBudget(keys(5), 3)).toEqual(["k0", "k1"]);
    expect(overBudget(keys(PICTURE_LIMIT + 150))).toHaveLength(150);
    expect(overBudget(keys(PICTURE_LIMIT + 150))[0]).toBe("k0");
  });

  it("calls a picture stale a week after it was stored, and not before", () => {
    const stored = Date.UTC(2026, 9, 4, 12);
    expect(isStale(String(stored), stored)).toBe(false);
    expect(isStale(String(stored), stored + REFRESH_AFTER_MS - 1)).toBe(false);
    expect(isStale(String(stored), stored + REFRESH_AFTER_MS)).toBe(true);
  });

  it("calls a picture with no stamp it can read stale, so it is looked at once", () => {
    expect(isStale(null, 0)).toBe(true);
    expect(isStale("yesterday", 0)).toBe(true);
  });
});

/** A `caches` holding what the test put in it. */
function fakeCaches(pictures: Record<string, number | null> | null, stuck: string[] = []) {
  const entries = new Map(Object.entries(pictures ?? {}));
  const opened: string[] = [];
  const cache: CacheLike = {
    match: async (key) => {
      const size = entries.get(key);
      if (size === undefined) return undefined;
      return new Response("", {
        headers: size === null ? {} : { "Content-Length": String(size) },
      });
    },
    put: async () => undefined,
    delete: async (key) => !stuck.includes(key) && entries.delete(key),
    keys: async () => [...entries.keys()].map((url) => ({ url })),
  };
  const caches: CachesLike = {
    open: async (name) => {
      opened.push(name);
      return cache;
    },
    keys: async () => (pictures === null ? ["grimoire-shell-aaaa"] : ["grimoire-shell-aaaa", PICTURE_CACHE]),
    delete: async () => true,
  };
  return { caches, entries, opened };
}

describe("clearing the picture cache", () => {
  it("deletes every picture and says how many went and what they weighed", async () => {
    const { caches, entries } = fakeCaches({ a: 93_000, b: 61_500, c: 10_250 });
    await expect(clearPictures(caches)).resolves.toEqual({ files: 3, bytes: 164_750, failed: 0 });
    expect(entries.size).toBe(0);
  });

  it("counts a picture that would not go, and does not count its bytes as freed", async () => {
    const { caches, entries } = fakeCaches({ a: 100, b: 200 }, ["b"]);
    await expect(clearPictures(caches)).resolves.toEqual({ files: 1, bytes: 100, failed: 1 });
    expect([...entries.keys()]).toEqual(["b"]);
  });

  it("counts a picture whose size nobody wrote down as a file and no bytes", async () => {
    const { caches } = fakeCaches({ a: null, b: 50 });
    await expect(clearPictures(caches)).resolves.toEqual({ files: 2, bytes: 50, failed: 0 });
  });

  it("answers nothing cached, and makes no cache, in a browser that never stored a picture", async () => {
    const { caches, opened } = fakeCaches(null);
    await expect(clearPictures(caches)).resolves.toEqual({ files: 0, bytes: 0, failed: 0 });
    expect(opened).toEqual([]);
  });
});
