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

  const query = useQuery({
    queryKey: DECK_DRIVEN_KEY,
    queryFn: () => ipc.deckDrivenCollection(),
    // Read once per app run. Nothing else writes this row, so there is nothing to go stale
    // against — every change to it goes through the mutation below, which writes the answer
    // straight into the cache.
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const write = useMutation({
    mutationFn: ({ enabled }: Write) => ipc.setDeckDrivenCollection(enabled),
    onSuccess: () => {
      for (const queryKey of [["collection"], ["cards", "search"], ["decks"], ["wishlist"]]) {
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
    // `undefined` is the read that has not answered yet *and* the read that failed, and both
    // mean the same thing here: draw the hand-kept collection.
    deckDriven: query.data ?? false,
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
