/**
 * Naming a card image. On the desktop build the renderer never sees a file path — it asks the
 * `mtgimg://` protocol for `<variant>/<card id>/<face>` and Rust decides where the bytes come
 * from.
 *
 * Written out rather than delegated to `@tauri-apps/api`'s `convertFileSrc`, which reads
 * `window.__TAURI_INTERNALS__` — undefined in jsdom, so every component test that renders
 * a card would throw. The platform rule is two lines and it is pinned by a test.
 *
 * **There are two platform rules here now, and they are different questions.** `imageOrigin`
 * answers *which spelling of a Tauri custom protocol this OS uses*; {@link cardArtSrc} answers
 * *whether this build has a custom protocol at all* — a browser has none, and wasm cannot
 * register a URL scheme with one, so the web build draws the URL its own list rows carry
 * (`CardSummary.imageUris`) straight off `cards.scryfall.io`. Both live here, and **neither may
 * be spread into a component**: a second `__CORE__` check somewhere up the tree is a second
 * thing to keep in step, and the failure when the two disagree is a page of broken images
 * rather than an error.
 */

import { isWebTarget } from "@/pwa/target";

/** The four WEBP sizes the cache stores. Nothing else exists as far as the UI is aware. */
export const IMAGE_VARIANTS = ["thumb", "grid", "display", "art"] as const;
export type ImageVariant = (typeof IMAGE_VARIANTS)[number];

/**
 * The size every **wall of card faces** draws — the search's, the collection's, the wishlist's
 * and the deck editor's docked search column, through `CardArt`'s default.
 *
 * `display` (672×936) rather than `grid` (488×680) because the walls **zoom** and the variant
 * does not: a tile is 170px at 1× and 340px at the top of `cardZoom`'s ladder, which on a
 * display at 200% scaling is **680 device pixels drawn from a 488px source** — a 39% upscale,
 * and the blur readers reported. 672 covers that worst case almost exactly. It is also the
 * ceiling worth having rather than merely the next rung: Scryfall's larger `png` is 745×1040
 * for ~1 MB against ~93 KB, and its own docs mark the whole JPG/PNG family as *replaced* by
 * these WEBP keys.
 *
 * **A named constant because the wall and its pre-warm are two different call sites**, and the
 * failure when they disagree is silent in the specific way `DECK_CARD_VARIANT`'s comment
 * records: each variant is its own URL on the CDN and its own directory in the cache, so a
 * pre-warm fetching the variant no surface asks for reports every card warmed and every tile
 * then fetches cold anyway. `SearchPage`'s `prefetchImages` call and `CardArt`'s default are
 * that pair; `images::COLLECTION_PREWARM` is the Rust half and has to agree with this.
 *
 * It is what `CardDetailPane` and `PrintingPreview` already draw, which is the part that pays
 * for the bigger file: a card the reader opens used to cost two cache keys — a `grid` for the
 * tile and a `display` for the pane — and now costs one.
 */
export const WALL_CARD_VARIANT: ImageVariant = "display";

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
 * Which of a card frame's two possible pictures this build actually draws — **the whole of the
 * desktop/web branch, in one function**.
 *
 * On desktop the answer is always the protocol URL: the bytes are in the local cache, already
 * re-encoded to the variant's exact size, and a frame that drew Scryfall's own URL instead would
 * refetch every tile over the network on a wall the reader has already paid for. So `suppliedUrl`
 * is *ignored* there rather than preferred — a list row carries it on both builds, because the
 * DTO is one shape.
 *
 * On web there is no protocol to ask. `mtgimg://` is registered natively with the webview and
 * **wasm cannot register a URL scheme with a browser**, so the only picture a browser can reach
 * is the one the row was handed by `search_cards`. A row that carries none answers `null` —
 * which is the frame's "no art" state and not a URL to try — because Scryfall says "no image" in
 * a shape that looks like a picture (`soon.jpg`), and a frame handed a protocol URL it cannot
 * resolve draws a broken `<img>` where a named, empty card frame belongs.
 *
 * **The protocol URL is computed by the caller and passed in, rather than built here**, and that
 * is load-bearing rather than a style choice: `.storybook/main.ts` aliases `@/lib/images` to a
 * fake whose whole job is to replace {@link cardImageUrl} with generated art, and a call made
 * *inside* this module would reach the real function and paint every story a broken image. The
 * caller's `cardImageUrl` is the overridable one. It costs a string concatenation the web build
 * throws away, which is cheaper than a workbench that cannot draw a card.
 */
export function cardArtSrc(
  protocolUrl: string | null,
  suppliedUrl?: string | null,
): string | null {
  return isWebTarget() ? (suppliedUrl ?? null) : protocolUrl;
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
 * again while the URL does not, which is why `images.rs` serves it `no-store` — and **never add
 * a cache-buster here**: a `?v=` would be a second URL for one deck's cover, which is the thing
 * this function exists to prevent.
 *
 * **`no-store` is not on its own enough, and believing it was is how a replaced cover shipped
 * still showing the old file.** A header governs what happens to a *request*; a browser holding
 * a decoded `<img>` whose `src` has not changed has no reason to make one, so it goes on
 * painting what it already has and the header never gets a say. So the header is half of it, and
 * the other half is at the caller: anything that must notice a *replacement* — the gallery tile,
 * a preview watching for its own upload to land — changes the element's React `key`, which
 * throws the decoded frame away and makes the request `no-store` then answers freshly. Neither
 * half works alone.
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
