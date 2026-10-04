import { IMAGE_VARIANTS, WEB_IMAGE_PREFIX } from "../../../images";

/**
 * **Card pictures in a browser: what the service worker decides about one**, as functions with no
 * global in them (the light-app spec §3.5 — "a service-worker route answers it — asking the core
 * for the Scryfall URI, fetching it, and keeping it in Cache Storage").
 *
 * **Compiled twice** — by the root program (the `DOM` lib; the suite runs it there) and by
 * `tsconfig.web-sw.json` (the `WebWorker` lib) — so it names only what both have. The Cache
 * Storage calls are `serve.ts`'s, over the two structural types at the foot of this file.
 */

/**
 * The cache the pictures are kept in. **Not per build**: a deploy that threw the pictures away
 * would undo the whole point of keeping them. The `v1` is for a day the *stored shape* changes —
 * the two headers below — and nothing else moves it.
 */
export const PICTURE_CACHE = "grimoire-pictures-v1";

/**
 * When a picture was stored, in Unix milliseconds — written on the stored response by the worker.
 * It is the picture's **used-stamp** as well: Cache Storage keeps no access time, so a picture
 * found older than {@link REFRESH_AFTER_MS} on a hit is put back under a new stamp, which also
 * moves it to the young end of the cache's own order ({@link overBudget}).
 */
export const STORED_HEADER = "X-Grimoire-Stored";

/**
 * The address the bytes came from, Scryfall's `?<epoch>` cache-buster included. That query is
 * the one invalidation signal the desktop's cache has (`image-cache.md`: `image_cache.source_uri`),
 * and it is this cache's too — compared when a picture is refreshed, never on an ordinary hit.
 */
export const SOURCE_HEADER = "X-Grimoire-Source";

/** What the engine's `card_image_source` answers for one protocol path. */
export type ImageSource =
  /** A `https://cards.scryfall.io/…` address to fetch. */
  | { kind: "uri"; uri: string }
  /** A card with no picture: the placeholder the desktop serves for it, as SVG text. */
  | { kind: "missing"; svg: string }
  /** No such card, or no such face. */
  | { kind: "unknown" };

/** The engine's answer, or `null` for anything that is not one — an older engine, a refusal. */
export function readSource(value: unknown): ImageSource | null {
  if (typeof value !== "object" || value === null || !("kind" in value)) return null;
  const { kind } = value;
  if (kind === "unknown") return { kind };
  if (kind === "uri" && "uri" in value && typeof value.uri === "string") {
    return { kind, uri: value.uri };
  }
  if (kind === "missing" && "svg" in value && typeof value.svg === "string") {
    return { kind, svg: value.svg };
  }
  return null;
}

/**
 * The one host a picture is fetched from. The desktop's fetcher refuses an off-host address
 * (`images::is_fetchable`), and so does this: the engine's answer is data from a database a sync
 * wrote, and the worker's `fetch` is the hosting policy's `connect-src` to keep narrow.
 */
export const PICTURE_HOST = "cards.scryfall.io";

export function isFetchable(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === "https:" && url.hostname === PICTURE_HOST;
  } catch {
    return false;
  }
}

/** One picture request, read: the key it is cached under and the path the engine is asked by. */
export interface PictureAsk {
  /**
   * `<origin>/mtgimg/<variant>/<id>/<face>` — **the address without its query**. `useImageRetry`
   * marks a retry `?retry=N` and `CardImage` a silent picture's second ask `?stall=N`; each is a
   * new request for the same picture, and a key that kept the mark would store one picture three
   * times and miss the cache on every retry.
   */
  key: string;
  /** `/<variant>/<id>/<face>`: the protocol path, as the desktop's handler parses one. */
  path: string;
}

const VARIANTS: readonly string[] = IMAGE_VARIANTS;

/**
 * Whether `pathname` is under the picture prefix, and which picture it names.
 *
 * `null` is *not a picture request*; `"malformed"` is one this grammar refuses — a variant
 * nothing stores, a face that is not a number, a path with more or fewer segments. The second is
 * answered 404 and never passed to the engine or the network: under this prefix nothing else
 * lives, and the hosting's own answer for it would be a file that does not exist.
 */
export function pictureOf(origin: string, pathname: string): PictureAsk | "malformed" | null {
  if (pathname !== WEB_IMAGE_PREFIX && !pathname.startsWith(`${WEB_IMAGE_PREFIX}/`)) return null;
  const path = pathname.slice(WEB_IMAGE_PREFIX.length);
  const match = /^\/([a-z]+)\/([^/]+)\/(\d{1,3})$/.exec(path);
  if (!match || !VARIANTS.includes(match[1])) return "malformed";
  return { key: `${origin}${pathname}`, path };
}

