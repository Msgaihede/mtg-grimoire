/**
 * The open deck's to-do lists, and the writes the To-do band and its dialog make.
 *
 * ⚠️ **A to-do list is not a note.** It shares `NoteEditor`, the inline dialect and — since issue
 * #688 — a card's *look* with a deck note, and nothing else: no attached cards, no masonry drag,
 * no Save button, no row in `deck_notes`. The root `CLAUDE.md` names the five things in this app
 * that share the word, and a to-do list now having a title and a body is what makes that warning
 * sharper rather than weaker.
 *
 * **What #672 said, and what replaced it.** #672 (user schema v58) kept exactly **one** checklist
 * per deck, as one column on the deck's own row (`decks.todos`), read and written whole through
 * `deck_todos` / `deck_todos_set`; this file exported `useDeckTodos`, whose answer was a single
 * string. User schema v59 turned that column into a table, `deck_todo_lists`, many titled lists
 * to a deck — every non-empty column converted into one list titled `To-do` — so a deck's answer
 * is now an array of rows, a list is addressed by its own `id`, and the one band write became two:
 * the dialog's autosave ({@link useTodoListSave}) and the card's tick ({@link useDeckTodoLists}'
 * `tick`). A *to-do* is still one line of a body and not a row anywhere.
 *
 * **The bodies are strings and the hooks draw no conclusion from them.** What a list *says* — how
 * many to-dos are open, which line a tick flips, whether a list is blank — is `todoMarkdown.ts`',
 * which is Rust-supplies-facts / TS-draws-conclusions one layer down: this file owns the query key
 * and the commands, and the band and the dialog own what they do with the answers.
 *
 * **The key is `["decks", "todos", deckId]`, under the `["decks"]` root on purpose** — the
 * arrangement `useDeckNotes` and `useDeckTokens` already use, and for their reason: every deck
 * write in `useDeck` invalidates that root, and `crossWindow.ts` maps a `decks` or
 * `deck_todo_lists` change in another window to it. So the widget ticking an item off, another
 * window typing into the same list's dialog, and a sync apply all reach this query with nothing
 * here learning about any of them. The dialog then decides whether the answer may replace what is
 * on screen (its adoption), which is a question about the reader's caret and not about the cache.
 *
 * **No `staleTime`** — `query.ts`' 30 s is the whole budget, `useDeckNotes`' rule.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { deckTodoListsKey } from "@/features/home/keys";
import { ipc, ipcError, type DeckTodoList } from "@/lib/ipc";

/**
 * The band's read. A function of the deck, because the band is mounted per deck and a key naming
 * no deck would be one cache entry that every deck the reader opened overwrote.
 *
 * ⚠️ **The third segment is a number and the widget's key's is `"lists"`**, which is what keeps
 * {@link deckTodoListsKey} from prefix-matching this one: a save invalidates the widget's read by
 * name, and a key that swept this one too would re-read the lists the dialog has just written.
 */
export const deckTodosKey = (deckId: number) => ["decks", "todos", deckId] as const;

/**
 * Rewrite the cached lists of one deck **only where there are some**. An entry nobody has read is
 * left `undefined` — returning `undefined` from the updater is TanStack's "leave it" — because a
 * list written into an empty entry would be the whole answer as far as the next reader knew, and
 * every other list the deck has would vanish until a refetch.
 */
function patchLists(
  queryClient: QueryClient,
  deckId: number,
  change: (lists: DeckTodoList[]) => DeckTodoList[],
) {
  queryClient.setQueryData<DeckTodoList[]>(deckTodosKey(deckId), (lists) =>
    lists === undefined ? undefined : change(lists),
  );
}

/** The variables of {@link useTodoListSave}'s mutation. */
export interface TodoListSave {
  /** The list's id **as the caller knew it when it queued the save** — `null` for a list the
   *  dialog opened unsaved. Read only as a fallback: {@link idRef} is what decides. */
  id: number | null;
  title: string;
  body: string;
  /**
   * The dialog's own record of which list it is editing, **read when the save runs, not when it
   * was queued**. A new list has no id until its first save answers, and a second save queued
   * behind that create (the scope runs them one at a time) must update the list the create made
   * rather than make a second one — which it can only do by reading a box the create has written
   * into by then. The create writes the id it was answered into `idRef.current`.
   */
  idRef: { current: number | null };
}

