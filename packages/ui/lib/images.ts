/**
 * Naming a card image. The renderer never sees a file path — it asks the `mtgimg://` protocol
 * for `<variant>/<card id>/<face>` and Rust decides where the bytes come from. (In the web app
 * the same path is asked of the app's own origin, and its service worker decides.)
 *
 * Written out rather than delegated to `@tauri-apps/api`'s `convertFileSrc`, which reads
 * `window.__TAURI_INTERNALS__` — undefined in jsdom, so every component test that renders
 * a card would throw. The platform rule is one line and it is pinned by a test.
 *
 * **That rule is `imageOrigin`'s, and it may not be spread into a component**: it answers
 * *which spelling of a Tauri custom protocol this OS uses*, a second copy of it somewhere up the
 * tree is a second thing to keep in step, and the failure when the two disagree is a page of
 * broken images rather than an error.
 */

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
 * It is what the open card already draws — `CardModalArt` names `"display"` outright, as the
 * docked pane and its `PrintingPreview` did before it — which is the part that pays
 * for the bigger file: a card the reader opens used to cost two cache keys — a `grid` for the
 * tile and a `display` for the open card — and now costs one.
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
 * Where the web app's pictures live on its own origin: `<origin>/mtgimg/<variant>/<id>/<face>`.
 *
 * A browser has no custom protocol, so the same path is asked of the app's own origin and the
 * service worker answers it (`core/web/sw/`, the light-app spec §3.5). **A prefix and not the
 * root**, because the root's first segments are the app's places — `/search`, `/decks/12` — and a
 * variant is a word a place could one day be. Named for the protocol it stands in for, and the
 * service worker reads this constant: the two ends cannot come to spell it differently.
 */
export const WEB_IMAGE_PREFIX = "/mtgimg";

/** The web app's picture origin on `origin` — {@link imageOrigin}'s answer in that build. */
export function webImageOrigin(origin: string): string {
  return `${origin}${WEB_IMAGE_PREFIX}`;
}

/**
 * Where a card picture is asked for, which is not the same string on every host.
 *
 * A Tauri custom protocol lives at `http://<scheme>.localhost` on Windows and on Android (the
 * light app's host, phase 4 — Android's WebView serves a custom scheme from that origin, as
 * WebView2 does), and at `<scheme>://localhost` elsewhere. **The web app's build has no
 * protocol and answers its own origin plus {@link WEB_IMAGE_PREFIX}** (phase 5, step 5.3).
 *
 * **Which build this is, is `import.meta.env.MODE`** — `core/index.ts`'s rule and its reason: it
 * is replaced at compile time and asks nothing of the window, so the web branch is not in the
 * desktop's or the Android app's bundle at all, and every other build answers exactly what it
 * answered before there was one.
 */
export function imageOrigin(userAgent: string): string {
  if (import.meta.env.MODE === "web") return webImageOrigin(globalThis.location.origin);
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
 *
 * **Call it at the site that draws the picture, never from a helper in this module**, and that
 * is load-bearing rather than a style choice: `.storybook/main.ts` aliases `@/lib/images` to a
 * fake whose whole job is to replace this function with generated art, and a call made *inside*
 * this module would reach the real function and paint every story a broken image. The caller's
 * `cardImageUrl` is the overridable one.
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

/**
 * How long a visible card frame waits for a picture that is saying nothing at all, before it
 * asks again.
 *
 * **This is a different failure from the one above and needs a different schedule.** The retry
 * ladder is for a picture the protocol *refused* — a 502 or a 503 — which arrives as an `error`
 * event, and whose 30-second floor exists so a rate limit is not hammered. Nothing here has been
 * refused: no `load`, no `error`, nothing. The request went out and no answer came back, and a
 * lost message costs nothing to send again, so waiting half a minute over it would be thirty
 * seconds of a blank card for no reason.
 *
 * **Five seconds, against a measured ceiling of 451 ms.** Timed in the shipped window on
 * 2026-09-01 over 400 tiles of the search wall, debug build: **p50 7 ms, p90 275 ms, p99 421 ms,
 * max 451 ms**. A deliberate burst of 200 simultaneous warm requests came back in a median of
 * 116 ms and a worst of 167 ms, and 132/216 ms with the machine held at 72 % CPU. So this is
 * roughly eleven times the worst load anyone has measured, and nothing that is merely slow will
 * meet it.
 *
 * **Nor is it expensive when it fires early**, which is what makes the number safe rather than
 * lucky: `Cache::get` is single-flight per key, so a second ask for a picture already being
 * fetched waits on the same lock and reads what the first one writes. A watchdog that pre-empts
 * a genuinely slow *network* fetch — bounded at ten seconds by `IMAGE_TIMEOUT` in `scryfall.rs`
 * — therefore costs one extra local request and no extra download.
 */
export const IMAGE_STALL_DEADLINE_MS = 5_000;

/**
 * How far past each deadline the asks are scattered. A screenful of tiles is requested in the
 * same instant and would go silent in the same instant, so a fixed deadline would send all of
 * them back together — {@link IMAGE_RETRY_SPREAD_MS}'s reasoning, at this schedule's scale.
 */
export const IMAGE_STALL_SPREAD_MS = 500;

/**
 * How many times a silent picture is asked for again before the frame gives up and reports a
 * failure the ordinary way.
 *
 * Two, for a reason the ladder above does not share: the first ask covers a single lost answer,
 * which is the whole of the failure this exists for, and the second covers the ask itself being
 * lost. A picture still silent after three requests is not a dropped message, and pretending
 * otherwise would keep a frame asking forever over something no amount of asking fixes. What
 * happens then is `onError` — the same door a 502 comes through, so the frame says "No image"
 * and joins the backoff above rather than inventing a third state.
 */
export const IMAGE_STALL_LIMIT = 2;

/**
 * When the `attempt`-th ask for a silent picture should go out: the deadline, doubling per
 * attempt, dithered.
 *
 * It doubles for the case the flat schedule would serve badly — a cold fetch queued behind
 * fifteen others on a slow connection, where asking again changes nothing and the second wait
 * should be the longer one. `random` is a seam for the test rather than a caller's choice, the
 * same as {@link imageRetryDelayMs}: the dither has to be observable to be provable.
 */
export function imageStallDeadlineMs(attempt: number, random: number = Math.random()): number {
  const doubled = IMAGE_STALL_DEADLINE_MS * 2 ** Math.max(0, attempt - 1);
  const dither = Math.min(Math.max(random, 0), 1) * IMAGE_STALL_SPREAD_MS;
  return doubled + Math.floor(dither);
}
