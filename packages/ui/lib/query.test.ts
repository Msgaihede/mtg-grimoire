import { expect, test } from "vitest";
// `hashKey` and `partialMatchKey` are the library's own — the first is what the cache files an
// entry under and the second is what `invalidateQueries` matches with. Asserting through them
// rather than through `toEqual` on the arrays is the difference between pinning the behaviour
// and pinning my model of it: prefix matching in particular is a rule of TanStack's that this
// file would otherwise be re-implementing in order to check it.
import { hashKey, partialMatchKey } from "@tanstack/react-query";
// Imported through the `@` alias on purpose: this also asserts the
// tsconfig/vite/components.json path alias stays wired up.
import { COMBOS_KEY, cardCombosKey, combosForCardsKey, queryClient } from "@/lib/query";

test("queryClient uses the app-wide query defaults", () => {
  const queries = queryClient.getDefaultOptions().queries;
  expect(queries?.staleTime).toBe(30_000);
  expect(queries?.retry).toBe(1);
});

/**
 * The card-side combo read's key, spelled out rather than derived from the function under test.
 *
 * Six segments and each one is load-bearing: the root a download invalidates, the word that
 * tells this read from the deck's, the card, the search term and the two filters. Written as a
 * literal because an assertion that builds its expectation the same way the implementation does
 * can only ever agree with itself — which is also why the term sits **fourth** here in writing:
 * the order is `combos_for_card`'s own parameter order, and a helper that swapped the term past
 * `cardCount` would still hash two questions apart while describing the wrong call.
 */
test("cardCombosKey names the root, the read, the card, the search and both filters", () => {
  expect(cardCombosKey("bolt-oracle", "thassa", 2, true)).toEqual([
    "combos",
    "forCard",
    "bolt-oracle",
    "thassa",
    2,
    true,
  ]);
  // `null` is "every size" and travels as itself — not dropped, and not folded into a `0` no
  // combo could ever have. The same is true one segment earlier of "no search".
  expect(cardCombosKey("bolt-oracle", null, null, false)).toEqual([
    "combos",
    "forCard",
    "bolt-oracle",
    null,
    null,
    false,
  ]);
});

/**
 * **All three narrowings are in the key**, which is the whole of what makes them filters rather
 * than something a caller does to rows it already has.
 *
 * Each pair below differs in exactly one argument, so a key that dropped that argument would
 * hash the two together and hand the second question the first one's answer. That is not a slow
 * screen but a wrong one: `combos_for_card` narrows in SQL *before* the page is cut, so a
 * two-card-combo answer served out of the unfiltered entry is page one of everything, and a card
 * with forty two-card combos can read as having none. The search term is the case the argument
 * was written for — Ashnod's Altar is in 6 044 combos, so page 1 of the unsearched entry served
 * to a reader who typed `thassa` is a confident "no combos with Thassa in them" over a list they
 * have seen a twentieth of.
 */
test("cardCombosKey caches one answer per question", () => {
  const unfiltered = hashKey(cardCombosKey("bolt-oracle", null, null, false));

  // The search term.
  expect(hashKey(cardCombosKey("bolt-oracle", "thassa", null, false))).not.toBe(unfiltered);
  // Two different terms are two different subjects, not one "searched" bucket.
  expect(hashKey(cardCombosKey("bolt-oracle", "thassa", null, false))).not.toBe(
    hashKey(cardCombosKey("bolt-oracle", "altar", null, false)),
  );
  // The size filter.
  expect(hashKey(cardCombosKey("bolt-oracle", null, 2, false))).not.toBe(unfiltered);
  // The owned filter.
  expect(hashKey(cardCombosKey("bolt-oracle", null, null, true))).not.toBe(unfiltered);
  // Both at once must not hash to either of the halves.
  expect(hashKey(cardCombosKey("bolt-oracle", null, 2, true))).not.toBe(
    hashKey(cardCombosKey("bolt-oracle", null, 2, false)),
  );
  // A term *plus* a facet is a third question again — the case a helper that kept the term but
  // dropped it from the hash when a size was also set would pass over.
  expect(hashKey(cardCombosKey("bolt-oracle", "thassa", 2, true))).not.toBe(
    hashKey(cardCombosKey("bolt-oracle", null, 2, true)),
  );
  // The card itself — the segment whose absence would serve every card one answer.
  expect(hashKey(cardCombosKey("oracle-oracle", null, null, false))).not.toBe(unfiltered);
  // And the same question twice is the same entry, or nothing would ever hit the cache.
  expect(hashKey(cardCombosKey("bolt-oracle", null, null, false))).toBe(unfiltered);
});

