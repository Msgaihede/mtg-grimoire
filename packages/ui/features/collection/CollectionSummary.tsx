import type { ReactNode } from "react";
import { Figure, FigureRow, InlineFigureRow } from "@/components/Figure";
import { count } from "@/lib/counts";
import type { CollectionSummary as Summary } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { formatPrice, pricesAsOf } from "@/lib/prices";

/**
 * What the collection adds up to.
 *
 * Three or four figures, in the data face, with no colour and no chrome: the direction spends
 * its boldness on card art, and a row of tinted stat cards above a wall of Magic art is two
 * things shouting. The value carries its as-of sentence because spec §5 requires every price
 * on screen to say how old it is — and the unpriced count sits beside it because a total
 * that silently omits 200 cards is a number that lies by rounding down.
 *
 * **Two faces draw these figures, from one list** ({@link CollectionFigureList}): this band is
 * the light app's phone face, and the desktop page draws {@link CollectionPageFigures} inline in
 * its page bar (2026-10-21). Sharing the list is what keeps the two from disagreeing about what
 * the collection adds up to.
 *
 * ## One Value figure, not two
 *
 * This header drew `Value (USD)` and `Value (EUR)` side by side while there was no way to
 * *say* which one you wanted. The marketplace setting is that way, so the pair collapses into
 * the one the reader picked: two totals for one collection is two answers to the question
 * this row exists to answer, and the second one is now a currency they have declared they are
 * not shopping in. The band's label still names the currency, because a bare "Value" over a
 * figure that changes denomination in Settings would be a number with no units.
 *
 * **The unpriced count travels with the figure, and it has to.** No two marketplaces have the
 * same holes: `eur_etched` does not exist in Scryfall's data at all, so an etched printing is
 * priced on TCGplayer and unpriced on Cardmarket at the same time, and a card a bulk feed has
 * never listed is unpriced on that feed alone. `unpriced` is counted at the marketplace
 * `value` was summed at, so this note is about the number beside it and never about another.
 *
 * `undefined` while the first answer is in flight, and an em dash rather than a zero: a
 * collection that briefly claims to be worth nothing is a worse sentence than one that has
 * not said yet. That gap is now real on a *switch* as well as on first paint — the summary is
 * keyed on the marketplace and genuinely re-runs — which is why the placeholder is the whole
 * row's rule rather than a first-load special case.
 */
export function CollectionSummaryHeader({
  summary,
  marketplace,
  actions,
}: {
  summary: Summary | undefined;
  /** Which marketplace's prices this row totals: its currency writes the figure, its label is
   *  the as-of sentence. The figure itself was summed by the query. */
  marketplace: Marketplace;
  /** The far end of the band. Passed straight through to `FigureRow`, which is where the markup
   *  rule for it lives. */
  actions?: ReactNode;
}) {
  return (
    <FigureRow actions={actions}>
      <CollectionFigureList summary={summary} marketplace={marketplace} inline={false} />
    </FigureRow>
  );
}

/**
 * The same figures for the desktop page's page bar ("Page & Section Headings" canvas, option A,
 * 2026-10-21): one quiet line on the title's baseline — `998 cards · 735 unique · $6,247.11
 * value` — with the value, the one figure this row is for, in gold.
 *
 * **Its words are the ones that follow a number** (`cards`, `value`), not the band's column
 * labels, and the money's word drops the band's `(USD)`: on this line the formatted figure sits
 * right before its word with its own sign on it (`$`, `€` — the only two currencies a marketplace
 * quotes in), so the units are already said, and said where the eye is.
 */
export function CollectionPageFigures({
  summary,
  marketplace,
}: {
  summary: Summary | undefined;
  marketplace: Marketplace;
}) {
  return (
    <InlineFigureRow>
      <CollectionFigureList summary={summary} marketplace={marketplace} inline />
    </InlineFigureRow>
  );
}

function CollectionFigureList({
  summary,
  marketplace,
  inline,
}: {
  summary: Summary | undefined;
  marketplace: Marketplace;
  inline: boolean;
}) {
  const value = summary ? summary.value : null;
  const unpriced = summary ? summary.unpriced : 0;
  return (
    <>
      {/* Copies, not rows — a row emptied to zero contributes nothing to what is owned. */}
      <Figure
        inline={inline}
        label={inline ? "cards" : "Cards"}
        value={summary ? count(summary.totalCards) : "—"}
      />
      <Figure
        inline={inline}
        label={inline ? "unique" : "Unique"}
        value={summary ? count(summary.uniqueCards) : "—"}
      />
      {/* Gold in the page bar only, and on this figure only: a row gilds one figure or none, and
          value is what this one is for. The phone band stays colourless. */}
      <Figure
        inline={inline}
        accent={inline}
        label={inline ? "value" : `Value (${marketplace.currency.toUpperCase()})`}
        value={summary ? formatPrice(value, marketplace.currency) : "—"}
        note={unpriced > 0 ? `${count(unpriced)} unpriced` : undefined}
        title={pricesAsOf(marketplace)}
      />
      {/* Only when there is one: a permanent "For trade — 0" is a column of chrome that has
          never once been the answer to anything. */}
      {summary && summary.tradelistCards > 0 && (
        <Figure
          inline={inline}
          label={inline ? "for trade" : "For trade"}
          value={count(summary.tradelistCards)}
        />
      )}
    </>
  );
}
