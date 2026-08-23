import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CollectionQuery } from "@/lib/ipc";

/**
 * Which of the two things a press on the card search's **Add** button means.
 *
 * The docked panel has two tabs now: one searches the reader's own binder, one searches every
 * printing Scryfall has published. On the binder tab "I own this" is a fact about the row under
 * the cursor. On the card-search tab it is a *question*, and it is the question this type is the
 * answer to — a card found in Scryfall's data is either a copy the reader already has somewhere
 * on their desk, or one they are putting on the deck list in order to go and buy it.
 *
 * - **`need`** writes a `deck_cards` row and nothing else. The deck's group holds no copy for
 *   it, so it reads as *missing*, which is exactly what the deck→wishlist sweep is built on.
 * - **`own`** prefers to **move a free copy the reader already has** into the deck's group, and
 *   records a new one there only when there is none — "I own this, I just hadn't written it
 *   down". That is what makes the two tabs agree: "I own this" does the same thing whether the
 *   card was found by searching Scryfall or by searching the binder.
 */
export type AddMode = "own" | "need";

/**
 * The two modes and what the control calls them, in the order it offers them.
 *
 * The words are the reader's own — "cards I own", "cards I need" — rather than a storage word
 * like *allocated*: this is a question about their cardboard, not about a folder.
 */
export const ADD_MODES = [
  { id: "own", label: "Cards I own" },
  { id: "need", label: "Cards I need" },
] as const satisfies readonly { id: AddMode; label: string }[];

/**
 * The mode a reader who has never pressed the control gets — **`need`, which is what this
 * button already did**.
 *
 * Deliberately not the tab strip's reasoning read across. The *tab* defaults to the collection
 * because a deck is built out of cards you have; this control is on the other tab, which is the
 * one you reach for when your binder did not answer — so the card in front of you is, by the
 * very act of being looked for there, more likely to be one you do not have. And the two
 * candidate defaults are not symmetric in what they cost when wrong: `need` writes a list row
 * and nothing else, while an `own` default would quietly file collection rows for cards the
 * reader never claimed to have. A default that only ever *under*-claims is the safe one.
 */
export const DEFAULT_ADD_MODE: AddMode = "need";

/**
 * Where one deck's answer is kept for the life of the window.
 *
 * Exported for `DECK_SEARCH_TAB_KEY`'s reason: a test or a story that wants the editor to open
 * in one mode seeds the cache rather than pressing the control, and a key spelled twice is a key
 * that drifts.
 *
 * **Keyed by the deck**, which is the one place this parts company with the tab strip beside it.
 * The tab is a fact about how the reader searches; this is a fact about the deck they are
 * building — a cube being assembled out of the binder and a Standard deck being shopped for are
 * two different answers, and one entry would make a reader who flipped it for one flip it for
 * every deck they opened afterwards.
 */
export function addModeKey(deckId: number | null): readonly unknown[] {
  return ["deckAddMode", deckId];
}

/** Whether a value out of the cache is a mode this build draws — `isDeckSearchTab`'s shape, and
 *  its reason: the entry is untyped at the cache and a story or an older build may have put
 *  anything in it. */
export function isAddMode(value: unknown): value is AddMode {
  return ADD_MODES.some(({ id }) => id === value);
}

/**
 * Which of the two things this deck's adds mean, and the press that changes it.
 *
 * **The query cache rather than a `useState`, for `useDeckSearchTab`'s reason**: the editor is
 * keyed on the deck id, so leaving a deck and coming back tears the whole editor down. A
 * decision made once for a brewing session has to outlive that, and the cache is app-scoped —
 * one `QueryClient` per process.
 *
 * **There is no command behind it, so the memory ends with the window**, which is the same
 * deliberate limit the tab strip carries: `SCHEMA_VERSION` does not move for this PR. If it
 * turns out to want a `decks` column, this hook is the one place that changes and every reader
 * is already going through {@link addModeKey}.
 *
 * `staleTime`/`gcTime: Infinity` are what make "for the session" literal: nothing else writes
 * these entries, so there is nothing to go stale against, and without the second the entry is
 * collected once the editor closes and the next open starts on the default again.
 */
