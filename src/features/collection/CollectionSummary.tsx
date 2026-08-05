import { Figure, FigureRow } from "@/components/Figure";
import type { CollectionSummary as Summary } from "@/lib/ipc";
import { eurPrice, PRICES_AS_OF, usdPrice } from "@/lib/prices";

/**
 * What the collection adds up to.
 *
 * Four figures, in the data face, with no colour and no chrome: the direction spends its
 * boldness on card art, and a row of tinted stat cards above a wall of Magic art is two
 * things shouting. The value carries its as-of sentence because spec §5 requires every price
 * on screen to say how old it is — and the unpriced count sits beside it because a total
 * that silently omits 200 cards is a number that lies by rounding down.
 *
 * `undefined` while the first answer is in flight, and an em dash rather than a zero: a
 * collection that briefly claims to be worth nothing is a worse sentence than one that has
 * not said yet.
 */
export function CollectionSummaryHeader({ summary }: { summary: Summary | undefined }) {
  const n = (value: number) => value.toLocaleString("en-US");
  return (
    <FigureRow>
      {/* Copies, not rows — a row emptied to zero contributes nothing to what is owned. */}
      <Figure label="Cards" value={summary ? n(summary.totalCards) : "—"} />
      <Figure label="Unique" value={summary ? n(summary.uniqueCards) : "—"} />
      <Figure
        label="Value (USD)"
        value={summary ? usdPrice(summary.valueUsd) : "—"}
        note={summary && summary.unpricedUsd > 0 ? `${n(summary.unpricedUsd)} unpriced` : undefined}
        title={PRICES_AS_OF}
      />
      <Figure
        label="Value (EUR)"
        value={summary ? eurPrice(summary.valueEur) : "—"}
        // Etched printings have no EUR price in Scryfall's data at all — `eur_etched` is
        // documented and absent — so they are unpriced here rather than valued at the
        // nonfoil rate, and this is where that shows.
        note={summary && summary.unpricedEur > 0 ? `${n(summary.unpricedEur)} unpriced` : undefined}
        title={PRICES_AS_OF}
      />
      {/* Only when there is one: a permanent "For trade — 0" is a column of chrome that has
          never once been the answer to anything. */}
      {summary && summary.tradelistCards > 0 && (
        <Figure label="For trade" value={n(summary.tradelistCards)} />
      )}
    </FigureRow>
  );
}
