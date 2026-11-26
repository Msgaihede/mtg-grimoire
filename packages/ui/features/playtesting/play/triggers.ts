/**
 * The reader's triggers put in order by hand — the prompt's `triggers`, asked when the engine
 * lists only some orders (five triggers or more: as they are, or reversed). The panel lists them
 * in the order they resolve, the first to resolve on top; the engine's `order` is the order they
 * are put on the stack, so the last to resolve is put on first (CR 405.3).
 */
import type { PlaytestAction } from "@/lib/ipc";

/** Where the panel starts: the engine's own order, as they would resolve (the last put on
 *  resolves first). */
export function startResolving(count: number): number[] {
  return Array.from({ length: count }, (_, i) => count - 1 - i);
}

/** The trigger at `at` moved by `delta` places (−1 up, toward resolving first). */
export function moveTrigger(resolving: readonly number[], at: number, delta: number): number[] {
  const to = at + delta;
  if (at < 0 || at >= resolving.length || to < 0 || to >= resolving.length) return [...resolving];
  const next = [...resolving];
  [next[at], next[to]] = [next[to], next[at]];
  return next;
}

/** The answer: the order they are put on the stack, the reverse of the order they resolve. */
export function orderAction(resolving: readonly number[]): PlaytestAction {
  return { type: "orderTriggers", order: [...resolving].reverse() };
}
