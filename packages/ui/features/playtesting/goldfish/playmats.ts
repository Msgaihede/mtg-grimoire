/**
 * The felts the game menu's Playmat offers — what is behind the table when it is not the
 * commander's art.
 *
 * **Each felt is a tint mixed into the app's own background**, never a colour of its own: the
 * cards, the dashed table edge and the dim text are all drawn for `--color-bg`, so a felt that
 * moved far from it would leave them unreadable. Lighter in the middle and darker at the edges,
 * the way a lamp over a real table falls on the felt.
 */
import type { Playmat } from "./types";

export interface Felt {
  id: Exclude<Playmat, "commander">;
  label: string;
  /** The felt's colour, mixed into the background; `null` for the background itself. */
  tint: string | null;
}

export const FELTS: readonly Felt[] = [
  { id: "felt", label: "Felt", tint: null },
  { id: "green", label: "Green felt", tint: "oklch(0.55 0.15 140)" },
  { id: "blue", label: "Blue felt", tint: "oklch(0.52 0.11 248)" },
  { id: "red", label: "Red felt", tint: "oklch(0.48 0.14 22)" },
  { id: "purple", label: "Purple felt", tint: "oklch(0.48 0.13 305)" },
  { id: "slate", label: "Slate", tint: "oklch(0.55 0.025 250)" },
];

/** The CSS background for a felt, or `null` for the plain one (the board's own `bg-bg`). */
export function feltBackground(playmat: Playmat): string | null {
  const tint = FELTS.find((f) => f.id === playmat)?.tint ?? null;
  if (tint === null) return null;
  const mix = (pct: number) => `color-mix(in oklch, ${tint} ${pct}%, var(--color-bg))`;
  return `radial-gradient(ellipse 75% 70% at 50% 45%, ${mix(34)} 0%, ${mix(20)} 60%, ${mix(10)} 100%)`;
}
