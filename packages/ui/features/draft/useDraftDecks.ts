import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";

/**
 * The decks a draft made and the reader has not saved yet — `app_meta` `draft_decks`
 * (`crates/grimoire-core/src/draft_deck.rs`, spec §5).
 *
 * **One key for the list, and every reader goes through it.** The deck editor asks it to decide
 * whether to draw its draft mode, and the Draft page asks it for *Draft in progress*; one query is
 * one answer, so the editor and the page can never disagree about whether a deck is still a draft.
 *
 * Exported for the stories and the tests, which seed the cache rather than mock the command, and
 * for the page, whose `draft_deck_create` adds to it.
 */
export const DRAFT_DECKS_KEY = ["draftDecks"] as const;

/** The draft decks not saved yet, by id. Empty while the read is in flight or refused. */
const NONE: readonly number[] = [];

/**
 * **Desktop only by construction rather than by a check here**: `draft_deck_ids` is on the
 * desktop's `DESKTOP_ONLY` list, so a light host refuses it in one sentence and the query answers
 * nothing — which is the right answer there, since no light host can make a draft deck. `retry:
 * false` so that refusal is said once rather than three times behind a deck editor that does not
 * care. The fake engine answers it, so stories and tests draw the editor either way.
 */
export function useDraftDeckIds(): readonly number[] {
  const query = useQuery({
    queryKey: DRAFT_DECKS_KEY,
    queryFn: () => ipc.draftDeckIds(),
    retry: false,
    // The list moves only through the writes below and `draft_deck_create`, all of which
    // invalidate it, so a refetch on every window focus would be a read that answers nothing new.
    staleTime: Infinity,
  });
  return query.data ?? NONE;
}

/**
 * Whether this deck is a draft deck — on the unsaved list.
 *
 * **`false` until the list has answered**, which is the safe direction for a deck the reader
 * opened from the gallery (every ordinary deck) and would cost a fresh draft deck its search dock
 * for the length of one read — so the page that made it calls {@link rememberDraftDeck} before it
 * opens the editor, and the answer is in the cache when the editor mounts.
 */
export function useIsDraftDeck(deckId: number): boolean {
  return useDraftDeckIds().includes(deckId);
}

/**
 * Put a deck `draft_deck_create` just made on the cached list, **before** the editor is opened on
 * it — so its first frame is already in draft mode rather than drawing the search dock until
 * `draft_deck_ids` answers. The list is invalidated as well, so the host's own answer replaces
 * this one.
 */
export function rememberDraftDeck(queryClient: QueryClient, deckId: number): void {
  queryClient.setQueryData<number[]>([...DRAFT_DECKS_KEY], (ids) =>
    ids === undefined ? [deckId] : ids.includes(deckId) ? ids : [...ids, deckId],
  );
  void queryClient.invalidateQueries({ queryKey: DRAFT_DECKS_KEY });
}

/**
 * The decks queries a keep or a discard moves — the whole `["decks"]` root, `useDecks`' own
 * invalidation. A kept deck is a deck like any other (the gallery's tile, its folder); a discarded
 * one is gone from every list.
 */
function settle(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: DRAFT_DECKS_KEY });
  void queryClient.invalidateQueries({ queryKey: ["decks"] });
}

/**
 * **Save deck** — the deck leaves the unsaved list and is a deck like any other from then on. The
 * toast is the call site's (`packages/ui/CLAUDE.md`'s rule: never in a shared hook).
 */
export function useKeepDraftDeck() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deckId: number) => ipc.draftDeckKeep(deckId),
    onSettled: () => settle(queryClient),
  });
}

/**
 * **Discard** — the deck is deleted, its pool with it. The deck's own detail reads are dropped
 * rather than refetched, `useDeckCore`'s delete arrangement: a refetch of a deck that no longer
 * exists would be a read that can only be refused.
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
