/**
 * Where a card can be looked at outside this app.
 *
 * **Every function here builds a string and nothing else.** Nothing is fetched, resolved or
 * opened until the reader presses the item — a menu that merely *offers* to open a
 * marketplace must not have visited one. {@link openExternal} is the single call that leaves
 * the app, and it is made on selection.
 *
 * **The Scryfall link is derived rather than stored.** The canonical `scryfall_uri` lives only
 * inside the gzipped `raw` blob, and `scryfall.com/card/<set>/<number>` is a documented
 * permalink built from two fields every surface in this app already holds — so a wishlist row
 * and a deck card get the same link a search result does, with no DTO change and no round
 * trip.
 *
 * **A marketplace link is a search, not a product page.** None of the four priced sites
 * publishes a per-card URL derivable from what this app stores, so the honest thing to offer
 * is that site's search for the card's name.
 *
 * **The EDHREC link is a question put to EDHREC's own router, not a slug this app computes.**
 * `edhrec.com/route/?cc=<name>` is the shape Scryfall itself publishes as every card's
 * `related_uris.edhrec`, and the router decides whether a name is a card page or a commander
 * page and how it slugs — all of which are EDHREC's rules to change.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import type { MarketplaceId } from "./marketplace";

export function scryfallCardUrl(setCode: string, collectorNumber: string): string {
  // Collector numbers are TEXT in Scryfall's data, not integers -- "1556★", "123a" and "S-1"
  // are all real, and a raw ★ in a path is not a URL.
  return `https://scryfall.com/card/${setCode.toLowerCase()}/${encodeURIComponent(collectorNumber)}`;
}

/**
 * The card on EDHREC, by name (issue #402).
 *
 * **Verified live, 2026-09-08.** Four names through the router, each landing on a real page with
 * the card's own heading: `Lightning Bolt` → `/cards/lightning-bolt`; `Jinnie Fay, Jetmir's
 * Second` → its **commander** page, which no `/cards/<slug>` guess would have found; `Fire // Ice`
 * → the split card's page; `Delver of Secrets // Insectile Aberration` → the front face's. The
 * whole `name` field goes as it is stored, slashes and all — Scryfall sends only the front face
 * for a two-faced card, but the router accepts both, and trimming here would be a second slugging
 * rule beside EDHREC's. `encodeURIComponent` rather than Scryfall's `+` for a space: the router
 * answered the same page for either, and one encoder per file is what keeps these five URLs
 * comparable.
 */
export function edhrecCardUrl(cardName: string): string {
  return `https://edhrec.com/route/?cc=${encodeURIComponent(cardName)}`;
}

/**
 * One search URL per marketplace, keyed by name.
 *
 * A `Record` rather than a `switch`, so adding a marketplace to `MARKETPLACE_IDS` without a
 * link here is a **type error** rather than a menu item that opens nothing.
 *
 * **Verified live for "Lightning Bolt", 2026-08-14.** Along with the Scryfall permalink above,
 * three of these five were confirmed by grepping the card's own name out of the live response:
 * `cardkingdom`, `manapool` (only after the fix its comment describes) and `cardtrader`. The
 * other two, `tcgplayer` and `cardmarket`, reach the real site at their documented shape but
 * could not be content-verified this way — each says why at its own entry, so that fact lives
 * here rather than only in the task's (ephemeral) review report.
 */
const SEARCH_URL: Record<MarketplaceId, (q: string) => string> = {
  // Shape matches TCGplayer's own long-standing search URL, and the request reaches the real
  // site (HTTP 200, correct page title) -- but the result grid is rendered client-side by a JS
  // module-federation SPA, so an automated fetch only ever sees the shell. Not content-verified;
  // if this ever silently stops matching, nothing here would tell you.
  tcgplayer: (q) => `https://www.tcgplayer.com/search/magic/product?q=${q}`,
  // Shape matches Cardmarket's own documented search URL, and the request reaches the real site
  // -- but every automated request is intercepted by a Cloudflare bot challenge (HTTP 403, not
  // a 404; its own challenge script echoes the query back correctly formed, so the URL itself
  // was accepted before the wall). Not content-verified, same caveat as tcgplayer above.
  cardmarket: (q) => `https://www.cardmarket.com/en/Magic/Products/Search?searchString=${q}`,
  // Verified live, 2026-08-14: renders real matching results server-side (298 "Lightning Bolt"
  // hits in the response body).
  cardkingdom: (q) => `https://www.cardkingdom.com/catalog/search?search=header&filter%5Bname%5D=${q}`,
  // Not /search -- that route 404s (verified live, 2026-08-14). The header search box is a
  // client-side widget with no results URL of its own; /cards?q= is the card browser's own
  // filter and is what actually renders a result list server-side (155 "Lightning Bolt" hits
  // for the real query, "No results" and zero hits for a nonsense one).
  manapool: (q) => `https://manapool.com/cards?q=${q}`,
  // No price feed this app can reach -- its API needs a per-user JWT and publishes no bulk
  // download -- but the website exists, and a reader looking for it deserves the link.
  // Verified live, 2026-08-14: renders real matching results server-side (26 "Lightning Bolt"
  // hits in the response body).
  cardtrader: (q) => `https://www.cardtrader.com/en/search?q=${q}`,
};

export function marketplaceSearchUrl(id: MarketplaceId, cardName: string): string {
  return SEARCH_URL[id](encodeURIComponent(cardName));
}

/** The one call that leaves the app. Made on selection and never before it. */
export async function openExternal(url: string): Promise<void> {
  await openUrl(url);
}
