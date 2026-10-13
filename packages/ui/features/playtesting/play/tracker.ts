/**
 * The turn tracker's arithmetic: the five places a turn passes through, which one the game is in,
 * and whose turn it is.
 *
 * **Coarse on purpose**, as the wire is (`PlaytestPhase`): the board shows where the turn is, not
 * every step of it, and the five are the ones a reader names — "it's their combat", "my second
 * main". The current one is lit in the colour of the seat whose turn it is (gold for the reader,
 * the opponent's red), so a glance at the strip says both at once.
 */
import type { GoldfishSeat, PlaytestPhase, PlaytestView } from "@/lib/ipc";
import { phaseLine } from "./combat";

export const PHASES: readonly { id: PlaytestPhase; label: string }[] = [
  { id: "beginning", label: "Beginning" },
  { id: "main1", label: "Main 1" },
  { id: "combat", label: "Combat" },
  { id: "main2", label: "Main 2" },
  { id: "ending", label: "End" },
];

export interface TrackerStep {
  id: PlaytestPhase;
  label: string;
  /** The phase the game is in. */
  lit: boolean;
  /** A phase this turn has already been through. */
  past: boolean;
}

export interface Tracker {
  /** 0 during the opening hands, when nothing is lit. */
  turn: number;
  whose: GoldfishSeat;
  steps: TrackerStep[];
  /** The whole strip in words, for a screen reader: "Turn 5 · Your main phase". */
  caption: string;
}

export function trackerOf(view: PlaytestView): Tracker {
  const live = view.turn > 0 && view.stage !== "mulligan";
  const at = live ? PHASES.findIndex((p) => p.id === view.phase) : -1;
  return {
    turn: live ? view.turn : 0,
    whose: view.active,
    steps: PHASES.map((p, i) => ({ ...p, lit: i === at, past: at >= 0 && i < at })),
    caption: phaseLine(view),
  };
}
