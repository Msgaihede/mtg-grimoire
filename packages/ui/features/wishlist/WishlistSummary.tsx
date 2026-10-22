import type { ReactNode } from "react";
import { Figure, FigureRow, InlineFigureRow } from "@/components/Figure";
import { count } from "@/lib/counts";
import type { Marketplace } from "@/lib/marketplace";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import type { CountTotals } from "./wishShelfPlan";

/**
 * What the wishlist adds up to — `CollectionSummaryHeader`'s twin, one table over: two figures in
 * the data face, no colour and no chrome.
 *
 * Its own file so the light app's phone face draws the same band from the same numbers. The
 * desktop page draws {@link WishlistPageFigures} in its page bar instead (2026-10-21), with its
 * Optimize button, Share group and Import/Export pair as the bar's actions; both faces draw
 * {@link WishlistFigureList}, so they cannot disagree about the total.
 *
 * `totals` is `countTotals(counts)` — `null` until the per-shelf counts have answered, which every
 * figure reads as an em dash rather than a zero.
 */
export function WishlistSummaryHeader({
  totals,
  marketplace,
  actions,
}: {
  totals: CountTotals | null;
  marketplace: Marketplace;
  actions?: ReactNode;
}) {
  return (
    <FigureRow actions={actions}>
      <WishlistFigureList totals={totals} marketplace={marketplace} inline={false} />
    </FigureRow>
  );
}

/**
 * The same two figures for the desktop page's page bar ("Page & Section Headings" canvas, option
 * A, 2026-10-21): one quiet line on the title's baseline — `42 cards · $1,280.00 total cost` —
 * the total in gold. `CollectionPageFigures`' twin, and it drops the band's `(USD)` for that
 * one's reason: the formatted figure right before the word carries its own sign.
 */
export function WishlistPageFigures({
  totals,
  marketplace,
}: {
  totals: CountTotals | null;
  marketplace: Marketplace;
}) {
  return (
    <InlineFigureRow>
      <WishlistFigureList totals={totals} marketplace={marketplace} inline />
    </InlineFigureRow>
  );
}

function WishlistFigureList({
  totals,
  marketplace,
  inline,
}: {
  totals: CountTotals | null;
  marketplace: Marketplace;
  inline: boolean;
}) {
  const currency = marketplace.currency;
  return (
    <>
      {/* **Both figures count the whole wall** (spec §3.6) — this level and every shelf below it,
          shut ones included — summed from the per-shelf counts, never from the rows loaded. */}
      <Figure
        inline={inline}
        label={inline ? "cards" : "Cards"}
        value={totals === null ? "—" : count(totals.wishes)}
      />
      {/* The one number this view exists for, in the currency the reader picked, with how old
          the prices are and whose. An unpriced wish is left out of the sum and counted in the
          note — never quoted at another marketplace's rate. In gold in the page bar, as the one
          figure that row is for; the phone band stays colourless.

          **It read `Still to buy` until 2026-09-08 and was summed over the copies each wish was
          still short of.** Both went with the owned count: this list compares itself to the
          collection nowhere, so what it can honestly total is what it *asks for* rather than
          what is left to get.

          Etched printings have no EUR price in Scryfall's data at all — `eur_etched` is
          documented and absent — so on Cardmarket a wish for one is left out of this sum
          and counted in the note rather than quoted at the nonfoil rate. */}
      <Figure
        inline={inline}
        accent={inline}
        label={inline ? "total cost" : `Total cost (${currency.toUpperCase()})`}
        value={totals === null || totals.wishes === 0 ? "—" : formatPrice(totals.value, currency)}
        note={totals !== null && totals.unpriced > 0 ? `${totals.unpriced} unpriced` : undefined}
        title={pricesAsOf(marketplace)}
      />
    </>
  );
}
