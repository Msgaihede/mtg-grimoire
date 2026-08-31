/**
 * Which marketplace the app quotes prices from.
 *
 * **A marketplace is a query parameter; the currency is what formats the answer.** Rust is
 * told which marketplace to price a list in and returns *one* number per row, so nothing
 * downstream of this module ever picks between two prices — it renders the one it was given,
 * in the currency this table names. Two of the four priced entries come out of Scryfall's
 * `prices` blob (`usd*` is TCGplayer, `eur*` is Cardmarket) and two out of their own bulk
 * feeds; a price surface cannot tell which, and that is the point.
 *
 * `priced: false` is a fact about what this build can reach, not a placeholder. Card trader is
 * the one left: its API needs a per-user JWT and publishes no bulk download, so there is
 * nothing to sync. It is listed because a reader looking for it deserves to be told the app
 * knows it exists and cannot quote it — not to be left wondering.
 *
 * See `docs/superpowers/specs/2026-08-12-marketplace-price-feeds-design.md`.
 */

/** The two currencies the app formats in. `tix` is MTGO tickets and is not one. */
export type Currency = "usd" | "eur";

export const MARKETPLACE_IDS = [
  "tcgplayer",
  "cardmarket",
  "cardkingdom",
  "manapool",
  "cardtrader",
] as const;

export type MarketplaceId = (typeof MARKETPLACE_IDS)[number];

export interface Marketplace {
  id: MarketplaceId;
  label: string;
  currency: Currency;
  /**
   * Whether this app can quote a price here.
   *
   * False means there is nothing to sync in this build, so the entry is offered but not
   * selectable. It is deliberately not "this marketplace has no prices" — all five sell cards.
   */
  priced: boolean;
  /**
   * Where the prices come from: `true` is a bulk feed this app downloads and stores in
   * `marketplace_prices`, `false` is Scryfall's own `prices` blob, which arrives with the card
   * data and has no refresh of its own.
   *
   * **The one thing outside this module that anything is allowed to branch on**, and only ever
   * to talk *about* the feed — when it was last pulled, whether it has ever been pulled, that a
   * refresh is running. Never to decide what a price *is*: that decision was made when the
   * marketplace was sent with the query. A `priced: false` entry is `feed: false` too, because
   * "no feed" and "a feed we have not built" are the same thing from here.
   */
  feed: boolean;
}

/**
 * The default, and the only one this app has ever quoted: every price in every view before
 * this setting existed was Scryfall's `usd`, which is TCGplayer's. It is also what the backend
 * falls back to for a query that names no marketplace.
 */
export const DEFAULT_MARKETPLACE: MarketplaceId = "tcgplayer";

export const MARKETPLACES: Record<MarketplaceId, Marketplace> = {
  tcgplayer: {
    id: "tcgplayer",
    label: "TCGplayer",
    currency: "usd",
    priced: true,
    feed: false,
  },
  cardmarket: {
    id: "cardmarket",
    label: "Cardmarket",
    currency: "eur",
    priced: true,
    feed: false,
  },
  // Both feeds are public, unauthenticated, bulk and keyed by `scryfall_id`, so the join is
  // exact rather than fuzzy — which is the fact that made them possible at all. Near Mint from
  // both (`price_retail`, `price_cents_nm`), so the four are comparable with each other.
  cardkingdom: {
    id: "cardkingdom",
    label: "Card Kingdom",
    currency: "usd",
    priced: true,
    feed: true,
  },
  manapool: {
    id: "manapool",
    label: "Mana Pool",
    currency: "usd",
    priced: true,
    feed: true,
  },
  cardtrader: {
    id: "cardtrader",
    label: "Card trader",
    currency: "eur",
    priced: false,
    feed: false,
  },
};

/** In picker order — the four that work, then the one that is waiting on an API this app can
 *  reach without a per-user token. */
export const MARKETPLACE_LIST: Marketplace[] = MARKETPLACE_IDS.map((id) => MARKETPLACES[id]);

/**
 * The marketplaces whose prices are downloaded rather than synced with the card data — the
 * only ones that have a feed state to show, a refresh to run, or an age to be stale by.
 *
 * Derived from the table rather than written out, so adding a feed is one edit.
 */
export const FEED_MARKETPLACES: Marketplace[] = MARKETPLACE_LIST.filter((m) => m.feed);

export function isMarketplaceId(value: string): value is MarketplaceId {
  return (MARKETPLACE_IDS as readonly string[]).includes(value);
}

/**
 * The marketplace a stored id names, falling back to the default.
 *
 * An unrecognised value reads as the default rather than throwing: the setting is written by
 * some build of this app, and a newer build's id landing in an older one is a downgrade, not a
 * corruption. Failing every price query over it would be the worse answer.
 */
export function resolveMarketplace(id: string | null | undefined): Marketplace {
  return MARKETPLACES[id && isMarketplaceId(id) ? id : DEFAULT_MARKETPLACE];
}
