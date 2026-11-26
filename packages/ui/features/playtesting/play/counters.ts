/**
 * Counters taken off a card as the reader chooses — the engine's `RemoveCountersChoice` and
 * `MoveCountersDistribution`, the prompt's `counters` (Rhys the Evermore, Tetravus; CR 107.1c,
 * 122.5): so many of each kind removed, or moved onto each destination. None at all is always an
 * answer, so the panel can always send what it shows.
 *
 * A taking is the count per row, in `counterRows`' order: one row a kind for a removal, one a
 * kind and destination for a move. Each helper keeps every kind within what the card has and
 * the whole within `maxTotal`, so the panel never draws more than there is.
 */
import type { PlaytestAction, PlaytestCardRef, PlaytestCounters } from "@/lib/ipc";

/** One stepper: a kind of counter, and where it goes (`null` for a removal). */
export interface CounterRow {
  kind: string;
  to: PlaytestCardRef | null;
}

/** The rows the panel steps, kind by kind, each destination under its kind. */
export function counterRows(c: Pick<PlaytestCounters, "kinds" | "destinations">): CounterRow[] {
  return c.kinds.flatMap((k): CounterRow[] =>
    c.destinations.length === 0
      ? [{ kind: k.kind, to: null }]
      : c.destinations.map((to) => ({ kind: k.kind, to })),
  );
}

/** The counters taken so far, in all. */
export function countersTaken(taking: readonly number[]): number {
  return taking.reduce((a, b) => a + b, 0);
}

/** How many of `kind` are still on the card, given what is taken. */
export function countersLeft(
  c: Pick<PlaytestCounters, "kinds" | "destinations">,
  taking: readonly number[],
  kind: string,
): number {
  const has = c.kinds.find((k) => k.kind === kind)?.count ?? 0;
  const rows = counterRows(c);
  const taken = rows.reduce((sum, r, i) => (r.kind === kind ? sum + (taking[i] ?? 0) : sum), 0);
  return Math.max(0, has - taken);
}

/** Whether one more may go to row `index`: one of its kind left, and room under the most. */
export function canTakeMore(
  c: PlaytestCounters,
  taking: readonly number[],
  index: number,
): boolean {
  const row = counterRows(c)[index];
  if (row === undefined) return false;
  if (c.maxTotal !== null && countersTaken(taking) >= c.maxTotal) return false;
  return countersLeft(c, taking, row.kind) > 0;
}

/** Row `index` moved by `delta`, kept at or above none and within what may be taken. */
export function stepCounters(
  c: PlaytestCounters,
  taking: readonly number[],
  index: number,
  delta: number,
): number[] {
  const rows = counterRows(c);
  const now = rows.map((_, i) => taking[i] ?? 0);
  if (index < 0 || index >= rows.length) return now;
  if (delta > 0 && !canTakeMore(c, now, index)) return now;
  now[index] = Math.max(0, now[index] + Math.sign(delta));
  return now;
}

/** "3 taken of up to 4", "2 taken". */
export function countersCounter(
  c: Pick<PlaytestCounters, "maxTotal">,
  taking: readonly number[],
): string {
  const n = countersTaken(taking);
  return c.maxTotal === null ? `${n} taken` : `${n} taken of up to ${c.maxTotal}`;
}

/** The confirm button's words: "Remove none", "Remove 2", "Move 3". */
export function countersConfirm(
  c: Pick<PlaytestCounters, "destinations">,
  taking: readonly number[],
): string {
  const n = countersTaken(taking);
  const verb = c.destinations.length === 0 ? "Remove" : "Move";
  return n === 0 ? `${verb} none` : `${verb} ${n}`;
}

/** The answer: each row with any taken, a kind by its name and a destination by its id. */
export function countersAction(
  c: Pick<PlaytestCounters, "kinds" | "destinations">,
  taking: readonly number[],
): PlaytestAction {
  return {
    type: "moveCounters",
    shares: counterRows(c).flatMap((r, i) => {
      const count = taking[i] ?? 0;
      return count > 0 ? [{ kind: r.kind, to: r.to?.id ?? null, count }] : [];
    }),
  };
}
