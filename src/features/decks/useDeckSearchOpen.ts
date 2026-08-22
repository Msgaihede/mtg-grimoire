import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";

/**
 * Where the reader's answer about the search column is kept for the life of the window.
 *
 * Exported for `PRINTING_GROUP_BY_KEY`'s reason: a test or a story that wants the editor to open
 * with the column already shut seeds the cache rather than mocking the command, and a key spelled
 * twice is a key that drifts.
 */
export const DECK_SEARCH_OPEN_KEY = ["deckSearchOpen"];

/**
 * What the column does before the stored answer has arrived, and on a database that has never
 * been asked.
 *
 * **`true`, which reverses what this disclosure used to do** (issue #183). It opened shut, on the
 * argument that a search is a thing the reader asks for — and that argument only ever held while
 * the answer was forgotten the moment the deck closed, so a reader who searches while they build
 * pressed the same control on every deck they opened. The default and the memory are one change:
 * this is the state of a database nobody has expressed a preference in, and every reader who
 * shuts the column once never sees it again.
 *
 * It is spelled here **and** in `deck.rs`'s `DEFAULT_DECK_SEARCH_OPEN`, which is not a duplicate
 * of one fact but two answers to two questions — what a *row that is missing* means, which is the
 * backend's, and what a *read still in flight* means, which is this side's and has no backend to
 * ask. They agree on purpose: disagreeing would draw the column one way for the length of a round
 * trip and the other way after it, which is the one visible failure this constant can have.
 */
export const DEFAULT_DECK_SEARCH_OPEN = true;

/**
 * Whether the deck editor's docked card search column is open — remembered across decks and
 * across restarts.
 *
 * TanStack Query rather than the zustand store and rather than a `useState` in the panel, for
 * `usePrintingGroupBy`'s two reasons: `store.ts` scopes itself to UI state and hands anything
 * backed by the database to Query, and this setting lives in `app_meta` so it outlives the
 * process. The cache is also what makes it survive a *deck* — the editor is keyed on the deck id,
 * so opening a second one throws the panel away and mounts a new one, and a new observer over a
 * resolved query is a read of the cache rather than a round trip.
 *
 * **The press is what is remembered, not the drawn state**, and the two are different: the panel
 * rails itself when the desk is too narrow for a deck *and* a column (`DeckSearchPanel`'s
 * `roomy`), and a reader who never touched the control must not come back to a window they never
 * asked for. So the disclosure writes here and the measurement does not.
 *
 * **The write is optimistic and deliberately not rolled back**, which is `usePrintingGroupBy`'s
 * paragraph applied to a control that is pressed far more often: the column has to open on the
 * press rather than a round trip later, and `set_deck_search_open` legitimately answers BUSY
 * while a sync holds the write connection — whole minutes of a first run. Snapping the column
 * shut again under the reader's hand, with nothing on screen saying why, would be worse than
 * losing the memory; what a refused write costs is only that the next launch opens on the state
 * before it.
 *
 * `gcTime: Infinity` is what makes "across decks" literal rather than a five-minute accident.
 * Without it the entry is collected once the last editor closes, and a deck opened six minutes
 * later would re-read `app_meta` and get the value the refused write never stored — the rollback
 * this hook refuses to do, arriving late.
 *
 * **A read that fails is the default, never an error.** Nothing here surfaces `isError` and
 * nothing branches on it: a preference that cannot be read is not worth breaking a deck editor
 * over, and the reader is one press from either state anyway.
 */
export function useDeckSearchOpen(): { open: boolean; setOpen: (open: boolean) => void } {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: DECK_SEARCH_OPEN_KEY,
    queryFn: () => ipc.deckSearchOpen(),
    // Read once per app run. Nothing else writes this row, so there is nothing to go stale
    // against — every change to it goes through the mutation below, which writes the answer
    // straight into the cache.
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const write = useMutation({
    mutationFn: (open: boolean) => ipc.setDeckSearchOpen(open),
  });

  const startWrite = write.mutate;
  const setOpen = useCallback(
    (open: boolean) => {
      // The optimistic half. `setQueryData` before `mutate`, not in an `onMutate`: the two are
      // the same commit either way, and doing it here says outright that the cache is the
      // reader's choice and the command is only how it is remembered.
      queryClient.setQueryData(DECK_SEARCH_OPEN_KEY, open);
      startWrite(open);
    },
    [queryClient, startWrite],
  );

  const stored = query.data;
  // Narrowed on the way out for `usePrintingGroupBy`'s reason, though there is far less to
  // narrow: the command answers a `bool`, so the only value that can reach here without being
  // one is `undefined`, which is the read still in flight.
  return { open: typeof stored === "boolean" ? stored : DEFAULT_DECK_SEARCH_OPEN, setOpen };
}
