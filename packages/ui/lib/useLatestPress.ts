import { useCallback, useRef } from "react";

/**
 * **Which press of a stepper is the newest one**, per row (issue #1535).
 *
 * The quantity steppers — the collection's, the wishlist's, the deck editor's — are optimistic:
 * each press writes its guess into the cache at once, and each press is its own concurrent
 * mutation whose answer rewrites the row with the number the backend stored. Nothing ordered those
 * answers. Press `+` three times on a 6 and let press 1's answer land after press 2's guess: the
 * row is put back to 7, the box is controlled by the cache, so press 3 is computed from 7 and sends
 * 8 — a press lost, and 8 stored where the reader counted to 9.
 *
 * So each press takes a ticket ({@link press}) and **only the newest ticket for its row may write
 * its answer, or roll back a refusal** ({@link isLatest}). An older answer is not wrong — it is
 * simply superseded: a newer press of the same row is either still in flight, and its own guess is
 * what the reader is looking at, or it has already landed and written the newer number. Either
 * way the older answer has nothing left to say about the row, and the run's settle re-reads
 * everything counted from it.
 *
 * Tickets rather than a TanStack mutation `scope`: a scoped mutation does not start — so does not
 * run its `onMutate` — until the one before it has finished, which would put back exactly the
 * stale-box problem the optimistic patch is there to solve.
 *
 * `slot` is the caller's name for one row — an entry id, a deck slot's grain — and is never shared
 * between two rows.
 */
export function useLatestPress() {
  const counter = useRef(0);
  const newest = useRef(new Map<string, number>());

  /** A press of `slot` has started: its ticket, newer than every ticket handed out before it. */
  const press = useCallback((slot: string): number => {
    counter.current += 1;
    newest.current.set(slot, counter.current);
    return counter.current;
  }, []);

  /** Whether `ticket` is still the newest press of `slot` — i.e. no later press has started. */
  const isLatest = useCallback(
    (slot: string, ticket: number): boolean => newest.current.get(slot) === ticket,
    [],
  );

  /**
   * A press has finished. The newest one forgets its row, so the map holds only rows with a press
   * in flight; an older one leaves the row to the press that superseded it. An answer arriving
   * after a newer press has finished and been forgotten still reads as not the latest, because
   * no row is ever handed a ticket it had before.
   */
  const release = useCallback((slot: string, ticket: number) => {
    if (newest.current.get(slot) === ticket) newest.current.delete(slot);
  }, []);

  return { press, isLatest, release };
}
