/**
 * The notes on the open deck, and the six writes that change them.
 *
 * **A note belongs to a deck and never to a card**, which is the whole of the model this hook
 * reads: `deck_notes` holds the note and `deck_note_cards` holds the oracle ids it names, so the
 * list this answers is the complete list by construction and a note cannot become invisible by
 * acquiring a card. Every derivation over these rows — the title a blank one falls back to, the
 * markdown blocks a body draws as, the set the per-card marks read — is `deckNotes.ts`' and
 * `noteMarkdown.ts`'; this hook owns exactly the query key and the five commands.
 *
 * **No `variant`, and that is a fact about the table rather than an omission.** `deck_notes` has
 * no variant column: a note written while reading the Theory list shows on the Live list and the
 * other way round, because both lists hold the same oracle ids and a note is about the deck. A
 * variant in the key would be two cached answers to one question, refetched on a switch that
 * cannot change either of them. {@link DeckNotesPanel} still takes one — for the *card picker*,
 * which offers the cards of the list on screen — and that is the only thing the word decides here.
 *
 * **The key is `["decks", "notes", deckId]`, under the `["decks"]` root on purpose**, which is
 * `useDeckTokens`' arrangement and its reason: `useDeck`'s own `invalidate` fires that root for
 * every write to what is *in* a deck, so cutting a card the picker was offering refreshes what
 * this hook hands the picker. Nothing about a note changes when a card does — but what a reader
 * can attach one to changes constantly, and a key of this feature's own would have to be
 * invalidated from files that have no reason to know notes exist.
 *
 * **No `staleTime`.** `query.ts` caches 30 s app-wide, which is the whole budget; a second one
 * here could only make a missing invalidation invisible. **No `marketplace` either** — nothing a
 * note carries is priced.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, type DeckNote } from "@/lib/ipc";
import { sectionFailure } from "./metaRows";
import { opened } from "./useDeck";

/**
 * Stable identity for "no notes" — a deck with none, an unloaded deck and a refused read all
 * answer this.
 *
 * `query.data ?? []` is a fresh array on every render, so a consumer memoising over the list
 * would rebuild it for every keystroke anywhere in the editor. {@link useDeckTokens}' `NO_ROWS`,
 * one table over.
 */
const NO_NOTES: readonly DeckNote[] = [];

/** What {@link useDeckNotes} sends to `deck_note_update` — the two columns a note has that a
 *  reader can type into, both optional so a caller may move one and leave the other. */
export interface NotePatch {
  title?: string;
  body?: string;
}

/**
 * Every note on one deck, and the writes the band makes.
 *
 * `deckId` is nullable for {@link useDeck}'s reason: a caller with no deck open mounts an idle
 * query rather than branching around one, and `enabled` is what keeps `opened` unreachable.
 */
