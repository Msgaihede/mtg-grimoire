/**
 * Which of several writes a screen speaks for — and which refusal is still news.
 *
 * A surface usually owns more than one mutation (a rename, a delete, a reorder), and it draws
 * **one** banner. Picking the first that happens to be holding an error is the obvious answer
 * and the wrong one: a refused move then leaves its sentence up while the reader goes on to
 * rename the deck successfully, so the screen reports a fault that has been dealt with and
 * says nothing about the write that just worked. That is the collection table's lesson, and
 * the editor, the gallery, the settings dialog and the categories drawer had each written the
 * same three lines out to apply it — one of them, the drawer, in the opposite direction.
 *
 * The rule is **the most recently started write owns the banner**, whatever its outcome.
 */
import { ipcError } from "./ipc";

/** What this needs of a TanStack mutation: when it was last fired, and how it went. */
export interface Write {
  /** `MutationObserverResult.submittedAt` — 0 until the mutation has ever run. */
  submittedAt: number;
  isError: boolean;
  error: unknown;
  /** Settled, and settled well. Read by the deck editor to throw its redo stack away: once the
   *  reader has edited past a branch the branch is gone, and a *refused* write has not edited
   *  past anything — which is why this is not `!isError`, a value that is also true while a
   *  write is still in flight. */
  isSuccess: boolean;
}

/**
 * The most recently *started* of a set of writes.
 *
 * Ties go to the later entry, which only happens when none of them has ever run — and then
 * every candidate is idle, so which one is returned cannot be seen.
 *
 * **Deliberately not generic**, though the reduce would be: a caller's list is a handful of
 * `useMutation` results with *different* argument and answer types, and a generic would pin
 * `T` to whichever came first and refuse the rest. {@link Write} is all this reads, and every
 * mutation result is one. The non-empty tuple is what makes the reduce total.
 */
export function newestWrite(writes: readonly [Write, ...Write[]]): Write {
  return writes.reduce((a, b) => (b.submittedAt >= a.submittedAt ? b : a));
}

/** {@link newestWrite}'s refusal as a sentence, or `null` when the newest write is not one. */
export function writeFailure(writes: readonly [Write, ...Write[]]): string | null {
  const last = newestWrite(writes);
  return last.isError ? ipcError(last.error) : null;
}