/**
 * **`""` and `null` are one question, and this helper is the floor that guarantees it.**
 *
 * A search box produces `""` on every clear — the ✕, a select-all-and-delete, the last backspace
 * — while "nothing typed" is `null` everywhere else in the app. Left alone, the two spellings
 * file two cache entries for one question: a reader who clears the box gets a fresh fetch and a
 * loading state for an answer that is already in hand, and `combos_for_card` reads both as the
 * same request, so the second entry can never even differ from the first.
 *
 * It is pinned **here** because here is where the difference costs something. `ipc.combosForCard`
 * forwards `search` verbatim by design (`ipc.ts` says so at the field), so the wrapper adds no
 * rule of its own; `CombosDialog` normalises further and *trims*, which is a decision about what
 * gets **sent** rather than a second copy of this one, and it composes because it happens before
 * both the key and the wire. Assert the helper, not the dialog: this test has to stay green for a
 * caller that hands over a raw box value, which is what makes the fold a floor.
 *
 * The last two lines are the fold's fence: it collapses the empty string and **nothing else**. A
 * helper written `search || null` would also swallow a term the reader is entitled to search for
 * — `"0"` is a real card name fragment — and one written `search?.trim() || null` would file
 * `" thassa"` and `"thassa"` together while a caller that had *not* trimmed was sending two
 * different requests, which is this rule's own failure arriving from the other direction.
 */
test("cardCombosKey folds an empty search into null, and folds nothing else", () => {
  const none = hashKey(cardCombosKey("bolt-oracle", null, null, false));

  expect(cardCombosKey("bolt-oracle", "", null, false)).toEqual([
    "combos",
    "forCard",
    "bolt-oracle",
    null,
    null,
    false,
  ]);
  expect(hashKey(cardCombosKey("bolt-oracle", "", null, false))).toBe(none);

  // Falsy, and not empty: `"0"` is a term.
  expect(hashKey(cardCombosKey("bolt-oracle", "0", null, false))).not.toBe(none);
  // Whitespace is not empty either — it is a request the backend will answer differently, so the
  // key must not pretend it is the same one.
  expect(hashKey(cardCombosKey("bolt-oracle", " ", null, false))).not.toBe(none);
});

/**
 * **`forCard` and `forCards` are one character apart and must not sweep each other.**
 *
 * These are opposite questions over one table — the deck advisory asks which combos a pile of
 * printings fully contains, the card dialog asks what one card is part of — and TanStack matches
 * by *prefix*, so spelling both `"forCards"` would not alias two cache entries (their third
 * segments differ) but would put them under one prefix. Every prefix-scoped operation there is —
 * `invalidateQueries`, `cancelQueries`, `removeQueries` — aimed at either read would then take
 * the other with it, and the symptom is a bracket advisory refetching for no visible reason.
 *
 * The last two assertions are the other half of the same rule: both reads still have to live
 * under `COMBOS_KEY`, because a finished download replaces the whole table and reaches an open
 * screen through that one root and nothing else.
 */
test("the two combo reads are not each other's prefix, and both are under the combo root", () => {
  const forCard = cardCombosKey("bolt-oracle", null, null, false);
  const forCards = combosForCardsKey(["bolt-a", "bolt-b"]);

  expect(partialMatchKey(forCard, ["combos", "forCards"])).toBe(false);
  expect(partialMatchKey(forCards, ["combos", "forCard"])).toBe(false);
  // Neither is a prefix of the other in the whole, either — which is the same statement made
  // without naming the two words, so a rename that kept them distinct still passes.
  expect(partialMatchKey(forCard, forCards)).toBe(false);
  expect(partialMatchKey(forCards, forCard)).toBe(false);

  expect(partialMatchKey(forCard, COMBOS_KEY)).toBe(true);
  expect(partialMatchKey(forCards, COMBOS_KEY)).toBe(true);
});