/**
 * One deck's to-do lists — the rows as stored, the tick a card makes and the delete.
 *
 * **`lists` is `undefined` until the read lands and stays the last good answer after that**,
 * which is TanStack's own contract and the one the band leans on: a refetch that fails keeps the
 * data it had, so a dialog already open over a list is not unmounted under the reader's caret by
 * a background refusal.
 */
export function useDeckTodoLists(deckId: number): {
  lists: DeckTodoList[] | undefined;
  failure: string | null;
  tick: UseMutationResult<void, unknown, { id: number; body: string; expected: string }>;
  remove: UseMutationResult<void, unknown, number>;
} {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: deckTodosKey(deckId),
    queryFn: () => ipc.deckTodoLists(deckId),
  });

  /**
   * A box ticked on a card — the whole new body, **with the body it read as `expected`**.
   *
   * The card is not the author's surface, so it asks the compare-and-set question the widget has
   * asked since #672: a list that moved since the card drew it — its dialog autosaving in another
   * window, a sync apply — is refused with `TODOS_CHANGED` rather than having line *n* of a
   * different body flipped. The refusal **invalidates this key**, so the band re-reads and the
   * reader ticks against what is really there.
   *
   * **The title travels as `null`** — *leave it* — because a tick is about one line of the body
   * and a title the card held could itself be stale.
   *
   * A success cancels in-flight reads of this key before caching, for {@link useTodoListSave}'s
   * reason, and invalidates the widget's read by name, which draws the same list's count.
   */
  const tick = useMutation({
    mutationFn: ({ id, body, expected }: { id: number; body: string; expected: string }) =>
      ipc.deckTodoListUpdate(deckId, id, { body, expected }),
    onSuccess: async (_answer, { id, body }) => {
      await queryClient.cancelQueries({ queryKey: deckTodosKey(deckId) });
      patchLists(queryClient, deckId, (lists) =>
        lists.map((list) => (list.id === id ? { ...list, body } : list)),
      );
      void queryClient.invalidateQueries({ queryKey: deckTodoListsKey });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: deckTodosKey(deckId) });
    },
  });

  /**
   * Delete one list. Idempotent in Rust, so a list another window deleted first is a success
   * here too. The row leaves the cache on success rather than by a refetch — the answer is
   * already in hand — and the widget's read is invalidated by name.
   */
  const remove = useMutation({
    mutationFn: (id: number) => ipc.deckTodoListDelete(deckId, id),
    onSuccess: async (_answer, id) => {
      await queryClient.cancelQueries({ queryKey: deckTodosKey(deckId) });
      patchLists(queryClient, deckId, (lists) => lists.filter((list) => list.id !== id));
      void queryClient.invalidateQueries({ queryKey: deckTodoListsKey });
    },
  });

  return {
    lists: query.data,
    /**
     * The read's refusal in the command's own words, or `null`.
     *
     * `ipcError` rather than `String(error)`: a Tauri refusal arrives as a string and the two
     * agree on it, but a thrown `Error` would print as `"Error: …"` through `String` — a prefix the
     * reader has no use for, and the one spelling this app's other refusal lines never show.
     */
    failure: query.isError ? ipcError(query.error) : null,
    tick,
    remove,
  };
}

