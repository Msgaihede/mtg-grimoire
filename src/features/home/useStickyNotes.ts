/**
 * Every sticky note, and the four writes that change one.
 *
 * **One query and one invalidation, and that is the whole of the data layer.** The table is the
 * reader's own prose, small by construction, and every one of the four writes changes either what
 * is in the list or the order it is in — so there is no write whose answer a narrower key could
 * spare re-reading. `crossWindow.ts` maps `sticky_notes` to {@link stickyNotesKey}, so a note
 * written in another window comes back through this same entry; why that key is a root of its own
 * is argued in `keys.ts`.
 *
 * **The invalidation is exactly the query key, where `useDeckNotes`' is deliberately shorter than
 * its own.** That hook narrows to `["decks", "notes"]` so that a *second* reader — the card
 * modal's cross-deck `Notes` row, filed under a key naming an oracle id rather than a deck — is
 * reached by a note written in the band. There is no second reader here: `sticky_notes` is read
 * by this hook and by nothing else in the app, so a shorter key would invalidate nothing but this
 * one, under a name implying it reached further.
 *
 * **On success only**, which is `useDeckNotes`' rule for `useDeckNotes`' reason: each command is
 * a single statement against one row, so a refusal leaves the table exactly as this cache already
 * describes it and there is nothing to re-read.
 *
 * **Nothing is written into the cache ahead of a command.** A note's body is prose the reader
 * typed, so an optimistic write is one whose rollback takes their words off the screen — and each
 * of these is one round trip against local SQLite. The list re-reads when the write lands.
 *
 * **The read's failure and the writes' are two different facts, and the shape carries both.**
 * `sticky_notes` cannot be refused at the far end — a sync `fn` with no `Result` — while all
 * four writes can answer `collection::BUSY` under a running sync. So a surface words
 * {@link StickyNotesApi.writeError} when a save does not land, and {@link StickyNotesApi.isError}
 * is about the IPC boundary itself. For a feature whose editor closes on a scrim press, a write
 * that silently did not land is the failure worth being able to say out loud.
 *
 * **No `staleTime` and no `marketplace`.** `query.ts` caches 30 s app-wide, which is the whole
 * budget; a second one here could only make a missing invalidation invisible. Nothing a note
 * carries is priced.
 */
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, type StickyNote, type StickyNotePatch } from "@/lib/ipc";
import { newestWrite } from "@/lib/writes";
import { stickyNotesKey } from "./keys";
import type { NoteColor } from "./stickyNotes";

/** What {@link useStickyNotes} hands the widget and its dialog: the list, the read's two states,
 *  and the four writes. */
export interface StickyNotesApi {
  /** Every note, in the order `sticky_notes` stores them. **Never `undefined`** — a reader with
   *  no notes is the ordinary state and not an error, and so is a read that failed. */
  notes: StickyNote[];
  /** The first read is in flight. Nothing gates this query, so it is true once per window and
   *  never again — there is no `enabled: false` here to leave it pending for ever. */
  isPending: boolean;
  /**
   * The read was refused.
   *
   * **It says nothing about the four writes, and it is not the one to word on screen.**
   * `sticky_notes` is infallible by signature at the far end — a sync `fn` with no `Result`,
   * called while the window draws its first frame — so the only way this is ever true is the IPC
   * boundary itself. The writes are the half that can be refused for an ordinary reason, and
   * {@link StickyNotesApi.writeError} is where they say so.
   */
  isError: boolean;
  /** Whatever the read was refused with — `unknown`, because an IPC rejection is not typed. */
  error: unknown;
  /** True while any of the four writes is in flight. */
  isSaving: boolean;
  /**
   * The most recent write failure, or `undefined` once a later write succeeds. The read is
   * infallible by signature at the far end and the writes are the half that can answer `BUSY`
   * under a running sync, so this — not {@link StickyNotesApi.isError} — is what a caller words
   * on screen when a save does not land.
   *
   * **The newest write owns it, whatever its outcome** — `lib/writes.ts`' rule, derived through
   * its `newestWrite` rather than respelled here. Scanning the four for the first one holding an
   * error is the obvious answer and it lies: the four are separate observers, and TanStack resets
   * a mutation's own state on *its* next `mutate` and never on a sibling's — so a refused
   * `update` would keep its sentence on screen while the reader went on to write a new note
   * successfully. Ordering by `submittedAt` is what makes *once a later write succeeds* true with
   * no fifth piece of state to keep in step, and it is why nothing here clears an error in an
   * `onSuccess`.
   *
   * It is the raw rejection rather than a sentence, like {@link StickyNotesApi.error} beside it:
   * word it with `ipcError` at the surface that draws it.
   */
  writeError: unknown;
  /**
   * Write a new note. It lands last, so a reader who has arranged their board keeps that
   * arrangement. The colour is one this build knows; Rust stores whatever word it is sent.
   *
   * **`onCreated` is the new note's id, and the fourth argument is additive on purpose.**
   * `sticky_note_create` has always answered the id and this hook always threw it away, which
   * made *New note* two presses: one to make a blank tile and one to open it. It is a per-call
   * `mutate` callback rather than a fifth member of this interface or a `mutateAsync` a caller
   * awaits — TanStack runs the mutation's own `onSuccess` first, so the invalidation is already
   * away by the time a caller hears the id, and a caller that passes nothing gets exactly the
   * behaviour it had.
   *
   * ⚠️ **A `mutate`-scoped callback belongs to the *observer* and TanStack drops it when that
   * observer unmounts.** That is the right trade here and is the opposite of `createLabelFor`'s,
   * one feature over: the observer is the widget, the thing the callback does is open a dialog
   * *in* the widget, and a widget that has gone has nowhere to open one. Losing the callback with
   * it costs nothing; the note is still written.
   *
   * It fires only on success, so a refused create opens nothing and
   * {@link StickyNotesApi.writeError} is what says so.
   */
  create: (title: string, body: string, color: NoteColor, onCreated?: (id: number) => void) => void;
  /** Change a note. A field the patch leaves out is left alone; `""` really empties one. */
  update: (id: number, patch: StickyNotePatch) => void;
  /** Delete one note. */
  remove: (id: number) => void;
  /** Renumber every note in the order given. An id that is no longer a note is skipped at the far
   *  end rather than refused, so a drag survives a note deleted in another window. */
  reorder: (ids: number[]) => void;
}

