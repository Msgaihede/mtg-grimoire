import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, ipcError } from "@/lib/ipc";

/**
 * Where the setting lives for the life of the window.
 *
 * Exported for `NAV_COLLAPSED_KEY`'s reason: a story or a test that wants the app to open
 * already deck-driven seeds the cache rather than mocking the command, and a key spelled twice
 * is a key that drifts.
 */
export const DECK_DRIVEN_KEY = ["deckDrivenCollection"];

/**
 * Why a control that edits the collection by hand is out of reach, in the clause that is
 * appended to its accessible name.
 *
 * **A clause, not a sentence, and that is the whole of why it is not the backend's string.**
 * Rust refuses the write with a full sentence a reader reads on its own — an alert, after they
 * pressed something. This is read *as part of* a control's name, immediately after the name of
 * the thing being greyed, by a reader sweeping the page with a screen reader: `"Add to
 * collection — your collection is driven by your decks"`. A capitalised sentence with a full
 * stop in the middle of an accessible name is the wrong register, and a second copy of the
 * backend's wording is a second place for it to drift. The two are deliberately different
 * strings for two different jobs.
 *
 * One constant because **four** surfaces append it, and four hand-written wordings of one fact
 * is four things a reader has to work out are the same fact.
 */
export const DECK_DRIVEN_REASON = "Your collection is driven by your decks";

/** What {@link setDeckDriven} sends: the answer, and what to put back if it is refused. */
type Write = { enabled: boolean; previous: boolean };

/**
 * The four roots a change to **what the reader owns** makes wrong.
 *
 * One list rather than seven copies of it, because seven copies is seven places for the next
 * root to be forgotten in — and it was: this list stood on the flag's own mutation alone while
 * every deck-write hook in the app fired `["decks"]` and nothing else, which is what
 * {@link useDeckWriteRoots} exists to fix.
 *
 * * `["collection"]` — the list and the summary header above it.
 * * `["cards", "search"]` — the wall's `ownedQuantity`, which is what an `OwnedBadge` draws.
 * * `["decks"]` — every `DeckCard.ownedQuantity`, and the gallery tile's `cardCount`.
 * * `["wishlist"]` — `WishRow.ownedQuantity`, the copies that already fill a wish.
 *
 * **Deliberately not `["card"]`, and not the wider `["cards"]`.** These are the four the flag's
 * own write has always fired and the four `AddToCollection` and `useCardMenuDeps` fire; widening
 * the list is a decision about the card pane's printing counts that belongs with whoever makes
 * it for all of them at once, not a thing to slip in at a deck write.
 */
export const OWNERSHIP_ROOTS: readonly string[][] = [
  ["collection"],
  ["cards", "search"],
  ["decks"],
  ["wishlist"],
];

/**
 * What a deck write moves while the collection is **hand-kept** — and it is not nothing.
 *
 * `allocate_deck` runs inside the write's own transaction, so `deck_allocations` moves and
 * every other deck's `ownedQuantity` with it. This was the whole invalidation before the
 * setting existed and it stays the floor: {@link useDeckWriteRoots} adds to it, never replaces
 * it.
 */
const DECK_ROOTS: readonly string[][] = [["decks"]];

/**
 * Whether the collection is the sum of the reader's live decks — remembered across restarts.
 *
 * TanStack Query rather than the zustand store, for `useNavCollapsed`'s reason: `store.ts`
 * scopes itself to UI state and hands anything backed by the database to Query, and this is one
 * `app_meta` row that outlives the process.
 *
 * **Where this deliberately differs from `useNavCollapsed`.** That hook writes optimistically
 * and never rolls back, on the argument that a refused write costs the reader one launch's
 * starting state and snapping the rail shut under their hand is worse. Every clause of that
 * points the other way here: this switch decides what the Collection page is a *list of*, so a
 * refusal that left the switch reading "on" over a hand-kept collection would be the page and
 * the setting disagreeing until the next restart — and the reader would be looking at rows the
 * control beside them says do not exist. So the optimistic half **is** rolled back and the
 * refusal **is** surfaced: `error` is the sentence the settings panel draws.
 *
 * **A read that fails is `false`** — the hand-kept collection, which is where the reader's own
 * rows are. That is the right floor rather than an arbitrary one: the degraded state shows them
 * their data instead of an empty page. It is also why a failed *read* raises nothing while a
 * failed *write* does — nobody asked for the read, and its fallback is already the safe answer.
 *
 * The four invalidations on success are the four surfaces the flag moves, and they are the same
 * four `AddToCollection` and `useCardMenuDeps` already fire, because the same four things
 * change: the collection list and its header, the search wall's owned counts, the decks (whose
 * "in collection" arithmetic is now circular), and the wishlist's have/want.
 */
