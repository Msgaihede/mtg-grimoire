import { Figure, FigureRow } from "@/components/Figure";
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
 * ## One Value figure, not two
 *
 * This header drew `Value (USD)` and `Value (EUR)` side by side while there was no way to
 * *say* which one you wanted. The marketplace setting is that way, so the pair collapses into
 * the one the reader picked: two totals for one collection is two answers to the question
 * this row exists to answer, and the second one is now a currency they have declared they are
 * not shopping in. The label still names the currency, because a bare "Value" over a figure
 * that changes denomination in Settings would be a number with no units.
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
  deckDriven = false,
}: {
  summary: Summary | undefined;
  /** Which marketplace's prices this row totals: its currency writes the figure, its label is
   *  the as-of sentence. The figure itself was summed by the query. */
  marketplace: Marketplace;
  /**
   * Whether these figures are the sum of the reader's decks rather than of rows they added.
   *
   * One figure reads it — see the For trade one below. Defaulted, so every story and the
   * hand-kept collection get the row unchanged.
   */
  deckDriven?: boolean;
}) {
  const value = summary ? summary.value : null;
  const unpriced = summary ? summary.unpriced : 0;
  return (
    <FigureRow>
      {/* Copies, not rows — a row emptied to zero contributes nothing to what is owned. */}
      <Figure label="Cards" value={summary ? count(summary.totalCards) : "—"} />
      <Figure label="Unique" value={summary ? count(summary.uniqueCards) : "—"} />
      <Figure
        label={`Value (${marketplace.currency.toUpperCase()})`}
        value={summary ? formatPrice(value, marketplace.currency) : "—"}
        note={unpriced > 0 ? `${count(unpriced)} unpriced` : undefined}
        title={pricesAsOf(marketplace)}
      />
      {/* Only when there is one: a permanent "For trade — 0" is a column of chrome that has
          never once been the answer to anything.

          **And never at all while the collection is derived.** A tradelist is a statement
          about spare copies the reader made row by row, and a derived row is a deck's card:
          there is nothing to mark as spare and the backend sums a hard zero. Drawn, it would
          read as "you have nothing to trade" — a claim about their collection — rather than
          "this view is not counting that". The `> 0` guard already hides it in practice; this
          says so on purpose, so the figure cannot reappear if the aggregate ever changes. */}
      {!deckDriven && summary && summary.tradelistCards > 0 && (
        <Figure label="For trade" value={count(summary.tradelistCards)} />
      )}
    </FigureRow>
  );
}
