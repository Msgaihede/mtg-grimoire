import type { MarketplaceId } from "@/lib/marketplace";

/**
 * The query key for a card's `card_detail` read — **one spelling, for every surface that reads
 * it.**
 *
 * ## Why this is a module and not four literals
 *
 * Four surfaces ask for the same card at the same moment: the card modal itself, and the three
 * overlays a reader opens from its rail — `LegalityDialog`, `CardTextDialog`, `OracleTagsDialog`.
 * Each of the three used to spell `["card", cardId, marketplace]` out for itself, and each did so
 * deliberately: the original lived in `CardDetailPane.tsx`, a file that is deleted once the
 * modal's parts have moved out of it, and an import of something with a demolition date is a
 * worse dependency than a copy. That reasoning was right about each file and wrong about the end
 * state, because these are not four keys that happen to look alike — they are **one cache entry
 * that four surfaces are counting on.**
 *
 * **What the shared key buys is a round trip that never happens.** The modal has already fetched
 * the card by the time any of the three overlays can be opened, so an overlay mounting an
 * observer on this key is a cache read: it paints on the render that opens it, from data it did
 * not ask for. That is the entire reason a dialog which draws no price still takes the
 * marketplace — see below.
 *
 * **And what a drifted copy costs is exactly that, silently.** Nothing about a fifth spelling is
 * an error: a differently-shaped key is still a valid key, its query still succeeds, and every
 * test still passes. The surface just quietly stops sharing the warm entry, pays its own
 * `card_detail` round trip, and shows a reader a spinner — or an empty subtitle — over a card
 * that is already on the screen behind it. There is no build that can go red for that, which is
 * why the four spellings became one.
 *
 * ## The marketplace is part of the key, on purpose
 *
 * `card_detail` prices every finish at the marketplace it was called with, so two marketplaces
 * are two different answers for one card and must be two cache entries. A key that dropped it
 * would serve a reader on Card Kingdom the prices they were quoted on TCGplayer, and a
 * marketplace switch would have nothing to refetch. Nothing in the three overlays draws money,
 * but the key is not theirs to shorten: the moment one of them shortens it, it is no longer
 * reading the entry the modal filled, which is the whole point of the paragraph above.
 *
 * A read that genuinely wants a *different* entry should say so by keying differently rather than
 * by trimming this one — `CreateDeckDialog`'s artist lookup is the standing example, keyed
 * `["cards", "artist", id]` precisely so no priced surface can ever be served out of it.
 *
 * @param cardId The printing being read. **Nullable because three of the four callers are mounted
 *   for the life of the app** and read `selectedCardId`, which is `null` whenever no card is open;
 *   their query function is `skipToken` until it is not, so a null here names an entry that is
 *   never fetched. Accepting it in one place is what keeps the shape identical for the caller
 *   that cannot be null.
 * @param marketplace The marketplace the card was priced at — `useMarketplace().marketplace.id` at
 *   every call site.
 */
export function cardDetailKey(cardId: string | null, marketplace: MarketplaceId) {
  return ["card", cardId, marketplace] as const;
}