export function useAddMode(deckId: number | null): {
  mode: AddMode;
  setMode: (mode: AddMode) => void;
} {
  const queryClient = useQueryClient();
  const key = addModeKey(deckId);
  const query = useQuery({
    queryKey: key,
    // Never actually run once a value is in the cache, and the honest answer if it ever is — a
    // fetch here can only mean the entry was thrown away, and the default is what a session with
    // no press in it means.
    queryFn: () => DEFAULT_ADD_MODE,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const setMode = useCallback(
    (mode: AddMode) => queryClient.setQueryData(addModeKey(deckId), mode),
    [queryClient, deckId],
  );

  const stored = query.data;
  // Narrowed on the way out rather than trusted: `undefined` is the first render, before the
  // resolved `queryFn` has landed, and a seeded entry is whatever the seeder wrote.
  return { mode: isAddMode(stored) ? stored : DEFAULT_ADD_MODE, setMode };
}

/**
 * One collection row, as much of it as the choice below reads.
 *
 * Every field is `CollectionRow`'s own and spelled the same way, so a row off `collection_list`
 * **is** one of these with nothing to adapt — the narrower type is here so the rule can be
 * tested against five fields rather than against a forty-field fixture, and so that what the
 * choice is allowed to read is written down.
 */
export interface FreeCopy {
  id: number;
  cardId: string;
  /** `null` is an orphan — the printing this row names has left `cards`. See
   *  {@link chooseFreeCopy}, which drops it. */
  oracleId: string | null;
  quantity: number;
  proxy: boolean;
}

/**
 * The `EntryChange.id` an **own** add answers with, and it names nothing.
 *
 * `collection_to_deck` writes the `deck_cards` row and then answers about the **collection** row.
 * Every other add in this editor answers `deck_cards.id`, which is what `useRecentAdds` points the
 * reader at for five seconds, so an own add has no row to point at and says so with a number no
 * row can have. **A caller must test it** rather than pass it on; `DeckEditor` does, at `onAdded`.
 *
 * **The Rust half of the fix has landed and this arm has not been wired to it** (2026-08-23):
 * `MoveOutcome` carries `deckCardId` now — the row the write landed on, read back through
 * `RETURNING id` so that the `ON CONFLICT` arm answers the row it merged into rather than
 * whatever statement wrote last — and `useDeck`'s owned arm still answers this constant. Passing
 * it through is the whole of what is left, and it is a change to what the editor draws (a landed
 * glow where there is none today) rather than to what it writes.
 */
export const NO_DECK_ROW = 0;

/** How many rows one hunt reads. A reader owns a handful of copies of any one card, and the
 *  query below is already narrowed to that card server-side, so this is headroom rather than a
 *  page: the backend caps at 500 and this never expects to reach it. */
export const FREE_COPY_LIMIT = 200;

/**
 * Every copy of one oracle card that no deck is holding — the hunt behind `own`.
 *
 * **`allocation: "unallocated"` is the whole of "free", and it is the one line here that keeps
 * another deck's cards out of reach.** It drops the rows filed in a `deck` folder and nothing
 * else: the root, a binder the reader made and `Recently removed` are all cards on their desk.
 * This path is *silent* — no dialog, one click — so a copy another deck is holding must never be
 * a candidate; taking one from another deck is only ever done through the Collection Search
 * tab's confirm, which says whose it was before it presses.
 *
 * Narrowed to the one oracle card server-side so a page of {@link FREE_COPY_LIMIT} is a page of
 * *this* card. {@link chooseFreeCopy} tests the oracle id again on every row it is handed, which
 * is not belt and braces: it is what makes this correct rather than merely narrow if the filter
 * is ever dropped on the wire.
 *
 * **`oracleId` is `CollectionQuery`'s own field again** (2026-08-23). It was reached through a
 * local `FreeCopyQuery extends CollectionQuery` for a day: `filters::CardFilters` in Rust has
 * carried `oracle_id` since the field was added and `push_card_filters` emits it for all three
 * lists, but the TypeScript mirror said otherwise in a doc comment and `ipc.ts` was another
 * agent's file. The mirror declares it now, so the local type is gone — two declarations of one
 * shape drift the first time either changes, and the local one is never the one anybody updates.
 */
export function freeCopiesQuery(oracleId: string): CollectionQuery {
  return {
    oracleId,
    allocation: "unallocated",
    limit: FREE_COPY_LIMIT,
    offset: 0,
  };
}

/**
 * Which copy an `own` add takes — **the deleted allocator's preference order, kept verbatim**.
 *
 * ```rust
 * order.sort_by_key(|&i| (pool[i].card_id != card_id, pool[i].proxy, pool[i].entry_id));
 * ```
 *
 * That line was the one piece of `allocate_deck` worth keeping, and keeping it is why a reader
 * who used to let the allocator choose sees the same copy chosen now:
 *
 * 1. **The exact printing**, because the card in their hand is the card they searched for.
 * 2. **A real copy before a proxy**, because a proxy is a slot rather than a card.
 * 3. **The oldest entry**, because with nothing else to separate two copies the one recorded
 *    first is the one they have had longest.
 *
 * The keys are lexicographic and that is not a detail: an exact **proxy** outranks a real copy
 * of another printing. It reads wrong and it is the order that shipped, so it is pinned by a
 * test of its own rather than tidied.
 *
 * **The pool is the oracle card**, exactly as `WHERE c.oracle_id = ?` made it: a row of another
 * card is not a candidate at any key, and an **orphan** — `oracleId: null`, a printing that has
 * left `cards` — is not one either, even when its `cardId` matches. The allocator's `JOIN cards`
 * dropped it, and the identity that makes two printings the same card is the one it does not
 * have.
 *
 * **One row has to cover the whole ask, which is the one place this departs from the
 * allocator.** That walk was rebuilding a whole deck's claims and could spend three rows on one
 * card; this is one press for one card, and the second half of a press that half-landed would be
 * a second write with its own way to fail. Every caller in the app asks for **one** copy, so the
 * departure is reachable only from a caller that does not exist yet — and when one does, "record
 * the copies I could not find" is a better answer than a partial move.
 */
export function chooseFreeCopy<T extends FreeCopy>(
  rows: readonly T[],
  want: { cardId: string; oracleId: string | null; atLeast?: number },
): T | null {
  if (want.oracleId === null) return null;
  const atLeast = want.atLeast ?? 1;
  // `filter` copies, so the `sort` below is not reordering the caller's page.
  const pool = rows.filter(
    (row) => row.oracleId !== null && row.oracleId === want.oracleId && row.quantity >= atLeast,
  );
  // The three keys, each as a number so that `||` chains them in order — the Rust tuple sort
  // written out. **Not `[a,b,c] < [x,y,z]`**, which coerces both to strings and ranks entry 10
  // above entry 9: the tie-break is the key most often exercised and the one an array comparison
  // gets wrong on the second digit.
  const exact = (row: T) => (row.cardId === want.cardId ? 0 : 1);
  pool.sort(
    (a, b) => exact(a) - exact(b) || Number(a.proxy) - Number(b.proxy) || a.id - b.id,
  );
  return pool[0] ?? null;
}