/**
 * The dialog's autosave — title and body together, **with no `expected`**, and the create that a
 * **New to-do list** dialog's first real change is.
 *
 * The dialog is the author's surface and its draft is the truth of what the reader typed, so it
 * never asks the compare-and-set question a tick asks: a dialog that refused its own reader's
 * typing because a card had ticked a line would lose a sentence to save a checkmark, which #672's
 * spec refuses in as many words. **It moved here from the band intact** — #672's band autosaved
 * the one list; the dialog autosaves whichever list it is open on.
 *
 * **`idRef` decides create or update, read when the save runs.** A list opened from New to-do list
 * has no id until its first save, which is the create; the create writes the answered id into
 * `idRef.current`, so a save queued behind it updates that list rather than making another.
 * `variables.id` is the fallback for a box nobody seeded, never the authority.
 *
 * **It does not invalidate `["decks"]` itself, and that is deliberate twice over.** The write
 * bumps the deck's `updated_at` in Rust, so the gallery's *edited* order really is behind by one
 * write — but an autosave lands on every pause in typing, and invalidating the root on each would
 * re-read the whole deck (`deck_get`, every card, every price) once per phrase for the sake of one
 * timestamp. The gallery catches up at the next deck write of any kind.
 *
 * ⚠️ **That saving holds in a single window only.** With two or more windows open, the commit
 * emits `db:changed` naming `deck_todo_lists` and `decks` (`changes.rs`), and **the writing window
 * hears its own event too**: `crossWindow.ts`' `refreshForTables` maps both to `["decks"]`, so
 * every window — this one included — re-reads the deck once per autosave. Nothing here can opt
 * out of that, and the dialog's adoption is what keeps the re-read of its own key from moving the
 * editor.
 *
 * **`setQueryData` rather than a refetch**, because the answer is already in hand: the command
 * stores exactly the strings it was given, so reading them back would be a round trip to learn
 * nothing — and a refetch that landed while the reader went on typing would be a second body
 * arriving for the dialog to decide whether to adopt. A create's row is **appended** (or replaces
 * a row of its id that a read already brought in); an update's title and body **replace** the
 * row's, and an update to a row the cache does not hold re-reads instead. The widget's read *is*
 * invalidated, by its own key, because it draws every deck's lists and has no other way to hear
 * about this one.
 *
 * ⚠️ **One save at a time per dialog — the `scope`.** Two pauses 600 ms apart put two saves on the
 * wire, and `deck_todo_list_update` waits for the database's write lock (up to five seconds,
 * `db.rs`' `WRITE_LOCK_WAIT`), which is not fair: the newer save can take it first. Disk then ends
 * on the *older* text, this `onSuccess` runs for the older one last and caches it, and the dialog —
 * whose observer only follows the newest mutation, so it no longer reads as saving — adopts it over
 * the reader's newer words. A shared scope makes TanStack run them in the order they were made, so
 * the last one typed is the last one written, **and it is what lets the create hand its id to the
 * update behind it**. It also keeps a queued save reading as pending, which is what holds the
 * dialog still while it waits. The caller passes `todo-list-dialog-${instance}`: per dialog
 * instance, because two dialogs are two lists.
 *
 * ⚠️ **In-flight reads of this key are cancelled before the answer is cached.** A background
 * re-read — any deck write invalidates `["decks"]` — that read the lists before this write
 * committed would otherwise land *after* `setQueryData` and put the old text back, which an idle
 * dialog then adopts. Cancelling reverts that query to its state before the read began, and the
 * answer is cached on top of the revert. **The `await` is the library's documented recipe rather
 * than today's necessity**: in `@tanstack/query-core` 5.101.4 the revert is applied synchronously
 * inside the cancel (`Query`'s `onCancel`), so an un-awaited cancel passes every test here —
 * measured, 2026-09-29. Awaiting the promise `cancelQueries` answers is what keeps the order
 * *cancel, then cache* true without depending on where a later release applies the revert.
 *
 * **Here and not in `onMutate`** (#672's finding, kept), which is where the recipe usually puts it
 * and where it misses two cases. `onMutate` runs when a save is *queued* — before the scope lets it
 * run — so every read that starts while it waits behind another save, or while its own command is
 * on the wire, is still in flight at success and still stale. At success there is nothing left to
 * wait for: a read still running now may have begun before the commit, and one that has already
 * answered is overwritten by the line below.
 */
export function useTodoListSave(
  deckId: number,
  scopeId: string,
): UseMutationResult<DeckTodoList | void, unknown, TodoListSave> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, title, body, idRef }: TodoListSave): Promise<DeckTodoList | void> => {
      const target = idRef.current ?? id;
      if (target === null) {
        const made = await ipc.deckTodoListCreate(deckId, title, body);
        idRef.current = made.id;
        return made;
      }
      idRef.current = target;
      await ipc.deckTodoListUpdate(deckId, target, { title, body, expected: null });
    },
    scope: { id: scopeId },
    onSuccess: async (answer, { title, body, idRef }) => {
      await queryClient.cancelQueries({ queryKey: deckTodosKey(deckId) });
      if (answer) {
        patchLists(queryClient, deckId, (lists) =>
          lists.some((list) => list.id === answer.id)
            ? lists.map((list) => (list.id === answer.id ? answer : list))
            : [...lists, answer],
        );
      } else {
        const id = idRef.current;
        const cached = queryClient.getQueryData<DeckTodoList[]>(deckTodosKey(deckId));
        if (cached?.some((list) => list.id === id)) {
          patchLists(queryClient, deckId, (lists) =>
            lists.map((list) => (list.id === id ? { ...list, title, body } : list)),
          );
        } else {
          void queryClient.invalidateQueries({ queryKey: deckTodosKey(deckId) });
        }
      }
      void queryClient.invalidateQueries({ queryKey: deckTodoListsKey });
    },
  });
}