export function useStickyNotes(): StickyNotesApi {
  const queryClient = useQueryClient();

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: stickyNotesKey });
  };

  const query = useQuery({ queryKey: stickyNotesKey, queryFn: () => ipc.stickyNotes() });

  const createNote = useMutation({
    mutationFn: ({ title, body, color }: { title: string; body: string; color: NoteColor }) =>
      ipc.stickyNoteCreate(title, body, color),
    onSuccess: invalidate,
  });
  const updateNote = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: StickyNotePatch }) =>
      ipc.stickyNoteUpdate(id, patch),
    onSuccess: invalidate,
  });
  const deleteNote = useMutation({
    mutationFn: (id: number) => ipc.stickyNoteDelete(id),
    onSuccess: invalidate,
  });
  const reorderNotes = useMutation({
    mutationFn: (ids: number[]) => ipc.stickyNoteReorder(ids),
    onSuccess: invalidate,
  });

  // Hoisted for `useFolderPane`'s reason, which is the house shape for a mutation reached from a
  // `useCallback`: a `useMutation`'s own `mutate` is stable across renders, and naming it once
  // is what lets the dependency arrays below say so without spelling a member expression four
  // times.
  const startCreate = createNote.mutate;
  const startUpdate = updateNote.mutate;
  const startDelete = deleteNote.mutate;
  const startReorder = reorderNotes.mutate;

  // **The four are wrapped rather than handed over raw, and they are memoised for a reason that
  // is not performance.** The wrappers exist to keep each mutation's argument *shape* out of its
  // call sites — but a wrapper rebuilt every render is a fresh `onSave` for the editor dialog,
  // whose debounced autosave names that callback in an effect's dependency array. A callback that
  // changed identity on every render would clear and restart that timer on every render, and a
  // widget that re-renders while the reader types is a draft that is never written. This does not
  // absolve a host of its own `useCallback` around whatever it closes a note's id into; it is one
  // fewer way for that timer to be starved.
  // The per-call callback is passed only when a caller supplied one, so a create made with three
  // arguments sends TanStack the same two it always did.
  const create = useCallback(
    (title: string, body: string, color: NoteColor, onCreated?: (id: number) => void) =>
      startCreate(
        { title, body, color },
        onCreated === undefined ? undefined : { onSuccess: (id) => onCreated(id) },
      ),
    [startCreate],
  );
  const update = useCallback(
    (id: number, patch: StickyNotePatch) => startUpdate({ id, patch }),
    [startUpdate],
  );
  const remove = useCallback((id: number) => startDelete(id), [startDelete]);
  const reorder = useCallback((ids: number[]) => startReorder(ids), [startReorder]);

  /**
   * The refusal the page speaks for — the most recently *started* of the four, whatever became
   * of it.
   *
   * `lib/writes.ts`' `newestWrite`, whose module doc is about exactly the bug a first-error scan
   * would reintroduce here. At mount all four sit at `submittedAt: 0` and ties go to the last
   * entry, so this answers an idle mutation and {@link StickyNotesApi.writeError} is `undefined`.
   */
  const newest = newestWrite([createNote, updateNote, deleteNote, reorderNotes]);

  return {
    // `undefined` is the read in flight *and* the read that failed, and the widget draws the same
    // thing for both: no notes. `isPending` and `isError` are what tell those two from the third
    // state they look like — an empty board, which is a real answer a reader can produce.
    notes: query.data ?? [],
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    // A plain disjunction rather than the newest write's `isPending`: this asks whether anything
    // at all is on the wire, which is what greys a control, where the refusal below asks which
    // one answer is still news.
    isSaving:
      createNote.isPending ||
      updateNote.isPending ||
      deleteNote.isPending ||
      reorderNotes.isPending,
    // `undefined` and never `null`: the interface says *or `undefined` once a later write
    // succeeds*, and TanStack spells a mutation with nothing wrong `error: null`.
    writeError: newest.isError ? newest.error : undefined,
    create,
    update,
    remove,
    reorder,
  };
}
