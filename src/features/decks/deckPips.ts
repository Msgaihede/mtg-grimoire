/**
 * A deck's printed mana costs, folded into the distribution the colour bar draws.
 *
 * `deck_pip_costs` answers one row per distinct cost string per deck — `{"{1}{R}", 4}` rather
 * than four copies of `{1}{R}` — because the whole gallery's pile is 611 `deck_cards` rows on
 * the dev database and **90** cost rows, and the difference between those two numbers is the
 * entire reason the read is one call for every deck instead of one call per tile. This module
 * is the other half of that arrangement: Rust ships the strings, TypeScript counts the pips.
 *
 * **Nothing here spells out what a pip is.** `{W/U}` being one pip of each half, `{2/W}` being
 * one white pip, `{X}` and `{2}` being none at all — that vocabulary is `src/lib/mana.ts`'s,
 * over the one `SYMBOL` tokeniser that already parses every cost line and every ability in this
 * app, and a second spelling of it here is exactly how two counters come to disagree about a
 * Phyrexian hybrid. This file folds; `addPips` decides.
 */
import { MANA_KEYS, MANA_LABEL, addPips, emptyPips, type ManaKey, type PipCounts } from "@/lib/mana";
import type { DeckPipCosts } from "@/lib/ipc";

/**
 * Every deck's pip distribution, keyed by deck id.
 *
 * **A deck with no cost rows is absent from the map rather than present with a record of
 * zeroes**, and the difference is a claim about what was asked. An empty record says "this deck
 * was counted and holds no pips"; no entry says nothing at all — which is the honest answer for
 * a deck the read has not reached, a read still in flight and a read that failed, three states
 * that are indistinguishable from here. The consumers treat the two the same way (no bar, and
 * last in a colour sort), so inventing the zeroes would buy nothing and would have the map
 * asserting a fact about every deck id anybody ever handed it.
 *
 * The rows are folded rather than replaced, so a backend that ever answered two rows for one
 * deck adds them instead of losing one — there is no unique index on `(deck, cost)` in the
 * answer's shape, only in the query that builds it.
 */
export function deckPips(rows: readonly DeckPipCosts[]): Map<number, PipCounts> {
  const byDeck = new Map<number, PipCounts>();
  for (const row of rows) {
    let pips = byDeck.get(row.deckId);
    if (pips === undefined) {
      pips = emptyPips();
      byDeck.set(row.deckId, pips);
    }
    for (const cost of row.costs) addPips(pips, cost.cost, cost.copies);
  }
  return byDeck;
}

/**
 * Every pip in the deck, colourless included — the denominator each segment's width is a share
 * of.
 *
 * Zero is a real answer and the one the bar checks: an all-lands pile, or a deck of nothing but
 * `{2}` artifacts, has counted rows and no pips, and **a deck with no pips draws no bar at
 * all** rather than an empty rule. A 1px grey line saying "this deck has nothing to say about
 * colour" is worse than silence.
 */
export function pipTotal(pips: PipCounts): number {
  let total = 0;
  for (const key of MANA_KEYS) total += pips[key];
  return total;
}

/**
 * The colours actually present, in {@link MANA_KEYS} — **printed** — order.
 *
 * WUBRG then colourless is not a preference: it is the order the symbols are printed in, and it
 * is what makes the bar's accessible name (`"White, Green"`) read the way a player would say the
 * deck's colours out loud. A colour with no pips is omitted rather than named with a zero, so
 * the list is the deck's identity as the costs show it and never a six-entry table with holes.
 */
export function pipColors(pips: PipCounts): ManaKey[] {
  return MANA_KEYS.filter((key) => pips[key] > 0);
}

/**
 * The deck's colours as a screen reader hears them — `"White, Green"` — or `null` when there are
 * none to name.
 *
 * **One definition, because the bar and the words are drawn by two different elements.** The bar
 * itself is `aria-hidden`: it sits between the cover and the deck's name inside the tile's
 * `<button>`, and anything named there lands in that button's accessible name *ahead* of the
 * deck — which is the exact argument `DeckTile` already makes about the theory badge, and the
 * reason that badge is drawn outside the button. So the picture is decorative and the sentence is
 * a separate `sr-only` span placed after the name, and this function is what keeps the two from
 * becoming two answers to "which colours is this deck".
 *
 * The alternative — leaving the name on the bar — was written first and measured: it made the
 * tile's accessible name `"White, Red Zoo …"`, so `getByRole("button", { name: /^Zoo/ })` matched
 * nothing and a reader driving the app by voice could not say "click Zoo". A tile is named for
 * its deck.
 *
 * `null` rather than `""` for the two silences {@link DeckColorBar} draws nothing for, so a call
 * site cannot render an empty element by forgetting to check.
 */
export function deckColorsLabel(pips: PipCounts | null): string | null {
  if (pips === null) return null;
  const colors = pipColors(pips);
  return colors.length === 0 ? null : colors.map((key) => MANA_LABEL[key]).join(", ");
}