export function useDeckNotes(deckId: number | null) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["decks", "notes", deckId],
    queryFn: () => ipc.deckNotes(opened(deckId)),
    enabled: deckId !== null,
  });

  const notes = query.data ?? NO_NOTES;

  /**
   * Every note read in the app — **`["decks", "notes"]`, two segments and deliberately not
   * three.**
   *
   * This hook's own key carries the deck, and narrowing the invalidation to match it is the
   * obvious answer and the wrong one: the card modal's `Notes` row reads *across every deck*
   * under `["decks", "notes", "card", oracleId]`, which a three-segment key naming a deck id does
   * not prefix-match. So a note written in the band would never reach it — the modal would go on
   * answering from cache, bounded only by `query.ts`'s 30 s, and a reader who wrote a note about
   * Lightning Bolt and then opened Lightning Bolt would be told something else. Found from the
   * other side of that seam on 2026-09-10, where neither surface could see it alone.
   *
   * What the wider key costs is that writing in one deck refetches another open deck's notes.
   * That is a handful of rows out of local SQLite, which is not worth a stale answer in the one
   * surface whose whole job is to answer completely.
   *
   * **On success only.** Each command is a single statement against one row, so a refusal leaves
   * the tables exactly as this cache already describes them — there is nothing to re-read, and
   * the sentence {@link failure} draws is what says the press did not land.
   */
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["decks", "notes"] });
  };

  /**
   * A new note — **a body the reader has already written, and a title that is always empty**.
   *
   * ⚠️ This is the exact reverse of what it was, and the sentence it replaces is worth stating
   * because it reads as the natural one: *the band's add row is one field, so `body` and
   * `oracleIds` are empty here and the reader fills them in afterwards.* True of a band whose
   * add row was a title box above the list, and false of every caller since that row was deleted
   * (2026-09-20). A note is now made **by saving the editor**, so the body is the one thing
   * there always is — and `title: ""` is what both call sites send, because the list draws the
   * body's first line for a blank title and a second field asking for a heading was a second
   * thing to write before writing anything.
   *
   * `oracleIds` is empty from the header's `New note` and carries one id from the card menu's
   * `Add note…` (issue #447's other half), which is the only difference between the two doors.
   *
   * **The signature did not move and that is the trap.** It still takes all three, so a caller
   * left on the old habit compiles, writes a titled note with no body, and is caught by nothing
   * but the list drawing `Untitled note`. `deckNoteCreate`'s own argument order is pinned in
   * `ipc.test.ts`; what a *band* sends is pinned in `DeckNotesPanel.test.tsx`, which asserts the
   * empty title by name.
   */
  const create = useMutation({
    mutationFn: ({ title, body, oracleIds }: { title: string; body: string; oracleIds: string[] }) =>
      ipc.deckNoteCreate(opened(deckId), title, body, oracleIds),
    onSuccess: invalidate,
  });

  /** The title, the body, or both. A field left out of the patch is left alone. */
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: NotePatch }) =>
      ipc.deckNoteUpdate(opened(deckId), id, patch),
    onSuccess: invalidate,
  });

  /** The note and, by the cascade, every card it named. */
  const remove = useMutation({
    mutationFn: (id: number) => ipc.deckNoteDelete(opened(deckId), id),
    onSuccess: invalidate,
  });

  /** One more oracle id on the note. Attaching a card the note already names is not an error and
   *  adds no row — the grain `idx_deck_note_cards_grain` carries says so at the other end. */
  const attach = useMutation({
    mutationFn: ({ noteId, oracleId }: { noteId: number; oracleId: string }) =>
      ipc.deckNoteAttach(opened(deckId), noteId, oracleId),
    onSuccess: invalidate,
  });

  /** One fewer. The note stays in the list, which is the issue's own central sentence: a card is
   *  a pointer the note holds, never a place the note lives. */
  const detach = useMutation({
    mutationFn: ({ noteId, oracleId }: { noteId: number; oracleId: string }) =>
      ipc.deckNoteDetach(opened(deckId), noteId, oracleId),
    onSuccess: invalidate,
  });

  /**
   * The deck's notes in a new order — issue #509. `deck_note_reorder` takes **every** id and writes
   * `sort_order` from position, so the argument is the whole list rather than a from/to pair.
   *
   * **The cache is reordered before the write answers**, because a note dropped on another and
   * then drawn back where it was until a round trip lands reads as a drop that did not take. On a
   * refusal the snapshot goes back; either way the settle re-reads, so the cache ends up being what
   * the table says.
   */
  const reorder = useMutation({
    mutationFn: (ids: number[]) => ipc.deckNoteReorder(opened(deckId), ids),
    onMutate: async (ids: number[]) => {
      const key = ["decks", "notes", deckId];
      await queryClient.cancelQueries({ queryKey: key });
      const before = queryClient.getQueryData<DeckNote[]>(key);
      if (before !== undefined) {
        const byId = new Map(before.map((note) => [note.id, note]));
        const moved = ids.flatMap((id) => {
          const note = byId.get(id);
          return note === undefined ? [] : [note];
        });
        // A note the list does not name keeps its place at the end rather than vanishing — the
        // backend skips a stale id the same way, so the two agree about a reorder that raced a
        // create in another window.
        const rest = before.filter((note) => !ids.includes(note.id));
        queryClient.setQueryData<DeckNote[]>(key, [...moved, ...rest]);
      }
      return { before };
    },
    onError: (_error, _ids, context) => {
      if (context?.before !== undefined) {
        queryClient.setQueryData(["decks", "notes", deckId], context.before);
      }
    },
    onSettled: invalidate,
  });

  return {
    /** The query itself, for a caller that needs more than {@link loading} — the band reads
     *  `isSuccess` to tell "this deck has no notes" from "nothing has answered yet", which are
     *  two sentences and not one. */
    query,
    /** Every note on the deck, in `sort_order`. Never `undefined`: a deck with no notes is the
     *  ordinary state and not an error. */
    notes,
    /** The first read is in flight. **Gated on the deck as well as on the query**, because an
     *  `enabled: false` query is `pending` for ever and a gallery with no deck open must not
     *  report a spinner. */
    loading: deckId !== null && query.isPending,
    /** Any write is. The add button and both confirmation buttons grey on it. */
    pending:
      create.isPending ||
      update.isPending ||
      remove.isPending ||
      attach.isPending ||
      detach.isPending ||
      reorder.isPending,
    /**
     * The one refusal line, `sectionFailure`'s rule: the **newest write** owns it whatever its
     * outcome, and the read only speaks when no write has been refused.
     *
     * One line rather than one per control — every refusal here is either a busy database or a
     * note another surface has since deleted, and both are facts about the list rather than about
     * the button that happened to hit them.
     */
    failure: sectionFailure([create, update, remove, attach, detach, reorder], query),
    create,
    update,
    remove,
    attach,
    detach,
    reorder,
  };
}

/** The whole of what the band consumes, named so the view and the hook agree. */
export type DeckNotes = ReturnType<typeof useDeckNotes>;
