/**
 * The bracket every tile in the gallery shows — the reader's own answer where they gave one,
 * the estimate where they did not, and nothing at all where there is neither.
 *
 * `DeckBracket` asks this question for the deck that is open; this asks it for a wall of them.
 * The two must give the same answer about one deck, so the *vocabulary* is shared by
 * construction ({@link bracketLabel} below is written against `DeckBracket.tsx:223-224`) and the
 * arithmetic is literally the same function — `estimateBracket`, run here over the five fields
 * `deck_bracket_reads` ships instead of over the forty `deck_get` does.
 *
 * **One caveat, and it is a difference in the question rather than in the answer.** The editor
 * estimates over the variant the reader is standing on, so a deck left on the Theory tab reads
 * its *plan* there. This reads the live list, always. The tile is a fact about the deck; the
 * editor is a fact about what is on screen.
 */
import { useMemo } from "react";
import { useQuery, type QueryKey, type UseQueryResult } from "@tanstack/react-query";
import { AUTO_BRACKET, ipc, type DeckBracketRead } from "@/lib/ipc";
import { estimateBracket } from "./validation/bracket";

/**
 * `["decks", "brackets", <the sorted ids>]`.
 *
 * **Under the `["decks"]` root**, which is the whole of the invalidation story: every deck write
 * in the app already fires `invalidateQueries({ queryKey: ["decks"] })`, so an add, a removal, a
 * pile switched off or a deck deleted refreshes every tile's estimate for free and no mutation
 * has to learn this key exists. `useDeckPlays` states that argument at length and it is the same
 * one.
 *
 * **Keyed on the ids and sorted and deduped before they enter it**, which is
 * `combosForCardsKey`'s rule in `lib/query.ts:68-72` applied one feature over: the answer does
 * not depend on the order, so two renders that arrived at the same set of decks by different
 * routes — a filter typed forwards and a filter typed backwards — must ask TanStack one question
 * and pay for one round trip.
 *
 * **The comparator is numeric, and that is about legibility rather than about the cache.**
 * `[2, 10].sort()` is a string sort and answers `[10, 2]` — but it answers `[10, 2]` for *both*
 * orderings, so a bare `.sort()` is still canonical and the cache would be just as safe. What it
 * is not is honest: the list goes on the wire as the read's argument and into the key a developer
 * reads in the devtools, and a sorted list of deck ids that runs 10 before 2 is a list that will
 * be misread by the next person who looks at it. `deckBracketsKey`'s own test pins the numeric
 * order for that reason and not for a correctness one.
 */
export const deckBracketsKey = (sortedDeckIds: readonly number[]): QueryKey => [
  "decks",
  "brackets",
  sortedDeckIds,
];

/**
 * A bracket floor per deck, estimated from the deck's own cards.
 *
 * **`deckIds` is the caller's decision and deliberately not a SQL one.** Which decks even have a
 * bracket is a question about the *format* — `useFormatSpecs`' `commanderRule` — and that
 * vocabulary lives on this side. A gallery of Modern decks therefore asks for nothing, and
 * `enabled` turns the whole read off: an empty list, and a wall with no Commander deck on it,
 * cost no IPC call at all rather than a round trip that answers `[]`.
 */
export function useDeckBrackets(deckIds: readonly number[]): {
  floorByDeck: Map<number, number>;
  query: UseQueryResult<DeckBracketRead[]>;
} {
  const asked = useMemo(
    () => [...new Set(deckIds)].sort((a, b) => a - b),
    // The caller's array is very often a fresh identity per render (a `filter` over the deck
    // list), so this recomputes freely — it is a dozen numbers. What matters is that the *key*
    // it builds hashes the same, which TanStack does structurally.
    [deckIds],
  );

  const query = useQuery({
    queryKey: deckBracketsKey(asked),
    queryFn: () => ipc.deckBracketReads(asked),
    enabled: asked.length > 0,
  });

  /**
   * **Only the floor is kept.** `estimateBracket` answers a whole `BracketEstimate` — the Game
   * Changers by name, the denial, the extra turns, both halves of the combo split — and a tile
   * has room for none of it. The panel behind the editor's button is where that belongs, and
   * holding it here would be a per-deck object nothing reads, kept alive for as long as the
   * gallery is on screen.
   *
   * Memoised on `query.data`: TanStack hands back the same array identity until the answer
   * actually changes, so the map holds still across a re-render and a caller may put it in a
   * dependency array — which `sortDecks`' context is. An unanswered query memoises one empty
   * map and keeps handing that same one back, so "nothing yet" holds still too.
   */
  const floorByDeck = useMemo(() => {
    const map = new Map<number, number>();
    for (const read of query.data ?? []) {
      map.set(read.deckId, estimateBracket(read.cards, read.combos).floor);
    }
    return map;
  }, [query.data]);

  return { floorByDeck, query };
}

/**
 * What the tile's caption says about the bracket — or `null`, which is a caption with no bracket
 * in it and is what every tile says today.
 *
 * **The vocabulary is `DeckBracket.tsx:223-224`'s and may not diverge from it.** `Bracket 3` is
 * the reader's own answer; `Bracket ~3` is a reading. The `~` is the whole of the visible
 * difference between the two, and it means the same thing on a tile as it does on the editor's
 * button — one glyph a reader learns once. A tile that spelled a reading differently would be
 * teaching a second dialect of a distinction the app has already made.
 *
 * **The editor's third form is deliberately not copied.** That button also draws
 * `Bracket 2 · ~4` when the set bracket sits below the floor, because it is a control: pressing
 * it opens the advisory that names the card responsible, so the second number is a question the
 * reader can immediately ask. A tile is not a control and has no room to explain a mismatch, and
 * a number a reader cannot interrogate is worse than the one they chose — it says "something
 * disagrees with you" and gives them nowhere to go. So a deck with a set bracket shows that
 * bracket, full stop, and the mismatch stays where it can be acted on.
 *
 * `null` covers both halves of "there is nothing to say": a deck on Auto whose estimate has not
 * arrived, and one whose read failed. **Never a placeholder** — no `Bracket ?`, no skeleton, no
 * dash. The caption simply has no bracket in it, which is exactly what it has today, and a tile
 * that flickered a placeholder into a real number on every gallery load would be drawing
 * attention to a query rather than to a deck.
 */
export function bracketLabel(bracket: number, floor: number | undefined): string | null {
  // Anything below 1 is Auto, `bracketWarning`'s reading of the same column: a deck that has not
  // been told what it is has not been told anything this function could print.
  if (bracket > AUTO_BRACKET) return `Bracket ${bracket}`;
  return floor === undefined ? null : `Bracket ~${floor}`;
}

/**
 * The one number a sort ranks a deck by: the set bracket where the reader set one, the estimate
 * otherwise, `null` where there is neither.
 *
 * **The two are ranked together on purpose.** A reader ordering a wall by bracket is asking
 * "which of these are my heavier decks", and answering with two separate ladders — the declared
 * ones and the estimated ones — would split the wall on a distinction they did not ask about.
 * The `~` in the caption is where that distinction is drawn, and it is drawn per tile, where it
 * costs one glyph.
 *
 * `null` is not zero and must never be sorted as one; `deckSort.ts`'s `unknownLast` is what does
 * something about that, and `sorting.ts`'s `nullsLast` is where the rule is stated.
 */
export function effectiveBracket(bracket: number, floor: number | undefined): number | null {
  if (bracket > AUTO_BRACKET) return bracket;
  return floor ?? null;
}
