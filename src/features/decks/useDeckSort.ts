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
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { DEFAULT_DECK_SORT, formatDeckSort, parseDeckSort, type DeckSort } from "./deckSort";

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
 * The read is `staleTime: Infinity` because nothing else on earth writes this row — it changes
 * only when this hook writes it — so there is nothing for the cache to go stale against and no
 * refetch that could ever answer differently. What the cache *cannot* do is answer instantly: a
 * press that waited for `set_deck_sort` and then a re-read would leave the wall in the old order
 * for a round trip, and a sort control that answers late reads as a control that did not take.
 * So the press is the truth for the rest of the session and the row is only how it is
 * remembered.
 *
 * That also settles the race the other way round: a launch read that lands *after* an early
 * press does not undo it, because the override wins whatever the query eventually says.
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
  const [pressed, setPressed] = useState<DeckSort | null>(null);

  const query = useQuery({
    queryKey: ["decks", "sort"],
    queryFn: () => ipc.deckSort(),
    staleTime: Infinity,
  });

  const setSort = useCallback((next: DeckSort) => {
    setPressed(next);
    void ipc.setDeckSort(formatDeckSort(next)).catch(() => {});
  }, []);

  // `undefined` is the read in flight *and* the read that failed, and the gallery draws the same
  // thing for both: today's order. `parseDeckSort` handles everything else, including the word a
  // future build stops offering — see its own contract, which is `asSortBy`'s.
  const stored = query.data === undefined ? DEFAULT_DECK_SORT : parseDeckSort(query.data);

  return { sort: pressed ?? stored, setSort };
}
