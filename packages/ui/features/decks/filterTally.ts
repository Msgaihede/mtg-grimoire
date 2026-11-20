import { count } from "@/lib/counts";
import type { DeckCard } from "@/lib/ipc";
import { deckStats, type CategoryCount } from "./DeckStats";

/**
 * What the deck's filter left on the desk, counted in the ledger's own words (issue #1706).
 *
 * The ledger's `Cards` figure is the whole deck and stays that way — it is a fact about the deck,
 * and a keystroke in the filter must not re-render it (`DeckDesk`'s seam). So the narrowed count
 * is the desk's own readout, beside the box that narrows it, and it is spelled the way the
 * ledger's figure is: a headline the size rule counts, and a dim `+n` for every other copy on
 * screen. `t:spacecraft` over a deck with 19 in its piles and 6 in the sideboard reads `19+6`,
 * which answers both "how many does the deck play" and "how many am I looking at".
 */
export interface FilterTally {
  /** Copies on screen the format's size rule counts — `deckStats`' own `sized`, over the narrowed
   *  rows, so the readout and the ledger cannot read the rule two ways. */
  sized: number;
  /**
   * Every other pile with a copy on screen, each named: the switched-on piles the size rule
   * leaves out (`deckStats`' `elsewhere` — a sideboard, a companion), then the switched-off ones.
   *
   * **The switched-off piles are here, where the ledger has none**, and that is the one place the
   * two part: the ledger counts the deck, which a Maybeboard is not part of, while this counts
   * the desk, where a Maybeboard card the filter matched is drawn like any other. A `+n` that
   * left it out would be a readout that disagrees with the headings under it.
   */
  rest: readonly CategoryCount[];
  /** The copies in {@link rest}: `sized` plus this is every copy the filter left on the desk. */
  restCopies: number;
}

/** The rows the filter left, tallied — see {@link FilterTally}. */
export function filterTally(shown: readonly DeckCard[]): FilterTally {
  const stats = deckStats(shown);
  // `deckStats` leaves switched-off piles out of everything but `byCategory`, which does not say
  // which piles are switched off — so they are gathered here, in the rows' own (pile) order.
  const off = new Map<number, CategoryCount>();
  for (const card of shown) {
    if (card.categoryActive) continue;
    const at = off.get(card.categoryId);
    if (at) {
      at.quantity += card.quantity;
      continue;
    }
    off.set(card.categoryId, {
      id: card.categoryId,
      name: card.categoryName,
      quantity: card.quantity,
    });
  }
  const rest = [...stats.elsewhere, ...off.values()];
  return {
    sized: stats.sized,
    rest,
    restCopies: rest.reduce((n, pile) => n + pile.quantity, 0),
  };
}

/** The readout's tooltip — the ledger's `Cards` sentence, said of what is shown. */
export function filterTallyHint(tally: FilterTally): string {
  if (tally.rest.length === 0) return "Cards shown that count toward deck size.";
  const rest = tally.rest
    .map((pile) => `${count(pile.quantity)} ${pile.name.toLowerCase()}`)
    .join(" + ");
  return `Cards shown that count toward deck size, plus ${rest} (not counted).`;
}