export function useDeckDrivenCollection(): {
  deckDriven: boolean;
  setDeckDriven: (enabled: boolean) => void;
  error: string | null;
} {
  const queryClient = useQueryClient();
  const deckDriven = useDeckDrivenFlag();

  const write = useMutation({
    mutationFn: ({ enabled }: Write) => ipc.setDeckDrivenCollection(enabled),
    onSuccess: () => {
      for (const queryKey of OWNERSHIP_ROOTS) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
    // The rollback the rail's twin refuses to do, and the reason is the page behind it. The
    // previous value is carried in rather than derived as `!enabled`: a caller that sets the
    // flag to what it already is — a defensive write from a control that does not compare
    // first — would otherwise be "rolled back" to the opposite of where it started.
    onError: (_e, { previous }) => {
      queryClient.setQueryData(DECK_DRIVEN_KEY, previous);
    },
  });

  const startWrite = write.mutate;
  const setDeckDriven = useCallback(
    (enabled: boolean) => {
      // The optimistic half. `setQueryData` before `mutate`, not in an `onMutate`, for
      // `useNavCollapsed`'s reason: the two are the same commit either way, and doing it here
      // says outright that the cache is the reader's choice and the command is only how it is
      // remembered.
      const previous = queryClient.getQueryData<boolean>(DECK_DRIVEN_KEY) ?? false;
      queryClient.setQueryData(DECK_DRIVEN_KEY, enabled);
      startWrite({ enabled, previous });
    },
    [queryClient, startWrite],
  );

  return {
    deckDriven,
    setDeckDriven,
    /**
     * Derived from the mutation rather than held in a `useState`, which is `useMarketplace`'s
     * shape and one source of truth instead of two. It clears on the next press rather than on
     * the next success — `mutate` resets the mutation before it runs — and that is the right
     * moment: the sentence is about an attempt, and a new attempt supersedes it.
     */
    error: write.error ? ipcError(write.error) : null,
  };
}

/**
 * The flag alone, without the write half.
 *
 * Split out of {@link useDeckDrivenCollection} rather than duplicated, so that the six deck-write
 * hooks that only need to *read* the mode do not each mount a `useMutation` they will never fire.
 * One query key, `staleTime: Infinity`: however many callers there are, the row is read once per
 * app run and every observer shares the answer.
 *
 * **`undefined` is the read that has not answered yet _and_ the read that failed, and both mean
 * the same thing here: the hand-kept collection.** For a caller invalidating after a write that
 * is the conservative floor rather than a guess — it fires the roots that were always right, and
 * a wrong `false` costs exactly the staleness {@link useDeckWriteRoots}'s callers exist to fix.
 */
export function useDeckDrivenFlag(): boolean {
  const query = useQuery({
    queryKey: DECK_DRIVEN_KEY,
    queryFn: () => ipc.deckDrivenCollection(),
    // Read once per app run. Nothing else writes this row, so there is nothing to go stale
    // against — every change to it goes through the mutation above, which writes the answer
    // straight into the cache.
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return query.data ?? false;
}

/**
 * The roots **a deck write** makes wrong, which is a different list in each mode.
 *
 * While the collection is derived, a deck write *is* a collection write — the Rust side routes
 * fifteen commands through `with_write_owned_if_derived` for exactly this — so the reader's
 * ownership has changed and all four of {@link OWNERSHIP_ROOTS} are describing a collection that
 * has moved. While it is hand-kept, `deck_allocations` still moved and {@link DECK_ROOTS} is
 * still owed.
 *
 * **Additive, and that is the part to get right.** `["decks"]` is in both lists: the gate *adds*
 * three roots to the floor and never swaps the floor out for them. A conditional that replaced
 * the deck root would break every deck surface in the ordinary mode in order to fix the other
 * one.
 *
 * **Why a gate at all, when the refetch is against local SQLite.**
 * `CollectionRow.deckCount` is `null` unless the collection is derived, and `CardSummary`'s owned
 * count is allocation-blind — so in the hand-kept mode there is provably nothing on those three
 * roots that a deck write can have changed, and firing them would be three refetches per press
 * of the stepper that can only ever answer what is already on screen.
 */
export function useDeckWriteRoots(): readonly string[][] {
  return useDeckDrivenFlag() ? OWNERSHIP_ROOTS : DECK_ROOTS;
}
