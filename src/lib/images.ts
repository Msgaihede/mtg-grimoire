/**
 * Naming a card image. The renderer never sees a file path — it asks the `mtgimg://`
 * protocol for `<variant>/<card id>/<face>` and Rust decides where the bytes come from.
 *
 * Written out rather than delegated to `@tauri-apps/api`'s `convertFileSrc`, which reads
 * `window.__TAURI_INTERNALS__` — undefined in jsdom, so every component test that renders
 * a card would throw. The platform rule is two lines and it is pinned by a test.
 */

/** The four WEBP sizes the cache stores. Nothing else exists as far as the UI is aware. */
export const IMAGE_VARIANTS = ["thumb", "grid", "display", "art"] as const;
export type ImageVariant = (typeof IMAGE_VARIANTS)[number];

/**
 * The physical proportions of a Magic card, as a CSS `aspect-ratio`.
 *
 * Every frame that holds a card image uses this — a tile that is not 5:7 either letterboxes
 * the art or stretches it, and stretching a card image is something Scryfall's usage rules
 * forbid outright.
 */
export const CARD_ASPECT = "5 / 7";

/**
 * Where a Tauri custom protocol lives, which is not the same string on every platform:
 * `http://<scheme>.localhost` on Windows and Android, `<scheme>://localhost` elsewhere.
 */
export function imageOrigin(userAgent: string): string {
  return userAgent.includes("Windows") || userAgent.includes("Android")
    ? "http://mtgimg.localhost"
    : "mtgimg://localhost";
}

/**
 * The URL for one face of one printing at one size.
 *
 * `face` is an index, not a side name: 0 is the front, 1 the back. A card with one
 * physical side answers face 1 with a card-back placeholder rather than an error, so a
 * flip control never has to know which layouts have two sides.
 */
export function cardImageUrl(cardId: string, face: number, variant: ImageVariant): string {
  return `${imageOrigin(navigator.userAgent)}/${variant}/${encodeURIComponent(cardId)}/${face}`;
}

/**
 * The shortest wait a failed image is allowed to come back after.
 *
 * The protocol answers a rate limit with `503` + `Retry-After`, and `images.rs` clamps
 * its own penalty into 30–300 s before sending it. The renderer cannot read the number:
 * an `<img>` error event carries no response, and `mtgimg:` is an `img-src` in the CSP
 * and nothing else, so the `fetch` that would read the header never leaves the page.
 * What this schedule guarantees instead is that it is never *shorter* than the floor the
 * protocol clamps its own penalty to — waiting longer than asked is always safe, coming
 * back early is what Scryfall escalates to bans over.
 */
export const IMAGE_RETRY_FLOOR_MS = 30_000;

/**
 * How far past each wait retries are scattered. A screenful of tiles fails in the same
 * instant, so a fixed delay would send all of them back in the same instant too.
 */
export const IMAGE_RETRY_SPREAD_MS = 5_000;

/**
 * The longest wait, matching the ceiling `images.rs` clamps a lockout *down* to: nothing
 * is bought by backing off past the point where the fetcher would already have reopened.
 */
export const IMAGE_RETRY_CEILING_MS = 300_000;

/**
 * How many times a failed tile comes back on its own.
 *
 * Two, because one is not enough: the shortest lockout the protocol reports is 30 s, but
 * a real `Retry-After: 60` leaves the gate shut when the first retry lands, and a tile
 * that spent its only attempt there would sit on "No image" for the rest of the session
 * over a lockout that ended half a minute later. The second attempt is the one that
 * covers that. After it the tile waits to be asked — a remount is a reader saying "now".
 */
export const IMAGE_RETRY_LIMIT = 2;

/**
 * When the `attempt`-th retry of one tile should happen: the floor, doubling per attempt,
 * capped at {@link IMAGE_RETRY_CEILING_MS} and dithered.
 *
 * A retry that arrives inside a lockout costs nothing on the wire — the fetcher's gate
 * fails it locally, without a request — so the doubling is about giving the *next* one a
 * useful chance rather than about politeness to Scryfall.
 *
 * `random` is a seam for the test rather than a caller's choice: the dither has to be
 * observable to be provable.
 */
export function imageRetryDelayMs(attempt: number, random: number = Math.random()): number {
  const doubled = IMAGE_RETRY_FLOOR_MS * 2 ** Math.max(0, attempt - 1);
  const dither = Math.min(Math.max(random, 0), 1) * IMAGE_RETRY_SPREAD_MS;
  return Math.min(doubled, IMAGE_RETRY_CEILING_MS) + Math.floor(dither);
}
