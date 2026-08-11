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
 * The proportions of the `art` variant — the illustration alone, with the frame, the type
 * line and the text box cut away.
 *
 * `626 / 457`, which is `Variant::dimensions` in `images.rs` and therefore also the size of
 * the placeholder served for a printing with no art: a frame at this ratio is the same
 * rectangle whether the bytes arrive or not. Scryfall's own crops vary by a hair around it,
 * so the art is drawn with `object-cover` — cropped by a pixel rather than stretched, which
 * is the one thing the usage rules forbid outright.
 */
export const ART_ASPECT = "626 / 457";

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
 * The URL for a deck's **custom** cover — the picture the reader uploaded, which the backend
 * re-encodes into the same 626×457 shape a card's `art` crop has so that one tile can wear
 * either without the layout shifting.
 *
 * A fifth route beside the four card variants, and it cannot collide with one: `cover` is not a
 * variant word, so `Variant::parse` answers `None` for it and the two path shapes are disjoint
 * (`images.rs`'s `COVER_ROUTE`).
 *
 * **It names the deck, not the picture.** The bytes behind it change when the reader uploads
 * again while the URL does not, which is exactly why `images.rs` serves it `no-store` — so
 * never add a cache-buster here. The header is the mechanism, and a `?v=` would be a second one
 * for a solved problem. A caller that must force a *re-decode* (a preview watching for its own
 * upload to land) changes the element's React `key`, not the URL.
 *
 * A deck with no file on disk answers **404**, never a placeholder, chosen so the fault is
 * visible rather than hidden behind a grey rectangle that looks like a picture. It reaches a
 * caller as an ordinary `<img>` error.
 *
 * Here rather than in either surface that draws one, because it was written out twice — the
 * gallery tile and the settings dialog's preview draw the same picture — and two literals for
 * one route is how a route ends up with two spellings.
 */
export function deckCoverUrl(deckId: number): string {
  return `${imageOrigin(navigator.userAgent)}/cover/${deckId}`;
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
