/**
 * Coin flips kept and die rolls ignored — the engine's `CoinFlipKeepChoice` (Krark's Thumb,
 * CR 705.1) and `DieKeepChoice` (CR 706.6), the prompt's `results`. The results are drawn; the
 * reader picks exactly `count` of the `eligible` ones: coins kept, or dice ignored.
 */
import type { PlaytestResults } from "@/lib/ipc";

/** A result in words: "Heads", "Tails", or a die's roll. */
export function resultWord(r: Pick<PlaytestResults, "dice">, value: number): string {
  if (r.dice) return String(value);
  return value === 1 ? "Heads" : "Tails";
}

/** The panel's heading: "Keep 1 of 2 flips", "Ignore 1 of 3 rolls". */
export function resultsTitle(r: PlaytestResults): string {
  const noun = r.dice ? "rolls" : "flips";
  return `${r.dice ? "Ignore" : "Keep"} ${r.count} of ${r.results.length} ${noun}`;
}

/** A result clicked: put back if picked, picked while there is room, else left as it was. */
export function toggleResult(
  r: Pick<PlaytestResults, "eligible" | "count">,
  picked: readonly number[],
  index: number,
): number[] {
  if (picked.includes(index)) return picked.filter((i) => i !== index);
  if (!r.eligible.includes(index)) return [...picked];
  // One to name: a click moves the pick.
  if (r.count === 1) return [index];
  return picked.length >= r.count ? [...picked] : [...picked, index];
}

/** Whether the picked results are an answer: exactly `count` of them. */
export function canKeepResults(
  r: Pick<PlaytestResults, "count">,
  picked: readonly number[],
): boolean {
  return picked.length === r.count;
}

/** The confirm button's words: "Keep it", "Ignore 2". */
export function resultsConfirm(r: Pick<PlaytestResults, "dice" | "count">): string {
  const verb = r.dice ? "Ignore" : "Keep";
  return r.count === 1 ? `${verb} it` : `${verb} ${r.count}`;
}
