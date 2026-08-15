/**
 * Undo and redo for the open deck — the cursor, the session redo stack, and the two writes.
 *
 * **The two halves are stored in different places, and that is the design rather than an
 * inconsistency.** Undo is a fact about the deck: Rust stamps `deck_undo.undone_at`, so the
 * cursor persists and one press after a restart carries on below where the reader stopped —
 * "as far back as the history allows". Redo is the reader's position in a *session*: the ids
 * they have just undone, held here, thrown away with the window. A database-backed redo would
 * offer to resurrect a fortnight-old branch of edits they had forgotten making.
 *
 * The queue is a stack and **any other write to the deck clears it**, which is the ordinary
 * undo contract: once you have edited past a branch, the branch is gone.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, type DeckAuditEntry } from "@/lib/ipc";
import { auditSentence } from "./auditText";

/** What the editor draws and presses. */
export interface DeckUndo {
  /** The change Ctrl+Z would reverse, or `null`. */
  undo: DeckAuditEntry | null;
  /** The change Ctrl+Y would put back, or `null`. */
  redo: DeckAuditEntry | null;
  /** `Undo — Removed 2 × Lightning Bolt`, or the bare verb when there is nothing to do. */
  undoLabel: string;
  redoLabel: string;
  /** Press them. Both are no-ops when there is nothing at that end. */
  runUndo: () => void;
  runRedo: () => void;
  /** True while either write is in flight — the buttons grey rather than queue. */
  busy: boolean;
  /** The last refusal, or `null`. `DeckEditor` draws this in its own banner. */
  error: string | null;
  /**
   * Throw the redo stack away. Called by the editor after **any** other deck write: once the
   * reader has edited past a branch, the branch is gone.
   */
  clearRedo: () => void;
}

/** The verb alone, for a button with nothing to do. */
const VERBS = { undo: "Undo", redo: "Redo" } as const;

/**
 * The open deck's undo state.
 *
 * `deckId` may be `null` — the editor mounts this before a deck is chosen, and every field
 * then reads as "nothing to do" rather than the hook being conditional.
 */
export function useDeckUndo(deckId: number | null): DeckUndo {
  const queryClient = useQueryClient();
  /**
   * The ids this session has undone, newest last. A **ref rather than state** for the same
   * reason the editor's other imperative bookkeeping is: pushing to it must not re-render on
   * its own — the query below is what redraws the buttons — and a stale closure over an array
   * would drop a press made inside the same tick.
   */
  const undone = useRef<number[]>([]);
  /** Bumped to re-read the state query when the stack changes, since the ref cannot. */
  const [stackVersion, setStackVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const redoId = undone.current.at(-1) ?? null;

  const state = useQuery({
    // `stackVersion` is in the key so that pushing or popping the session stack re-asks —
    // the `redoId` below is read off a ref, which TanStack cannot see changing.
    queryKey: ["decks", "undo", deckId, redoId, stackVersion],
    queryFn: () => ipc.deckUndoState(deckId as number, redoId),
    enabled: deckId !== null,
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["decks"] });
  }, [queryClient]);

  const undoWrite = useMutation({
    mutationFn: (auditId: number) => ipc.deckUndoApply(deckId as number, auditId),
    onSuccess: (_, auditId) => {
      undone.current = [...undone.current, auditId];
      setStackVersion((v) => v + 1);
      setError(null);
      invalidate();
    },
    // A refusal is reported and re-reads the deck: the commonest one is "the deck has been
    // edited since", which means what is on screen is already behind.
    onError: (e: unknown) => {
      setError(String(e));
      invalidate();
    },
  });

  const redoWrite = useMutation({
    mutationFn: (auditId: number) => ipc.deckRedoApply(deckId as number, auditId),
    onSuccess: () => {
      undone.current = undone.current.slice(0, -1);
      setStackVersion((v) => v + 1);
      setError(null);
      invalidate();
    },
    onError: (e: unknown) => {
      // A redo that is refused is a redo that can never work — the change is not undone any
      // more, or the window is looking at a deck somebody else edited. Drop it rather than
      // leave a button that fails every time it is pressed.
      undone.current = undone.current.slice(0, -1);
      setStackVersion((v) => v + 1);
      setError(String(e));
      invalidate();
    },
  });

  const undo = state.data?.undo ?? null;
  const redo = state.data?.redo ?? null;
  const busy = undoWrite.isPending || redoWrite.isPending;

  const runUndo = useCallback(() => {
    if (undo !== null && !busy) undoWrite.mutate(undo.id);
  }, [undo, busy, undoWrite]);

  const runRedo = useCallback(() => {
    if (redo !== null && !busy) redoWrite.mutate(redo.id);
  }, [redo, busy, redoWrite]);

  const clearRedo = useCallback(() => {
    if (undone.current.length === 0) return;
    undone.current = [];
    setStackVersion((v) => v + 1);
  }, []);

  const undoLabel = useMemo(() => label(VERBS.undo, undo), [undo]);
  const redoLabel = useMemo(() => label(VERBS.redo, redo), [redo]);

  return { undo, redo, undoLabel, redoLabel, runUndo, runRedo, busy, error, clearRedo };
}

/**
 * `Undo — Removed 2 × Lightning Bolt`, or the bare verb.
 *
 * The sentence comes from `auditText` rather than being written here, because it is the same
 * sentence the history drawer draws and two spellings of one line is exactly what that module
 * exists to prevent. No `others` list is passed: a button never labels an undo *of* an undo,
 * since those rows record no step and can never be at the cursor.
 */
function label(verb: string, entry: DeckAuditEntry | null): string {
  if (entry === null) return verb;
  return `${verb} — ${auditSentence(entry).text}`;
}
