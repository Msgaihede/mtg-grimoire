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
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import type { MarketplaceId } from "./marketplace";

export function scryfallCardUrl(setCode: string, collectorNumber: string): string {
  // Collector numbers are TEXT in Scryfall's data, not integers -- "1556★", "123a" and "S-1"
  // are all real, and a raw ★ in a path is not a URL.
  return `https://scryfall.com/card/${setCode.toLowerCase()}/${encodeURIComponent(collectorNumber)}`;
}

/**
 * One search URL per marketplace, keyed by name.
 *
 * A `Record` rather than a `switch`, so adding a marketplace to `MARKETPLACE_IDS` without a
 * link here is a **type error** rather than a menu item that opens nothing.
 */
const SEARCH_URL: Record<MarketplaceId, (q: string) => string> = {
  tcgplayer: (q) => `https://www.tcgplayer.com/search/magic/product?q=${q}`,
  cardmarket: (q) => `https://www.cardmarket.com/en/Magic/Products/Search?searchString=${q}`,
  cardkingdom: (q) => `https://www.cardkingdom.com/catalog/search?search=header&filter%5Bname%5D=${q}`,
  // Not /search -- that route 404s (verified live, 2026-08-14). The header search box is a
  // client-side widget with no results URL of its own; /cards?q= is the card browser's own
  // filter and is what actually renders a result list server-side.
  manapool: (q) => `https://manapool.com/cards?q=${q}`,
  // No price feed this app can reach -- its API needs a per-user JWT and publishes no bulk
  // download -- but the website exists, and a reader looking for it deserves the link.
  cardtrader: (q) => `https://www.cardtrader.com/en/search?q=${q}`,
};

export function marketplaceSearchUrl(id: MarketplaceId, cardName: string): string {
  return SEARCH_URL[id](encodeURIComponent(cardName));
}

/** The one call that leaves the app. Made on selection and never before it. */
export async function openExternal(url: string): Promise<void> {
  await openUrl(url);
}
