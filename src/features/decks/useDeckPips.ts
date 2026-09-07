/**
 * Every deck's colour bar, in one read.
 *
 * `deck_pip_costs` answers the whole gallery at once rather than a tile at a time, which is what
 * makes the bar affordable: the alternative is `deck_get` per deck, the heaviest read in the
 * feature, forty tiles deep. What comes back is one `(cost, copies)` pair per distinct cost per
 * deck — 90 rows for the dev database's 611 `deck_cards` rows — and `deckPips` folds it into the
 * distribution each bar draws.
 */
import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { ipc, type DeckPipCosts } from "@/lib/ipc";
import type { PipCounts } from "@/lib/mana";
import { deckPips } from "./deckPips";

/**
 * The pip distribution of every deck, keyed by id.
 *
 * `["decks", "pips"]`, **under the `["decks"]` root every deck write already invalidates**, and
 * that is the whole of what keeps a bar honest: adding a card, moving one between piles,
 * switching a category off or clearing a deck all fire
 * `invalidateQueries({ queryKey: ["decks"] })` today, so the colours follow the cards with no
 * mutation anywhere learning that this key exists. `useDecks`' header is where that arrangement
 * is argued and `useDeckPlays` is the nearest precedent — a read that goes stale on exactly the
 * same events, keyed the same way for the same reason.
 *
 * No arguments, no `enabled` and no per-deck key. The gallery wants all of them, the read
 * answers all of them, and a key naming a deck would be a cache entry per tile over one round
 * trip's worth of data.
 */
export function useDeckPips(): {
  byDeck: Map<number, PipCounts>;
  query: UseQueryResult<DeckPipCosts[]>;
} {
  const query = useQuery({ queryKey: ["decks", "pips"], queryFn: () => ipc.deckPipCosts() });

  /**
   * Memoised on `query.data`, because every tile on the wall reads this map during layout and
   * the colour sort reads it once per comparison. TanStack hands back the same array identity
   * until the answer actually changes, so the map holds still across a re-render and a caller
   * may put it in a dependency array — which `sortDecks`' context is. A read that has not
   * answered memoises one empty map and keeps handing that same one back.
   */
  const byDeck = useMemo(() => deckPips(query.data ?? []), [query.data]);

  return {
    /**
     * **A deck absent from this map is not a deck with no pips** — it is also a deck the read
     * has not reached, one still in flight and one whose read failed. `deckPips` says why the
     * two are not distinguished here and the consumers agree about it: no bar either way, and
     * last in a colour sort either way. Read `query` for the states themselves.
     */
    byDeck,
    query,
  };
}
