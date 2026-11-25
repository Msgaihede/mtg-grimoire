/**
 * The division of an amount among targets as the reader chooses — the engine's `DistributeAmong`,
 * the prompt's `distribute` (CR 601.2d): Fireball's damage, Forked Bolt's, a spell's +1/+1
 * counters "divided as you choose". Every point is given, each target at least its `min` (1 as
 * the spell is cast, 0 — not chosen — as it resolves).
 *
 * A division is the amount per target, in the targets' order. Each helper keeps every share at
 * or above its least and the whole within `total`, so the panel can never draw more than there
 * is. Combat damage among blockers is `damage.ts`'s: its rules (lethal first, trample) are its own.
 */
import type { PlaytestAction, PlaytestDistribute } from "@/lib/ipc";

/** The amount per target, in `targets`' order. */
export type Division = readonly number[];

/** Where a division starts: each target at its least. */
export function startDivision(d: Pick<PlaytestDistribute, "targets">): number[] {
  return d.targets.map((t) => t.min);
}

/** The amount the division gives so far. */
export function divided(division: Division): number {
  return division.reduce((a, b) => a + b, 0);
}

/** The amount still to give. */
export function leftToDivide(d: Pick<PlaytestDistribute, "total">, division: Division): number {
  return Math.max(0, d.total - divided(division));
}

/** One target's share moved by `delta`, kept between its least and what is left. */
export function stepShare(
  d: Pick<PlaytestDistribute, "total" | "targets">,
  division: Division,
  index: number,
  delta: number,
): number[] {
  const target = d.targets[index];
  if (target === undefined) return [...division];
  const now = division[index] ?? target.min;
  const next = Math.max(target.min, Math.min(now + leftToDivide(d, division), now + delta));
  return division.map((n, i) => (i === index ? next : n));
}

/** Whether the division is an answer the engine takes: all of it given, each at its least. */
export function canDivide(
  d: Pick<PlaytestDistribute, "total" | "targets">,
  division: Division,
): boolean {
  return (
    division.length === d.targets.length &&
    divided(division) === d.total &&
    d.targets.every((t, i) => division[i] >= t.min)
  );
}

/** "3 of 5 left", "All 5 divided". */
export function divisionCounter(d: Pick<PlaytestDistribute, "total">, division: Division): string {
  const left = leftToDivide(d, division);
  return left === 0 ? `All ${d.total} divided` : `${left} of ${d.total} left`;
}

/** The answer: each target's share, a card by its `id`, a player by `player`. */
export function divideAction(
  d: Pick<PlaytestDistribute, "targets">,
  division: Division,
): PlaytestAction {
  return {
    type: "distribute",
    shares: d.targets.map((t, i) => ({
      id: t.card?.id ?? null,
      player: t.card === null ? t.player : null,
      amount: division[i] ?? 0,
    })),
  };
}
