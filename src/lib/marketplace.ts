/**
 * Which marketplace the app quotes prices from.
 *
 * **A marketplace is a label; the currency is the axis.** Nothing downstream of this module
 * branches on a marketplace id — every price function takes a {@link Currency}, which is
 * exactly the distinction `cards.prices` already draws (`usd*` is TCGplayer, `eur*` is
 * Cardmarket). That is what keeps a future Card Kingdom feed to one seam instead of a rewrite
 * of every price surface in the app.
 *
 * Three of the five are `priced: false`, and that is a fact about the data rather than a
 * placeholder. Scryfall's `prices` blob has six keys and feeds two marketplaces; Card Kingdom,
 * Mana Pool and Card trader each need their own feed, their own sync and their own way back to
 * a `scryfall_id`. They are listed because a reader looking for them deserves to be told the
 * app knows they exist and cannot quote them yet — not to be left wondering.
 *
 * See `docs/superpowers/specs/2026-08-12-card-marketplace-pricing-design.md`.
 */

/** The two currencies the card data actually carries. `tix` is MTGO tickets and is not one. */
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
   * Whether this app can quote a price here **yet**.
   *
   * False means no feed exists in this build, so the entry is offered but not selectable. It
   * is deliberately not "this marketplace has no prices" — all five sell cards.
   */
  priced: boolean;
}

/**
 * The default, and the only one this app has ever quoted: every price in every view before
 * this setting existed was Scryfall's `usd`, which is TCGplayer's.
 */
export const DEFAULT_MARKETPLACE: MarketplaceId = "tcgplayer";

export const MARKETPLACES: Record<MarketplaceId, Marketplace> = {
  tcgplayer: { id: "tcgplayer", label: "TCGplayer", currency: "usd", priced: true },
  cardmarket: { id: "cardmarket", label: "Cardmarket", currency: "eur", priced: true },
  cardkingdom: { id: "cardkingdom", label: "Card Kingdom", currency: "usd", priced: false },
  manapool: { id: "manapool", label: "Mana Pool", currency: "usd", priced: false },
  cardtrader: { id: "cardtrader", label: "Card trader", currency: "eur", priced: false },
};

/** In picker order — the two that work first, then the three that are waiting on a feed. */
export const MARKETPLACE_LIST: Marketplace[] = MARKETPLACE_IDS.map((id) => MARKETPLACES[id]);

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
