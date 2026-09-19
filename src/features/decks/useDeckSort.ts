/**
 * The order the gallery is in, remembered across restarts.
 *
 * One `app_meta` row holding `"<key>:<direction>"`, read once at launch and written on every
 * press — `src-tauri/src/listview.rs`'s arrangement, which is the app's pattern for a single
 * remembered preference. **Only the sort is remembered**, and the filter row deliberately is
 * not: a filter is a thing a reader is doing right now, and a gallery that opened already
 * narrowed, with no memory of having asked for it, is a gallery that looks like it has lost
 * decks.
 */
import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { DEFAULT_DECK_SORT, formatDeckSort, parseDeckSort, type DeckSort } from "./deckSort";

/**
 * The cache entry the gallery's order lives in — **deliberately not under `["decks"]`.**
 *
 * It sat at `["decks", "sort"]` from the day it landed, and nothing depended on the prefix: a data
 * reset leaves the `deck_sort` row alone, and no invalidation anywhere names the key. What the
 * prefix did do was get the row re-read by every deck write the window made — harmless with one
 * window, where the row only ever held this window's own press, and wrong with two, where it holds
 * whichever window pressed last (spec §2 decision 4: the order is a view preference, per window).
 * `crossWindow.ts`' `PER_WINDOW_KEYS` names this constant and its test fails any per-window key a
 * table's write can reach.
 */
export const DECK_SORT_KEY = ["deckSort"] as const;

/**
 * The reader's order, and the one way to change it.
 *
 * **Call this once.** `DecksPage` is that caller, and the rule is `useListViewPersistence`'s for
 * a version of its reason: the press is held in local state, so a second mount would be a second
 * copy that never hears about the first one's press and goes on drawing the stored order until
 * something remounts it. There is exactly one sort control on exactly one page, so the
 * arrangement costs nothing and the constraint is worth stating rather than discovering.
 *
 * ## Why a local override rather than the query's own answer
 *
 * The read is `staleTime: Infinity` and `gcTime: Infinity` because **the row is read once, at
 * launch, and after that this window's own presses are the only thing that may move its order.**
 * Another window writes the same row, and its press is that window's order rather than this
 * one's; so nothing here re-reads it — not a deck write, not a refresh from another window, and
 * not a gallery coming back after five minutes away, which is what the default `gcTime` would
 * have done. What the cache *cannot* do is answer instantly: a press that waited for
 * `set_deck_sort` and then a re-read would leave the wall in the old order for a round trip, and a
 * sort control that answers late reads as a control that did not take. So the press is the truth
 * for the rest of the session and the row is only how it is remembered.
 *
 * That also settles the race the other way round: a launch read that lands *after* an early
 * press does not undo it, because the override wins whatever the query eventually says.
 *
 * **The press also writes the cache**, because the override does not outlive the gallery: opening
 * a deck unmounts it, and a gallery that came back to the launch read put the wall back in the
 * order the reader had just changed.
 *
 * ## What it does about failure, which is nothing
 *
 * `useListViewPersistence`'s contract, held here for its reasons word for word. A read that
 * fails leaves the gallery on {@link DEFAULT_DECK_SORT}, which is today's order and a complete,
 * drawable page. A write that fails — `set_deck_sort` answers `BUSY` while a sync holds the
 * write connection, which a first run spends whole minutes in — costs the reader nothing this
 * session and only the next launch's opening order. And outside a Tauri window (a plain
 * `vite dev`, a story with no fake registered) there is no command to call at all: losing a
 * stored order is not worth taking the app down for.
 *
 * So the write is fired and forgotten, its rejection swallowed at the call rather than left to
 * reach an unhandled-rejection boundary, and there is no retry — the next press schedules
 * another write anyway.
 */
export function useDeckSort(): { sort: DeckSort; setSort: (next: DeckSort) => void } {
  const queryClient = useQueryClient();
  const [pressed, setPressed] = useState<DeckSort | null>(null);

  const query = useQuery({
    queryKey: DECK_SORT_KEY,
    queryFn: () => ipc.deckSort(),
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const setSort = useCallback(
    (next: DeckSort) => {
      setPressed(next);
      const stored = formatDeckSort(next);
      queryClient.setQueryData<string>(DECK_SORT_KEY, stored);
      void ipc.setDeckSort(stored).catch(() => {});
    },
    [queryClient],
  );

  // `undefined` is the read in flight *and* the read that failed, and the gallery draws the same
  // thing for both: today's order. `parseDeckSort` handles everything else, including the word a
  // future build stops offering — see its own contract, which is `asSortBy`'s.
  const stored = query.data === undefined ? DEFAULT_DECK_SORT : parseDeckSort(query.data);

  return { sort: pressed ?? stored, setSort };
}
