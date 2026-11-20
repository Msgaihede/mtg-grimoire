/**
 * The game in progress, kept on this device so it outlives a reload, the tab being thrown away
 * and Android killing the app between two turns.
 *
 * **Browser storage, and nothing else.** A life total is not the reader's data in the sense a
 * collection is: it is never synced and never written to SQLite. One key, the whole game as JSON,
 * written on every change (`LifeBoard` debounces it), read once when the board resumes and once
 * by the setup to offer *Continue game*.
 *
 * **Every access is guarded**: storage can be missing, full, or refused outright (a private
 * window, a host with site data off), and a board that throws over a save it cannot write is a
 * board that loses the game it was trying to keep. A failed write is silent; a failed read is no
 * saved game.
 *
 * **Versioned, and strict on the way in.** A payload this build cannot read — another version, a
 * hand-edited key, a write torn by the app being killed — is ignored and the board starts fresh
 * from the setup, never half-loaded: a game with five life totals and six seats is worse than no
 * game. `bigint`s travel as decimal strings, since JSON has no 64-bit integer.
 */
import { LIFE_MAX, LIFE_MIN } from "./lifeNumber";
import type { GameState, SeatState } from "./gameState";
import { LIFE_FORMATS, TURN_TIMERS, type LifeFormat, type LifeSetup } from "../types";

export const SAVE_KEY = "grimoire.life.game.v1";
export const SAVE_VERSION = 1;

/** What the setup reads to offer *Continue game*. */
export interface SavedGameSummary {
  setup: LifeSetup;
  savedAt: number;
  turnNo: number;
  players: number;
}

interface SavedSeat extends Omit<SeatState, "life" | "delta" | "movedAt"> {
  life: string;
}

interface SavedPayload extends Omit<GameState, "seats"> {
  seats: SavedSeat[];
}

interface SaveFile {
  version: number;
  savedAt: number;
  game: SavedPayload;
}

/** The game as the key holds it. The deltas are not kept: they fade in five seconds, and a
 *  reload is longer than that. */
export function serializeGame(game: GameState, savedAt: number): string {
  const file: SaveFile = {
    version: SAVE_VERSION,
    savedAt,
    game: {
      ...game,
      seats: game.seats.map(({ life, poison, tax, energy, xp, blessed }) => ({
        life: life.toString(),
        poison,
        tax,
        energy,
        xp,
        blessed,
      })),
    },
  };
  return JSON.stringify(file);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, least: number, most: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= least && v <= most;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

function readSetup(v: unknown): LifeSetup | null {
  if (!isObj(v)) return null;
  const { format, players, life, layout, seating, timerSeconds, commander, autoLife } = v;
  if (typeof format !== "string" || !(format in LIFE_FORMATS)) return null;
  if (!isInt(players, 1, 6) || !isInt(life, 1, 9_999_999)) return null;
  if (layout !== "A" && layout !== "B") return null;
  if (seating !== null && seating !== "table" && seating !== "screen") return null;
  if (!(TURN_TIMERS as readonly unknown[]).includes(timerSeconds)) return null;
  if (!isBool(commander) || !isBool(autoLife)) return null;
  return {
    format: format as LifeFormat,
    players,
    life,
    layout,
    seating,
    timerSeconds: timerSeconds as number,
    commander,
    autoLife,
  };
}

function readLife(v: unknown): bigint | null {
  if (typeof v !== "string" || !/^-?\d{1,19}$/.test(v)) return null;
  const life = BigInt(v);
  return life < LIFE_MIN || life > LIFE_MAX ? null : life;
}

function readSeat(v: unknown): SeatState | null {
  if (!isObj(v)) return null;
  const life = readLife(v.life);
  if (life === null) return null;
  if (!isInt(v.poison, 0, 99) || !isInt(v.tax, 0, 98)) return null;
  if (!isInt(v.energy, 0, 999) || !isInt(v.xp, 0, 999) || !isBool(v.blessed)) return null;
  return {
    life,
    delta: 0n,
    movedAt: 0,
    poison: v.poison,
    tax: v.tax,
    energy: v.energy,
    xp: v.xp,
    blessed: v.blessed,
  };
}

/** A saved game read back, or `null` for anything this build cannot trust. */
export function parseSavedGame(text: string | null): { game: GameState; savedAt: number } | null {
  if (text === null) return null;
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(file) || file.version !== SAVE_VERSION || !isTime(file.savedAt)) return null;
  const g = file.game;
  if (!isObj(g)) return null;
  const setup = readSetup(g.setup);
  if (setup === null) return null;
  const n = setup.players;
  if (!Array.isArray(g.seats) || g.seats.length !== n) return null;
  const seats = g.seats.map(readSeat);
  if (seats.some((s) => s === null)) return null;

  const foes = g.foes;
  if (!isInt(foes, 0, 5) || (foes > 0 && (n !== 1 || !setup.commander))) return null;
  const dmg = g.dmg;
  if (
    !Array.isArray(dmg) ||
    dmg.length !== n ||
    !dmg.every(
      (row: unknown) =>
        Array.isArray(row) && row.length === n + foes && row.every((v) => isInt(v, 0, 999)),
    )
  ) {
    return null;
  }
  const { colour, monarch, turn, turnNo, turnStart, paused, pausedAt, picked } = g;
  const switches = [g.poisonOn, g.monarchOn, g.energyOn, g.xpOn, g.blessOn];
  if (!isInt(colour, 0, 5) || !switches.every(isBool)) return null;
  if (monarch !== null && !isInt(monarch, 0, n - 1)) return null;
  if (!isInt(turn, 0, n - 1) || !isInt(turnNo, 1, Number.MAX_SAFE_INTEGER)) return null;
  if (!isTime(turnStart) || !isBool(paused) || !isTime(pausedAt) || !isBool(picked)) return null;

  return {
    savedAt: file.savedAt,
    game: {
      setup,
      seats: seats as SeatState[],
      dmg: dmg as number[][],
      foes,
      colour,
      poisonOn: g.poisonOn as boolean,
      monarchOn: g.monarchOn as boolean,
      energyOn: g.energyOn as boolean,
      xpOn: g.xpOn as boolean,
      blessOn: g.blessOn as boolean,
      monarch: monarch as number | null,
      turn,
      turnNo,
      turnStart,
      paused,
      pausedAt,
      picked,
    },
  };
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Keep the game. Silent when storage will not take it. */
export function saveGame(game: GameState, savedAt: number): void {
  try {
    storage()?.setItem(SAVE_KEY, serializeGame(game, savedAt));
  } catch {
    // Full, or refused: the game goes on unsaved, which is all a board can do about it.
  }
}

/** The saved game, or `null` — none, or none this build can read. */
export function loadSavedGame(): GameState | null {
  try {
    return parseSavedGame(storage()?.getItem(SAVE_KEY) ?? null)?.game ?? null;
  } catch {
    return null;
  }
}

/** A cheap read for the setup's *Continue game*. */
export function peekSavedGame(): SavedGameSummary | null {
  try {
    const saved = parseSavedGame(storage()?.getItem(SAVE_KEY) ?? null);
    if (saved === null) return null;
    return {
      setup: saved.game.setup,
      savedAt: saved.savedAt,
      turnNo: saved.game.turnNo,
      players: saved.game.seats.length,
    };
  } catch {
    return null;
  }
}

/** Forget the game: the reader ended it. */
export function clearSavedGame(): void {
  try {
    storage()?.removeItem(SAVE_KEY);
  } catch {
    // Nothing to do: an unreadable key is no saved game either.
  }
}
