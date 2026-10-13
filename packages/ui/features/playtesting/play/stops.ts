/**
 * The steps the game stops at for the reader — Arena's stops, as the engine takes them
 * (`setStops`, the whole set each time; the set in force comes back in `view.stops`).
 *
 * **The reader's own main phases always stop**: the board gives control there whatever the set
 * says (the `main` stage), so they are drawn as fixed on, never sent, and never toggled off.
 */
import type { GoldfishSeat, PlaytestStop, PlaytestStopStep } from "@/lib/ipc";

export const STOP_STEPS: readonly { step: PlaytestStopStep; label: string }[] = [
  { step: "upkeep", label: "Upkeep" },
  { step: "draw", label: "Draw" },
  { step: "main1", label: "Main 1" },
  { step: "beginCombat", label: "Combat" },
  { step: "attackers", label: "Attackers" },
  { step: "blockers", label: "Blockers" },
  { step: "damage", label: "Damage" },
  { step: "main2", label: "Main 2" },
  { step: "end", label: "End" },
];

/** A stop the board always makes: the reader's own main phases. */
export function fixedStop(seat: GoldfishSeat, step: PlaytestStopStep): boolean {
  return seat === "you" && (step === "main1" || step === "main2");
}

export function hasStop(
  stops: readonly PlaytestStop[],
  seat: GoldfishSeat,
  step: PlaytestStopStep,
): boolean {
  return fixedStop(seat, step) || stops.some((s) => s.seat === seat && s.step === step);
}

/** The set with one stop turned on or off; a fixed stop is left as it is. */
export function toggleStop(
  stops: readonly PlaytestStop[],
  seat: GoldfishSeat,
  step: PlaytestStopStep,
): PlaytestStop[] {
  if (fixedStop(seat, step)) return [...stops];
  return stops.some((s) => s.seat === seat && s.step === step)
    ? stops.filter((s) => !(s.seat === seat && s.step === step))
    : [...stops, { seat, step }];
}
