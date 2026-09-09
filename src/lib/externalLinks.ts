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
 * **A marketplace link is a search, not a product page — except TCGplayer's, since 2026-09-09.**
 * That sentence was true of all five for as long as the app stored nothing a product URL could be
 * built from, and it is still true of the other four: none of them publishes a per-card URL
 * derivable from what is in `cards`. TCGplayer does, because Scryfall carries its product id on
 * every printing — `tcgplayer_id` and `tcgplayer_etched_id`, covering **98.38 %** of paper English
 * non-token printings (99 885 rows, measured 2026-09-09). So {@link tcgplayerProductUrl} builds
 * the exact page and {@link marketplaceSearchUrl} is what a printing with neither id falls back
 * to. **Which id, and which printing to assert, is not decided here**: that needs the finish the
 * surface named, and it lives in `src/features/card/openMarketplace.ts`.
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
 * The two words TCGplayer's Magic catalogue spells a finish with, and there is no third.
 *
 * **Measured from the catalogue's own price rows for Commander Masters (2026-09-09):
 * `subTypeName` ∈ {`Normal`, `Foil`} and nothing else.** The app's three finishes therefore
 * collapse to two here, and that is not a lossy mapping but the way the site is built: etched foil
 * is a **separate product** (`484936 The Ur-Dragon (Foil Etched)`, whose own subtype is `Foil`),
 * and so is every other special treatment — raised foil, surge foil, chocobo track foil. Each is
 * its own product sold as `Printing=Foil`, so a third value would name a row that does not exist.
 */
export type TcgplayerPrinting = "Normal" | "Foil";

/**
 * The exact TCGplayer product page for one printing, optionally at one printing of it.
 *
 * **Verified live, 2026-09-09.** Lightning Bolt (LEA) is `tcgplayer_id: 1174`;
 * `https://www.tcgplayer.com/product/1174` answers 200, and so do `?Printing=Foil` and
 * `?page=1&Printing=Normal`.
 *
 * **And `Printing` really does select the listings rather than decorate the URL — driven in a
 * browser, 2026-09-09.** Three states on one product (`484935`, The Ur-Dragon, Commander Masters):
 * `?Printing=Foil` leaves the **Foil** checkbox `checked` and **Normal** clear, the applied-filter
 * chips read `Foil` + `English`, and **4 listings** show; `?Printing=Normal` is its mirror, **4
 * listings**; the bare URL leaves **neither** box checked and shows **8**. **4 + 4 = 8** is the
 * figure worth writing down, because it says two things at once: the parameter *partitions* the
 * listings, and the bare URL is a genuine neutral rather than a hidden default — which is exactly
 * what the two rows of `chooseTcgplayerLink`'s table that append nothing rest on. The etched branch
 * is confirmed on its own product: `484936` is headed `The Ur-Dragon (Foil Etched) - Commander
 * Masters (CMM)` and offers **only a Foil checkbox, with no Normal row at all**, which
 * `?Printing=Foil` checks (3 listings).
 *
 * **That was Chrome over the DevTools protocol and not this app's WebView2**, so it settles
 * *TCGplayer's* behaviour and says nothing yet about the app's press, which is verified separately.
 * And it retires nothing from `SEARCH_URL.tcgplayer` below: the **search** URL's result grid is the
 * client-rendered module-federation SPA an automated fetch sees only the shell of, and it is still
 * not content-verified. A product page's filter state and a search's results are two surfaces.
 *
 * **`Language` is not this app's to send.** Every URL above normalised to
 * `?Printing=…&Language=English` — TCGplayer appends that itself — so this builder passes the one
 * parameter it means and leaves the site's own to the site.
 *
 * `printing` is nullable and `null` means **append nothing**, which is a deliberate third state
 * rather than a missing default: the page then stays unfiltered, showing every listing in both
 * finishes, and the caller reaches for it whenever the id it chose cannot honestly be claimed to be
 * sold in a finish (`openMarketplaceForCard`'s table says which cases those are). Guessing `Normal`
 * for an etched product would be a parameter naming a row that product has none of — measured
 * above: that product has no Normal checkbox.
 *
 * The id goes in unencoded because it is a `number` and not a string — so unlike
 * {@link scryfallCardUrl}'s collector number or {@link edhrecCardUrl}'s card name, there is
 * nothing here for a `★` or a `//` to arrive in. That is the one builder in this file with no
 * encoder in it, and the reason is the type rather than an omission.
 */
export function tcgplayerProductUrl(
  productId: number,
  printing: TcgplayerPrinting | null,
): string {
  const base = `https://www.tcgplayer.com/product/${productId}`;
  return printing === null ? base : `${base}?Printing=${printing}`;
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
  // **The fallback rather than the shape this row usually opens, since 2026-09-09.** The primary
  // is `tcgplayerProductUrl` above -- the exact product page at the right printing, from the id
  // Scryfall stores per printing -- and the decision between the two ids, the two `Printing`
  // words and this search is `src/features/card/openMarketplace.ts`'s, in one place both call
  // sites share. What still reaches here is the 1.62 % of paper English non-token printings that
  // carry neither id (measured 2026-09-09) and every printing whose id lookup failed: a press
  // must never do nothing, and a search for the name is what the app offered for all five
  // marketplaces before the ids existed.
  //
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
