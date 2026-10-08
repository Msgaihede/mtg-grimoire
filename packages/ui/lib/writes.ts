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

/**
 * A batch of writes fired together — a multi-card drop, or Delete over a picked set — as the
 * one {@link Write} the banner reads (issue #553).
 *
 * **Why a batch needs a record of its own.** Every card in the batch is a separate call on the
 * *same* `useMutation` observer, and an observer's state is its newest call's. So the banner,
 * which reads that state, could only ever say how the **last** card went: drop four cards on the
 * remove tray, have the second one refused, and the fourth's success was all the screen had to
 * report — the second row rolled back with no sentence anywhere. The batch's own promises still
 * know every outcome, and this is where they are gathered.
 *
 * **Which moment it is stamped with depends on how it went, and the refusal's is the one that
 * matters.** TanStack stamps a call's `submittedAt` only after the mutation's `onMutate` has been
 * awaited, so a stamp taken as the batch is fired is *older* than its own members — and a
 * refusal stamped that way loses the banner to the last card's success, which is the bug this
 * exists to fix, reproduced. So a batch that was refused anywhere is stamped `settledAt`: the
 * refusal is news when it arrives, and a write the reader makes after it is newer again and
 * takes the banner back. A batch that went through everywhere keeps `firedAt` instead, so that a
 * write refused *while the batch was out* is not wiped by a success that has nothing to say.
 */
export function batchWrite(
  results: readonly PromiseSettledResult<unknown>[],
  firedAt: number,
  settledAt: number,
): Write {
  const refusals = results.flatMap((r) => (r.status === "rejected" ? [ipcError(r.reason)] : []));
  if (refusals.length === 0) {
    return { submittedAt: firedAt, isError: false, error: null, isSuccess: true };
  }
  // Said once however many cards it refused — four copies of "The deck was deleted." is one fact
  // read four times — and in the order the cards were pressed.
  const said = [...new Set(refusals)].join(" ");
  const of = `${refusals.length} of ${results.length}`;
  const error =
    refusals.length === results.length
      ? said
      : `${of} cards ${refusals.length === 1 ? "wasn't" : "weren't"} changed — ${said}`;
  return { submittedAt: settledAt, isError: true, error, isSuccess: false };
}

/** The record before any batch has run: never submitted, so every real write is newer. */
export const NO_BATCH: Write = { submittedAt: 0, isError: false, error: null, isSuccess: false };

/**
 * A write's promise, handed back **with a handler already attached** — so a caller that ignores
 * the answer leaves no unhandled rejection, and a caller that awaits it still sees the refusal.
 *
 * The attached `catch` is on a *branch* of the promise, not in its chain: the promise returned is
 * the one passed in, still rejecting. What the branch buys is only that the runtime has seen a
 * handler, which is the whole of what "unhandled" means. The refusal is not lost by being
 * swallowed here — `mutateAsync` has already recorded it on the observer, where the banner reads
 * it exactly as it read a `mutate`'s.
 */
export function handled<T>(press: Promise<T>): Promise<T> {
  press.catch(() => {});
  return press;
}
