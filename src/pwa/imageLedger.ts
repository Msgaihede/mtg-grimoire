/**
 * The image cache's arithmetic, as data.
 *
 * **Nothing in this file constructs a `Response` or opens a cache**, and that is deliberate:
 * `sw.ts` does every `caches` call and the one constructor, so nothing under `src/` needs a web
 * global jsdom does not have, and every rule about what gets thrown away is under vitest.
 *
 * **This file is compiled twice** — the app program and `tsconfig.sw.json` — so, like
 * `swCore.ts`, it may only name types both `lib.dom` and `lib.webworker` have.
 */

/** Card art, cached by the service worker. Never per-build — see `staleShellCaches`. */
export const IMAGE_CACHE = "grimoire-images";
/** The ledger's key inside that cache. A path no image can collide with. */
export const LEDGER_KEY = "/__grimoire_image_ledger__";

/**
 * 256 MB.
 *
 * From the live cache — 519 MB over 7 929 files, ~65 KB per image — that is **~3 900 cards**,
 * against ~65 MB for a 1 000-card grid and ~6.5 MB for a deck. It keeps the whole web footprint
 * under 1 GB against a 526 MB corpus, which is the number the cap was chosen to hold.
 * **Desktop is uncapped and stays uncapped**; this file is never loaded there.
 */
export const DEFAULT_CAP_BYTES = 256 * 1_000_000;
/** As far as spec §5.4 lets a reader raise it: ~15 000 cards. */
export const MAX_CAP_BYTES = 1_000 * 1_000_000;

/**
 * ~65 KB, from the live cache: 519 MB over 7 929 files.
 *
 * Used only where the browser refuses to say — see {@link measuredSize}.
 */
export const AVG_IMAGE_BYTES = 65_000;

export interface Ledger {
  /** url → the last time it was used, in unix millis. */
  used: Record<string, number>;
  /** url → its size in bytes, measured when it was cached. */
  size: Record<string, number>;
  /** The sum of `size`. Kept rather than recomputed: this is read on every image request. */
  bytes: number;
  cap: number;
}

/** An empty ledger at the default cap. */
function empty(): Ledger {
  return { used: {}, size: {}, bytes: 0, cap: DEFAULT_CAP_BYTES };
}

/**
 * How many bytes an image response actually cost.
 *
 * **An `<img>` fetch is `mode: "no-cors"`, so the response is opaque**: `status` is 0, `ok` is
 * `false`, and `blob().size` is `0` however many bytes arrived. Cache Storage stores it anyway —
 * that is how every image cache on the web works — but the cap needs a number, and the only
 * honest one available is the live cache's own average. A zero here would make the ledger count
 * nothing, so the cap would never bite and the 256 MB would be a number in a settings panel and
 * nowhere else.
 */
export function measuredSize(bytes: number): number {
  return bytes > 0 ? bytes : AVG_IMAGE_BYTES;
}

/** The ledger with a new cap, clamped to the range the reader is offered. */
export function withCap(ledger: Ledger, cap: number): Ledger {
  return { ...ledger, cap: Math.min(MAX_CAP_BYTES, Math.max(DEFAULT_CAP_BYTES, cap)) };
}

/**
 * Record a newly cached file.
 *
 * **Re-admitting replaces the size rather than adding to it.** A card re-fetched after a cache
 * miss would otherwise be counted twice, and the drift is silent and one-directional: the ledger
 * ends up certain the cache is full and evicts everything on every request.
 */
export function admit(ledger: Ledger, url: string, size: number, usedAt: number): Ledger {
  const previous = ledger.size[url] ?? 0;
  return {
    used: { ...ledger.used, [url]: usedAt },
    size: { ...ledger.size, [url]: size },
    bytes: ledger.bytes - previous + size,
    cap: ledger.cap,
  };
}

/** Record a cache *hit*, so a card the reader keeps looking at outlives one they saw once. */
export function touch(ledger: Ledger, url: string, usedAt: number): Ledger {
  if (ledger.size[url] === undefined) return ledger;
  return { ...ledger, used: { ...ledger.used, [url]: usedAt } };
}

/**
 * The urls to delete, oldest *use* first, until the cache would be at or under the cap.
 *
 * Returns `[]` when it already is, which is the ordinary case: the eviction pass runs on every
 * miss and does nothing on almost all of them.
 */
export function evictions(ledger: Ledger): string[] {
  if (ledger.bytes <= ledger.cap) return [];
  const oldestFirst = Object.keys(ledger.size).sort(
    (a, b) => (ledger.used[a] ?? 0) - (ledger.used[b] ?? 0),
  );
  const out: string[] = [];
  let bytes = ledger.bytes;
  for (const url of oldestFirst) {
    if (bytes <= ledger.cap) break;
    out.push(url);
    bytes -= ledger.size[url] ?? 0;
  }
  return out;
}

/**
 * Drop entries the worker has just deleted from Cache Storage.
 *
 * **Without this the ledger is a fiction.** `evictions` changes nothing, so a worker that
 * deleted what it named and wrote the ledger back unchanged would still be counting every file
 * it had just thrown away — and would evict again on the next request, and again, until the
 * cache was empty and the arithmetic still said it was full.
 */
export function forget(ledger: Ledger, urls: readonly string[]): Ledger {
  if (urls.length === 0) return ledger;
  const used = { ...ledger.used };
  const size = { ...ledger.size };
  let bytes = ledger.bytes;
  for (const url of urls) {
    bytes -= size[url] ?? 0;
    delete used[url];
    delete size[url];
  }
  return { used, size, bytes, cap: ledger.cap };
}

export function serializeLedger(ledger: Ledger): string {
  return JSON.stringify(ledger);
}

/**
 * The ledger as it was written, or an empty one.
 *
 * **Anything unreadable is an empty ledger and never an exception.** This is parsed inside a
 * `fetch` handler: a throw there fails the request, which for card art is a broken picture on
 * every tile at once. The cost of the fallback is one cold cache.
 */
export function parseLedger(raw: string | null): Ledger {
  if (!raw) return empty();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return empty();
    const { used, size, bytes, cap } = parsed as Partial<Ledger>;
    if (typeof used !== "object" || used === null) return empty();
    if (typeof size !== "object" || size === null) return empty();
    if (typeof bytes !== "number" || typeof cap !== "number") return empty();
    return { used, size, bytes, cap };
  } catch {
    return empty();
  }
}
