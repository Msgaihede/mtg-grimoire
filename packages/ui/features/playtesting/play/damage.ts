/**
 * The division of an attacker's combat damage among the creatures blocking it — the engine's
 * `AssignCombatDamage`, the prompt's `damage` (CR 510.1c; issue #1448). The attacker's controller
 * decides which blockers die, not the order they blocked in: every point is assigned, to the
 * blockers in any split, and with trample past them only once each has lethal (CR 702.19b).
 *
 * A split is the amount per blocker id, plus `excess` — trample's, to what the attacker attacks.
 * Each helper keeps the whole within `total`, so the panel can never draw more than there is.
 */
import type { PlaytestAction, PlaytestDamage } from "@/lib/ipc";

export interface DamageSplit {
  /** Damage per blocker id; a blocker missing is assigned none. */
  amounts: Readonly<Record<number, number>>;
  /** Trample's damage past the blockers. */
  excess: number;
}

export const NO_SPLIT: DamageSplit = { amounts: {}, excess: 0 };

/** The damage the split assigns so far. */
export function assigned(split: DamageSplit): number {
  return Object.values(split.amounts).reduce((a, b) => a + b, 0) + split.excess;
}

/** The damage still to assign. */
export function left(damage: PlaytestDamage, split: DamageSplit): number {
  return Math.max(0, damage.total - assigned(split));
}

/** One blocker's share. */
export function amountOf(split: DamageSplit, id: number): number {
  return split.amounts[id] ?? 0;
}

/** Every blocker has been assigned lethal damage: trample may carry the rest past them. */
export function allLethal(damage: PlaytestDamage, split: DamageSplit): boolean {
  return damage.blockers.every((b) => amountOf(split, b.card.id) >= b.lethal);
}

/** The split may go past the blockers now: the attacker tramples and each blocker has lethal. */
export function canTrample(damage: PlaytestDamage, split: DamageSplit): boolean {
  return damage.trample && allLethal(damage, split);
}

/**
 * One blocker's share moved by `delta`, kept between none and what is left. A share cut below
 * lethal takes trample's excess back to the pool: excess is only for blockers that all have lethal.
 */
export function stepBlocker(
  damage: PlaytestDamage,
  split: DamageSplit,
  id: number,
  delta: number,
): DamageSplit {
  const now = amountOf(split, id);
  const next = Math.max(0, Math.min(now + left(damage, split), now + delta));
  const amounts = { ...split.amounts, [id]: next };
  const out = { amounts, excess: split.excess };
  return allLethal(damage, out) ? out : { amounts, excess: 0 };
}

/** Trample's excess moved by `delta`, kept between none and what is left — only once it may. */
export function stepExcess(damage: PlaytestDamage, split: DamageSplit, delta: number): DamageSplit {
  if (!canTrample(damage, split)) return split;
  const next = Math.max(0, Math.min(split.excess + left(damage, split), split.excess + delta));
  return { ...split, excess: next };
}

/**
 * A click on a blocker: lethal to it, or as much of that as is left — and a blocker that already
 * has lethal takes all that is left on top, so two clicks put everything on one creature.
 */
export function lethalTo(damage: PlaytestDamage, split: DamageSplit, id: number): DamageSplit {
  const blocker = damage.blockers.find((b) => b.card.id === id);
  if (blocker === undefined) return split;
  const now = amountOf(split, id);
  const room = left(damage, split);
  const delta = now >= blocker.lethal ? room : Math.min(blocker.lethal - now, room);
  return stepBlocker(damage, split, id, delta);
}

/** The split is an answer: every point assigned, and any excess only past lethal blockers. */
export function canAssign(damage: PlaytestDamage, split: DamageSplit): boolean {
  if (assigned(split) !== damage.total) return false;
  return split.excess === 0 || canTrample(damage, split);
}

/** The panel's count: "3 of 5 assigned". */
export function damageCounter(damage: PlaytestDamage, split: DamageSplit): string {
  return `${assigned(split)} of ${damage.total} assigned`;
}

/** What the split sends: each blocker with damage, in the engine's order, and the excess. */
export function assignAction(damage: PlaytestDamage, split: DamageSplit): PlaytestAction {
  return {
    type: "assignDamage",
    blockers: damage.blockers
      .map((b) => ({ blocker: b.card.id, amount: amountOf(split, b.card.id) }))
      .filter((s) => s.amount > 0),
    excess: split.excess,
  };
}
