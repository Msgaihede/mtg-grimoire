import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ipc, type DeckRow } from "@/lib/ipc";

/**
 * The decks a draft made and the reader has not saved yet — every deck whose row says `draft`
 * (`decks.draft`, user schema v69; `crates/grimoire-core/src/draft_deck.rs`, spec §5).
 *
 * **The row's `draft` flag is the only truth about a draft deck.** This list is that flag read
 * across every deck (`draft_deck_list`), and the editor reads the same flag off the one deck it
 * has open (`DeckRow.draft`, from `deck_get`) — two reads of one column, so the page and the
 * editor can never disagree. There is no list kept beside the decks any more (issue #1467's
 * `app_meta` `draft_decks` was retired at v69), and so no reused id to mistake for a draft.
 *
 * **Under the decks root**, so every deck write's own invalidation — `useDecks`' `["decks"]`,
 * another window's, a sync's — asks the list again: a draft deck saved or discarded leaves it
 * without a write here having to know.
 *
 * Exported for the stories and the tests, which seed the cache rather than mock the command.
 */
export const DRAFT_DECKS_KEY = ["decks", "draftDecks"] as const;

/** No draft decks. Also the answer while the read is in flight or refused. */
const NONE: readonly DeckRow[] = [];

/**
 * The draft decks not saved yet, oldest first, as whole rows (name, card count) — what Draft &
 * Packs' *Draft in progress* lists. `deck_list` never answers these, so the Decks gallery and
 * every picker leave them out with no filter of their own.
 *
 * **Desktop only by construction rather than by a check here**: `draft_deck_list` is on the
 * desktop's `DESKTOP_ONLY` list, so a light host refuses it in one sentence and the query answers
 * nothing — which is the right answer there, since no light host can make a draft deck. `retry:
 * false` so that refusal is said once rather than three times. The fake engine answers it, so
 * stories and tests draw the page either way.
 */
export function useDraftDecks(): readonly DeckRow[] {
  const query = useQuery({
    queryKey: DRAFT_DECKS_KEY,
    queryFn: () => ipc.draftDeckList(),
    retry: false,
    // The list moves only through deck writes — `draft_deck_create`, Save, Discard, a delete —
    // all of which invalidate the decks root, so a refetch on every window focus would be a read
    // that answers nothing new.
    staleTime: Infinity,
  });
  return query.data ?? NONE;
}

/**
 * The decks queries a keep or a discard moves — the whole `["decks"]` root, `useDecks`' own
 * invalidation, which holds {@link DRAFT_DECKS_KEY} too. A kept deck is a deck like any other (the
 * gallery's tile, its folder, its row's `draft` now `false`); a discarded one is gone from every
 * list.
 */
function settle(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: ["decks"] });
}

/**
 * **Save deck** — the deck's `draft` flag is cleared and it is a deck like any other from then
 * on: in the gallery, and sent to the reader's other devices as if newly made. The toast and the
 * move to the Decks view are the call site's (`packages/ui/CLAUDE.md`'s rule: never in a shared
 * hook).
 */
export function useKeepDraftDeck() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deckId: number) => ipc.draftDeckKeep(deckId),
    onSettled: () => settle(queryClient),
  });
}

/**
 * **Discard** — the deck is deleted, its pool with it, having never left the device. The deck's
 * own detail reads are dropped rather than refetched, `useDeckCore`'s delete arrangement: a
 * refetch of a deck that no longer exists would be a read that can only be refused.
 */
export function useDiscardDraftDeck() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deckId: number) => ipc.draftDeckDiscard(deckId),
    onSuccess: (_answer, deckId) => {
      queryClient.removeQueries({ queryKey: ["decks", "detail", deckId], type: "inactive" });
    },
    onSettled: () => settle(queryClient),
  });
}