/**
 * **How many pictures the cache holds before the oldest go: 3 000.**
 *
 * The desktop's budget is bytes and a used-stamp per file (512 MiB, 90 days idle). A browser
 * offers neither cheaply: Cache Storage has no access time and no size, and a ledger beside it is
 * a second record that can disagree with the first — round one's counted 9 of 78 pictures after
 * one wall. So the bound is **entries**, the one figure the cache itself answers exactly
 * (`keys()`), and the order is the cache's own: insertion order, oldest first. At `display`'s
 * ~93 KB that is about 280 MB, beside a corpus of ~960 MB in the same origin's quota; a `thumb`
 * or an `art` crop is smaller, so the figure is a ceiling in bytes rather than a target.
 *
 * **Nothing is spared**, where the desktop spares what the reader owns: that rule exists for the
 * pre-warm, which re-fetches an owned picture the budget evicts, and a browser has no pre-warm.
 */
export const PICTURE_LIMIT = 3_000;

/**
 * How far past the limit the cache may run before a sweep. A sweep reads every key, so it is
 * paid once per this many new pictures rather than once per picture on a wall of misses.
 */
export const SWEEP_SLACK = 100;

/**
 * The keys to delete so that `limit` remain — the oldest, which `keys()` lists first.
 *
 * **Oldest by when it was last put, which is not quite when it was last seen**: a hit rewrites
 * a picture only once it is {@link REFRESH_AFTER_MS} old, so the order is least-recently-used at
 * a week's resolution. The desktop's stamp has a day's (`image-cache.md`); both are fine for a
 * queue this long.
 */
export function overBudget(keys: readonly string[], limit: number = PICTURE_LIMIT): string[] {
  return keys.length > limit ? keys.slice(0, keys.length - limit) : [];
}

/**
 * How old a stored picture is before a hit refreshes it: **a week**, the interval this app
 * re-asks every other Scryfall file at. The picture is served first, from the cache, and then
 * the engine is asked what its address is now — the same address puts the same bytes back under
 * a new stamp, a changed one (Scryfall re-scanned the card) fetches the new picture.
 */
export const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether a picture stored at `storedAt` (the header's text) is due a refresh at `now`. */
export function isStale(storedAt: string | null, now: number): boolean {
  const at = Number(storedAt);
  // A stamp nobody can read is a picture stored by something else: refresh it and find out.
  if (storedAt === null || !Number.isFinite(at)) return true;
  return now - at >= REFRESH_AFTER_MS;
}

/** As much of a `Cache` as the worker and the Settings clear use. A real one is assignable. */
export interface CacheLike {
  /**
   * **`ignoreVary` is part of the type, on every lookup and every delete** (the light-app spec
   * §6: "Cache Storage lookups pass `ignoreVary`, or the offline shell is blank"). A static host
   * answers `Vary: Origin`, a precached entry was stored from a request with no `Origin`, and the
   * page's module scripts carry one — so without it every asset misses, and with the server up
   * nothing shows it. Round one measured the blank page (2026-08-28).
   */
  match(key: string, options: { ignoreVary: true }): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string, options: { ignoreVary: true }): Promise<boolean>;
  keys(): Promise<readonly { url: string }[]>;
}

/** As much of `caches` as is used. */
export interface CachesLike {
  open(name: string): Promise<CacheLike>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

/** What emptying the picture cache freed — `CacheCleared` without the desktop's `rows`. */
export interface PicturesCleared {
  files: number;
  bytes: number;
  failed: number;
}

/**
 * Empty the picture cache and say what went — Settings' *Clear cache*, in a browser.
 *
 * **Entry by entry, not `caches.delete`**: the worker holds this cache open, and a picture it
 * stores a moment later must land in a cache that still exists. **The bytes are each stored
 * response's own `Content-Length`**, which the worker writes from the body it measured, so the
 * sentence the panel prints is a sum of real sizes and not an average.
 */
export async function clearPictures(caches: CachesLike): Promise<PicturesCleared> {
  // `keys()` first: opening a cache creates it, and a browser that never stored a picture
  // should not be left an empty one for having asked.
  if (!(await caches.keys()).includes(PICTURE_CACHE)) return { files: 0, bytes: 0, failed: 0 };
  const cache = await caches.open(PICTURE_CACHE);
  let files = 0;
  let bytes = 0;
  let failed = 0;
  for (const { url } of await cache.keys()) {
    const stored = await cache.match(url, { ignoreVary: true });
    const size = Number(stored?.headers.get("Content-Length"));
    if (await cache.delete(url, { ignoreVary: true })) {
      files += 1;
      if (Number.isFinite(size)) bytes += size;
    } else {
      failed += 1;
    }
  }
  return { files, bytes, failed };
}
