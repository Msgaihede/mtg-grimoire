import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ipc, type DeckRow, type DraftDeckRef } from "@/lib/ipc";

/**
 * The decks a draft made and the reader has not saved yet — `app_meta` `draft_decks`
 * (`crates/grimoire-core/src/draft_deck.rs`, spec §5).
 *
 * **One key for the list, and every reader goes through it.** The deck editor asks it to decide
 * whether to draw its draft mode, and the Draft page asks it for *Draft in progress*; one query is
 * one answer, so the editor and the page can never disagree about whether a deck is still a draft.
 *
 * **Under the decks root** (issue #1467), so every deck write's own invalidation — `useDecks`'
 * `["decks"]`, another window's, a sync's — asks the list again: a draft deck deleted from the
 * gallery leaves it before the next deck is made, rather than lingering in a cache that is never
 * stale on its own.
 *
 * Exported for the stories and the tests, which seed the cache rather than mock the command, and
 * for the page, whose `draft_deck_create` adds to it.
 */
export const DRAFT_DECKS_KEY = ["decks", "draftDecks"] as const;

/** The draft decks not saved yet. Empty while the read is in flight or refused. */
const NONE: readonly DraftDeckRef[] = [];

/**
 * **Desktop only by construction rather than by a check here**: `draft_deck_ids` is on the
 * desktop's `DESKTOP_ONLY` list, so a light host refuses it in one sentence and the query answers
 * nothing — which is the right answer there, since no light host can make a draft deck. `retry:
 * false` so that refusal is said once rather than three times behind a deck editor that does not
 * care. The fake engine answers it, so stories and tests draw the editor either way.
 */
export function useDraftDecks(): readonly DraftDeckRef[] {
  const query = useQuery({
    queryKey: DRAFT_DECKS_KEY,
    queryFn: () => ipc.draftDeckIds(),
    retry: false,
    // The list moves only through the writes below, `draft_deck_create` and a deck's delete, all
    // of which invalidate the decks root, so a refetch on every window focus would be a read that
    // answers nothing new.
    staleTime: Infinity,
  });
  return query.data ?? NONE;
}

/**
 * Whether `deck` is on `list` — **its id and its `syncUid` both**, the one test of a draft deck
 * (issue #1467). Deck ids are reused after a delete (`decks.id` has no `AUTOINCREMENT`), so an id
 * alone can name an ordinary deck that took a deleted draft deck's; the uid is never reused. A
 * deck with no uid is never a draft deck: the host mints one for every draft deck it makes.
 */
export function isDraftDeckIn(
  list: readonly DraftDeckRef[],
  deck: { id: number; syncUid: string | null },
): boolean {
  const uid = deck.syncUid;
  // Truthy rather than `!== null`: an empty or absent uid names nothing, whatever the list holds.
  return !!uid && list.some((entry) => entry.id === deck.id && entry.syncUid === uid);
}

/**
 * Whether the deck the editor has open is a draft deck — on the unsaved list, **by id and uid**.
 *
 * **`row` is the deck's own row once `deck_get` answers, and the answer is the uid's from then
 * on**: an ordinary deck that took a deleted draft deck's id carries a uid of its own, so it never
 * draws the draft bar (which is drawn only with a row) and never offers a Discard of itself.
 * Before the row is in, the id alone decides, for one load: that is what keeps a fresh draft
 * deck's first frame free of the search dock (see {@link rememberDraftDeck}), and the most a stale
 * entry can cost an ordinary deck is its dock for that same beat — the list is under the decks
 * root, so the delete that left the entry stale has already asked it again.
 *
 * `false` until the list has answered, which is the safe direction for a deck the reader opened
 * from the gallery (every ordinary deck).
 */
export function useIsDraftDeck(
  deckId: number,
  row: { id: number; syncUid: string | null } | null,
): boolean {
  const list = useDraftDecks();
  if (row !== null && row.id === deckId) return isDraftDeckIn(list, row);
  return list.some((entry) => entry.id === deckId);
}

/**
 * Put a deck `draft_deck_create` just made on the cached list, **before** the editor is opened on
 * it — so its first frame is already in draft mode rather than drawing the search dock until
 * `draft_deck_ids` answers. The list is invalidated as well, so the host's own answer replaces
 * this one. A row with no uid is not put on it ({@link isDraftDeckIn}); the host's answer decides.
 */
export function rememberDraftDeck(queryClient: QueryClient, row: DeckRow): void {
  const syncUid = row.syncUid;
  if (syncUid) {
    const entry: DraftDeckRef = { id: row.id, syncUid };
    queryClient.setQueryData<DraftDeckRef[]>([...DRAFT_DECKS_KEY], (list) => [
      // An entry under the same id is a stale one — a deleted draft deck's — and goes.
      ...(list ?? []).filter((e) => e.id !== row.id),
      entry,
    ]);
  }
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
