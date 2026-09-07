import type { Currency, Marketplace } from "./marketplace";

/**
 * Money, as this app writes it.
 *
 * Three call sites had their own `Intl.NumberFormat` and two had their own copy of the
 * as-of sentence — which is exactly the kind of duplication that ends with two screens
 * making different promises about the same number. Prices come from one place (whatever
 * the last sync wrote, quoted by whichever marketplace the reader picked), so they say so
 * in one sentence.
 */

/**
 * One formatter per currency, built once.
 *
 * Module-level on purpose: an `Intl.NumberFormat` is expensive to construct and these are
 * called once per price cell in a virtualised table. Building one per call is the thing this
 * module was written to stop, and switching marketplace must not reintroduce it — the switch
 * changes which constant is *looked up*, never how many exist.
 */
const FORMATTERS: Record<Currency, Intl.NumberFormat> = {
  usd: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }),
  eur: new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }),
};

/** A price, or an em dash. Never `$0.00`, which is a price nobody quoted. */
export function formatPrice(value: number | null, currency: Currency): string {
  return value === null ? "—" : FORMATTERS[currency].format(value);
}

/**
 * What a reader typed into a **purchase price** box, as an amount — or `undefined` for "nothing
 * to send".
 *
 * **Here rather than in either box, because it has to read back what {@link formatPrice} writes.**
 * The add popup shows the marketplace's figure as its placeholder and the edit dialog seeds its
 * box with the recorded one, so `$2.50` and `€1,234.56` are strings a reader is *shown* and may
 * retype verbatim — which makes this function and the formatter above one contract with two
 * halves, and a change to `FORMATTERS` that this cannot parse is a change that breaks a box
 * nobody edited. Two files can drift apart; two functions in one file are read together.
 *
 * It landed as a private copy in `AddToCollection.tsx` and a second, byte-identical private copy
 * in `EditCopy.tsx` — written by two agents on the same afternoon, from the same brief. That is
 * the duplication this module's own header was written about, arriving a third time, and the
 * drift it would have produced is the worst kind: silent, and in the fifth decimal place.
 *
 * **`undefined` is the whole point of the return type.** `purchase_price` is written through a
 * `coalesce(?, column)`, so an absent field leaves the row's own price where it was, while a `0`
 * overwrites it with a claim nobody made. A blank box, a half-typed separator and a word are all
 * the same answer here: say nothing.
 *
 * **A typed `0` is not that answer and is sent as it stands.** "It was free" is a fact about a
 * copy — a prize, a gift, a card out of somebody's spare box — and the reader had to press a key
 * to say it.
 *
 * The two separators are read the way both of this app's formatters write them: a lone comma is a
 * decimal point (`2,50`), a comma before a dot is grouping (`$1,234.56`, and `en-IE` writes
 * `€1,234.56` the same way). **The reverse arrangement is refused rather than guessed** —
 * stripping the dots out of a German `1.234,56` would record `1.23456`, a fifth of a cent, and a
 * number silently wrong is worse than a field that took nothing.
 *
 * `PriceRange`'s `parsePrice` is the same shape over a different question — a *filter bound*,
 * where an empty end means "open" rather than "unstated" and no currency symbol ever appears
 * because that control has no hint to retype. Two meanings, two functions, deliberately.
 */
export function parsePurchasePrice(draft: string): number | undefined {
  const cleaned = draft.replace(/[^\d.,-]/g, "");
  if (cleaned === "") return undefined;
  const dot = cleaned.lastIndexOf(".");
  const comma = cleaned.lastIndexOf(",");
  if (dot !== -1 && comma > dot) return undefined;
  const value = Number(dot === -1 ? cleaned.replace(",", ".") : cleaned.replace(/,/g, ""));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The provenance sentence, which has to name the marketplace **and get its source right**.
 *
 * It was a constant while there was only one answer. With five in the picker, a bare "prices as
 * of the last sync" would leave the reader to guess whose prices they are looking at — and the
 * whole point of the setting is that the answer changed.
 *
 * Two sentences now, because there are two sources and they are refreshed by different things.
 * TCGplayer's and Cardmarket's numbers ride in with the card data, so the card sync is what
 * dates them; Card Kingdom's and Mana Pool's are downloaded on their own schedule, and saying
 * "the last card-data sync" over those would point a reader at a date that has nothing to do
 * with the figure beside it. The exact stamp for a feed lives in Settings, where there is room
 * for it — see `MarketplacePanel`.
 */
export function pricesAsOf(marketplace: Marketplace): string {
  return marketplace.feed
    ? `${marketplace.label} prices as of the last price-feed refresh.`
    : `${marketplace.label} prices as of the last card-data sync.`;
}
