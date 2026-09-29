/**
 * The open deck's to-do list, and the one write the To-do band makes.
 *
 * ⚠️ **A to-do list is not a note.** It shares `NoteEditor` and the inline dialect with a deck
 * note and nothing else: a deck has exactly **one** list, stored as one column on its own row
 * (`decks.todos`, user schema v58), where a deck note is a row of `deck_notes`, many to a deck.
 * The spec's §2 has the table of the five things in this app that share the word.
 *
 * **The body is a string and the hook draws no conclusion from it.** What the list *says* — how
 * many to-dos are open, which line a tick flips, whether an emptied checklist is a list at all —
 * is `todoMarkdown.ts`', which is Rust-supplies-facts / TS-draws-conclusions one layer down: this
 * file owns the query key and the command, and the band owns what it does with the answer.
 *
 * **The key is `["decks", "todos", deckId]`, under the `["decks"]` root on purpose** — the
 * arrangement `useDeckNotes` and `useDeckTokens` already use, and for their reason: every deck
 * write in `useDeck` invalidates that root, and `crossWindow.ts` maps a `decks` change in another
 * window to it. So the widget ticking an item off, another window typing into the same deck's
 * band, and a sync apply all reach this query with nothing here learning about any of them. The
 * band then decides whether the answer may replace what is on screen (`DeckTodosPanel`'s
 * adoption), which is a question about the reader's caret and not about the cache.
 *
 * **No `staleTime`** — `query.ts`' 30 s is the whole budget, `useDeckNotes`' rule.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deckTodoListsKey } from "@/features/home/keys";
import { ipc, ipcError } from "@/lib/ipc";

/**
 * The band's read. A function of the deck, because the band is mounted per deck and a key naming
 * no deck would be one cache entry that every deck the reader opened overwrote.
 *
 * ⚠️ **The third segment is a number and the widget's key's is `"lists"`**, which is what keeps
 * {@link deckTodoListsKey} from prefix-matching this one: the band's autosave invalidates the
 * widget's read by name, and a key that swept this one too would re-read the body the band has
 * just written.
 */
export const deckTodosKey = (deckId: number) => ["decks", "todos", deckId] as const;

/**
 * One deck's to-do list — the body as stored, and the write that replaces it.
 *
 * **`body` is `undefined` until the read lands and stays the last good answer after that**, which
 * is TanStack's own contract and the one the band leans on: a refetch that fails keeps the data it
 * had, so an editor already open over the list is not unmounted under the reader's caret by a
 * background refusal.
 */
export function useDeckTodos(deckId: number) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: deckTodosKey(deckId),
    queryFn: () => ipc.deckTodos(deckId),
  });

  /**
   * The band's autosave — the whole list, **with no `expected`**.
   *
   * The band is the author's surface and its draft is the truth of what the reader typed, so it
   * never asks the compare-and-set question the widget asks on every tick (spec §5): a band that
   * refused its own reader's typing because the widget had ticked a line would lose a sentence to
   * save a checkmark, which is the trade the spec refuses in as many words.
   *
   * **It does not invalidate `["decks"]`, and that is deliberate twice over.** The write bumps
   * the deck's `updated_at` in Rust, so the gallery's *edited* order really is behind by one
   * write — but an autosave lands on every pause in typing, and invalidating the root on each
   * would re-read the whole deck (`deck_get`, every card, every price) once per phrase for the
   * sake of one timestamp. The gallery catches up at the next deck write of any kind, and
   * another window refreshes through the `decks` change mask regardless of what this one does.
   *
   * **`setQueryData` rather than a refetch**, because the answer is already in hand: the command
   * stores exactly the string it was given, so reading it back would be a round trip to learn
   * nothing — and a refetch that landed while the reader went on typing would be a second body
   * arriving for the band to decide whether to adopt. The widget's read *is* invalidated, by its
   * own key, because it draws every deck's list and has no other way to hear about this one.
   *
   * ⚠️ **One save at a time per deck — the `scope`.** Two pauses 600 ms apart put two saves on
   * the wire, and `deck_todos_set` waits for the database's write lock (up to five seconds,
   * `db.rs`' `WRITE_LOCK_WAIT`), which is not fair: the newer save can take it first. Disk then
   * ends on the *older* text, this `onSuccess` runs for the older one last and caches it, and the
   * band — whose observer only follows the newest mutation, so it no longer reads as saving —
   * adopts it over the reader's newer words. A shared scope makes TanStack run them in the order
   * they were made, so the last one typed is the last one written. It also keeps a queued save
   * reading as pending, which is what holds the band still while it waits.
   *
   * ⚠️ **In-flight reads of this key are cancelled before the answer is cached.** A background
   * re-read — any deck write invalidates `["decks"]` — that read the body before this write
   * committed would otherwise land *after* `setQueryData` and put the old text back, which an idle
   * band then adopts. Cancelling reverts that query to its state before the read began, and the
   * body is cached on top of the revert. **The `await` is the library's documented recipe rather
   * than today's necessity**: in `@tanstack/query-core` 5.101.4 the revert is applied
   * synchronously inside the cancel (`Query`'s `onCancel`), so an un-awaited cancel passes every
   * test here — measured, 2026-09-29. Awaiting the promise `cancelQueries` answers is what keeps the
   * order *cancel, then cache* true without depending on where a later release applies the revert.
   *
   * **Here and not in `onMutate`**, which is where the recipe usually puts it and where it misses
   * two cases. `onMutate` runs when a save is *queued* — before the scope lets it run — so every
   * read that starts while it waits behind another save, or while its own command is on the wire,
   * is still in flight at success and still stale. At success there is nothing left to wait for:
   * a read still running now may have begun before the commit, and one that has already answered
   * is overwritten by the line below.
   */
  const save = useMutation({
    mutationFn: (body: string) => ipc.deckTodosSet(deckId, body, null),
    scope: { id: `deck-todos-${deckId}` },
    onSuccess: async (_answer, body) => {
      await queryClient.cancelQueries({ queryKey: deckTodosKey(deckId) });
      queryClient.setQueryData(deckTodosKey(deckId), body);
      void queryClient.invalidateQueries({ queryKey: deckTodoListsKey });
    },
  });

  return {
    /** The stored body, `undefined` until the first read answers. `""` is a deck with no list. */
    body: query.data,
    /** The read has landed at least once and is not currently refused. */
    loaded: query.isSuccess,
    /**
     * The read's refusal in the command's own words, or `null`.
     *
     * `ipcError` rather than `String(error)`: a Tauri refusal arrives as a string and the two
     * agree on it, but a thrown `Error` would print as `"Error: …"` through `String` — a prefix the
     * reader has no use for, and the one spelling this app's other refusal lines never show.
     */
    failure: query.isError ? ipcError(query.error) : null,
    save,
  };
}
