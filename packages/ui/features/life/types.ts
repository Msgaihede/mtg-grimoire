/**
 * The life tracker's shared vocabulary — what the setup hands the board, and what both faces of
 * the light app agree on. Light edition only: the desktop app draws no Life view
 * (`lib/edition.ts`, `LIGHT_ONLY_VIEWS`).
 *
 * Designed on the *Life Tracker — Light App* canvas (2026-11-19 to 2026-11-20); the board's rules
 * (life as a 64-bit integer, three-digit totals, 21 commander damage from one commander, ten
 * poison) are the owner's, decided there.
 */

/** The format presets the setup offers. A preset fills the rest of the setup; every field stays
 *  editable after it, and the setup says when it no longer matches its preset. */
export type LifeFormat =
  | "standard"
  | "modern"
  | "commander"
  | "brawl"
  | "oathbreaker"
  | "twoHeadedGiant";

export interface LifeFormatPreset {
  label: string;
  players: number;
  life: number;
  /** Whether commander damage is tracked, and whether the game counts as a Commander game for
   *  the monarch and (with one player) commander tax. */
  commander: boolean;
}

/** In the order the setup's sheet lists them. */
export const LIFE_FORMATS: Readonly<Record<LifeFormat, LifeFormatPreset>> = {
  standard: { label: "Standard", players: 2, life: 20, commander: false },
  modern: { label: "Modern", players: 2, life: 20, commander: false },
  commander: { label: "Commander", players: 4, life: 40, commander: true },
  brawl: { label: "Brawl", players: 2, life: 25, commander: false },
  oathbreaker: { label: "Oathbreaker", players: 4, life: 20, commander: false },
  twoHeadedGiant: { label: "Two-Headed Giant", players: 2, life: 30, commander: false },
};

/**
 * How the seats face.
 *
 * - `table` — a phone or tablet lying on the table, read from every side: each panel is turned
 *   to its player, in layout A or B.
 * - `screen` — a window everyone reads from the same side: every panel upright, in a grid fitted
 *   to the window's shape. Layout A/B means nothing here.
 */
export type Seating = "table" | "screen";

/** The turn timer's choices, in seconds; 0 is off (the default). */
export const TURN_TIMERS = [0, 30, 60, 120, 180, 300, 600] as const;

export interface LifeSetup {
  format: LifeFormat;
  /** 1 to 6. */
  players: number;
  /** Starting life, 1 to 9,999,999 (the setup's Custom field takes seven digits). */
  life: number;
  /** Two players have one layout and ignore this. */
  layout: "A" | "B";
  /** `null` until the reader picks: the board then goes round the table below 1024px wide and
   *  faces one way from 1024px (the light app's desktop face), see {@link resolveSeating}. */
  seating: Seating | null;
  /** One of {@link TURN_TIMERS}. */
  timerSeconds: number;
  /** Commander damage tracked (and the game is a Commander game). */
  commander: boolean;
  /** Commander damage also comes off the life total. Only read while `commander` is on. */
  autoLife: boolean;
}

/** The light app's desktop face starts here; `apps/light/useFace.ts`' `DESKTOP_FLOOR_PX`. */
export const SCREEN_SEATING_FROM_PX = 1024;

/** The seating a setup that has not chosen one gets in a board this wide. */
export function resolveSeating(setup: LifeSetup, boardWidth: number): Seating {
  return setup.seating ?? (boardWidth >= SCREEN_SEATING_FROM_PX ? "screen" : "table");
}

/** A setup straight from a preset. */
export function setupFromFormat(format: LifeFormat): LifeSetup {
  const preset = LIFE_FORMATS[format];
  return {
    format,
    players: preset.players,
    life: preset.life,
    layout: "A",
    seating: null,
    timerSeconds: 0,
    commander: preset.commander,
    autoLife: true,
  };
}

/** What a light install opens the setup on the first time: Commander's preset. */
export const DEFAULT_SETUP: LifeSetup = setupFromFormat("commander");
