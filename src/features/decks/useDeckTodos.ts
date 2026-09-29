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
   */
  const save = useMutation({
    mutationFn: (body: string) => ipc.deckTodosSet(deckId, body, null),
    onSuccess: (_answer, body) => {
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
