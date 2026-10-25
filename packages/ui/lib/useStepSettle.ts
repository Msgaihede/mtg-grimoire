import { useCallback, useEffect, useRef } from "react";
import { useQueryClient, type MutationKey } from "@tanstack/react-query";

/**
 * How long a run of stepper presses has to go quiet before what they moved is re-read.
 *
 * Longer than the gap between two clicks of a reader stepping a count up by hand (~150–250ms), so
 * a run of them is one settle rather than one per press; short enough that the header, the
 * folder card and the deck's gallery tile catch up before the reader's eye has left the stepper.
 */
export const STEP_SETTLE_QUIET_MS = 300;

/**
 * A stepper write's **settle, held until the presses stop** (issue #1402).
 *
 * The collection's and the deck's quantity writes are optimistic on the number the stepper draws,
 * and what each *settles* is everything counted from it: the collection's header, folder subtotals,
 * headings, wishes and decks; the deck's whole `["decks"]` root (the detail, its tokens, notes,
 * labels, to-dos, owned-elsewhere and undo state) and the wishlist. Fired per press, that was a
 * dozen IPC reads behind every `+` and a full re-render of the page for each answer as it landed —
 * measured over the fake with 10ms of IPC latency, about nine `DeckEditor` renders and seven
 * `CollectionPage` renders per press, every one of them queued in front of the next press's own
 * paint. That queue is the lag the issue describes.
 *
 * So a press's success **schedules** the settle and the next press **holds** it: the reads go out
 * once, {@link STEP_SETTLE_QUIET_MS} after the last press of a run. A timer that fires with a press
 * of the same `mutationKey` still in flight does nothing — that press's own success arms it again —
 * because a re-read landing between two writes paints the first press's number over the second's
 * guess (the token stepper's rule, `useDeckTokens`' `quantityWrite`, made per run instead of per
 * pair). A refusal is not held: it rolls back and settles at once (`now`), through each
 * caller's own failure path.
 *
 * **A settle still owed when the caller unmounts is run then**, so leaving the page mid-run never
 * leaves a stale count behind for the 30s `staleTime` to keep.
 *
 * `mutationKey` must be held still by the caller — the callbacks are keyed on it.
 */
export function useStepSettle(mutationKey: MutationKey) {
  const queryClient = useQueryClient();
  const timer = useRef<number | null>(null);
  const owed = useRef<(() => void) | null>(null);

  /** A press has started: the run is not over, so nothing is re-read yet. */
  const hold = useCallback(() => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  /** A press has landed: re-read with `settle` once the run has been quiet long enough. */
  const schedule = useCallback(
    (settle: () => void) => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      owed.current = settle;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        if (queryClient.isMutating({ mutationKey }) > 0) return;
        owed.current = null;
        settle();
      }, STEP_SETTLE_QUIET_MS);
    },
    [queryClient, mutationKey],
  );

  /** A press was refused: whatever the run still owed is re-read now, with `settle` — the
   *  caller's failure path, which covers at least what a success would have. */
  const now = useCallback((settle: () => void) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    owed.current = null;
    settle();
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      const settle = owed.current;
      owed.current = null;
      settle?.();
    },
    [],
  );

  return { hold, schedule, now };
}
