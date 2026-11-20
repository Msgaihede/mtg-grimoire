/**
 * A game on the board: what it is ({@link GameState}, the part that is saved) and what the board
 * is showing over it ({@link ViewState}, which is not), and every way either changes — one pure
 * reducer, {@link boardReducer}, so a press is a step a test can take without a screen.
 *
 * **Time comes in on the action** (`now`), never from the clock inside the reducer: a fade, a
 * turn's start and the calculator's grace period are all stamps, and a reducer that read the
 * clock would answer differently each time React replays it.
 *
 * The rules are the owner's, from the design canvas (2026-11-19): a seat is dead at 0 life or
 * less, at 21 commander damage from any one commander, or at ten poison counters while poison is
 * tracked — and alive again the moment none of those holds.
 */
import type { LifeSetup } from "../types";
import {
  EMPTY_CALC,
  calcResult,
  pressKey,
  type CalcKey,
  type CalcState,
  type CalcTarget,
} from "./calculator";
import { LIFE_MAX, LIFE_MIN, clampLife } from "./lifeNumber";

/** One seat's own figures. */
export interface SeatState {
  life: bigint;
  /** What the total has moved by since it last stood still for {@link FADE_MS}. */
  delta: bigint;
  /** When it last moved, ms; 0 for never. */
  movedAt: number;
  poison: number;
  /** One player's commander tax, in mana: two for every cast from the command zone. */
  tax: number;
  /** One player's energy and experience counters. */
  energy: number;
  xp: number;
  /** One player's city's blessing — once had, kept for the game. */
  blessed: boolean;
}

/** What a game is. Everything here is saved (`savedGame.ts`) and survives a reload. */
export interface GameState {
  setup: LifeSetup;
  seats: SeatState[];
  /**
   * `dmg[target][source]`: commander damage dealt to `target` by `source`'s commander. With one
   * player the sources past the first are the opponents who are not on the board: source `k` is
   * the opponent in the `k`-th seat colour.
   */
  dmg: number[][];
  /** One player's opponents, 1 to 5, in a Commander game; 0 otherwise. */
  foes: number;
  /** One player's colour, an index into {@link SEAT_COLORS}. */
  colour: number;
  /** The menu's switches. */
  poisonOn: boolean;
  monarchOn: boolean;
  energyOn: boolean;
  xpOn: boolean;
  blessOn: boolean;
  /** The seat that is the monarch, or `null`. */
  monarch: number | null;
  /** The seat to move, the turn's number, and when it started (ms). */
  turn: number;
  turnNo: number;
  turnStart: number;
  paused: boolean;
  pausedAt: number;
  /** Who goes first was just picked: the chip shows until the first press. */
  picked: boolean;
}

/** An open chip stepper: one at a time across the whole board. */
export type Stepper =
  | { kind: "poison"; seat: number }
  | { kind: "tax"; seat: number }
  | { kind: "energy" }
  | { kind: "xp" };

/** The open calculator: whose figure it sets, and when it opened. */
export interface EditState {
  /** The seat whose life — or, with `source`, whose commander damage taken — is being set. */
  seat: number;
  /** The commander dealing the damage being set, or `null` for a life total. */
  source: number | null;
  calc: CalcState;
  at: number;
}

/** Who goes first, while the light runs round the table. */
export interface SpinState {
  at: number;
  landed: boolean;
  blink: boolean;
}

/** What the board shows over the game. Never saved: a reload opens on the life totals. */
export interface ViewState {
  /** The seat whose commander damage is being counted, or `null`. */
  cmdFor: number | null;
  stepper: Stepper | null;
  /** Bumped by every stepper press, so the board can shut it a few seconds after the last. */
  stepperStamp: number;
  edit: EditState | null;
  menu: boolean;
  spin: SpinState | null;
  /** The question the board is asking before it throws the game away. */
  confirm: "leave" | "restart" | null;
}

export interface BoardState {
  game: GameState;
  view: ViewState;
}

/** How long a delta stays under the number. */
export const FADE_MS = 5000;
/** How long an open stepper stays open after its last press. */
export const STEPPER_MS = 4000;
/** 21 commander damage from one commander loses the game. */
export const LETHAL_COMMANDER = 21;
/** Ten poison counters lose the game. */
export const LETHAL_POISON = 10;
/** The most commander damage one commander's count goes to. */
export const MOST_DAMAGE = 999;

/**
 * The seats' colours, in order. Five are the mana colours; **the sixth is a pastel purple at their
 * lightness, which the design system has no token for yet** — written here once, with its name,
 * rather than in every place a seat is painted.
 */
export const SEAT_COLORS = [
  "var(--color-mana-w)",
  "var(--color-mana-u)",
  "var(--color-mana-b)",
  "var(--color-mana-r)",
  "var(--color-mana-g)",
  "oklch(80% 0.09 300)",
] as const;
export const SEAT_COLOR_NAMES = ["White", "Blue", "Black", "Red", "Green", "Purple"] as const;

/**
 * The colour of each seat, and with one player of each opponent: seats take the colours in order,
 * and one player picks theirs from the menu while their opponents — the commander damage tiles
 * and badges — take the other five, still in order.
 */
export function seatColors(game: GameState): string[] {
  if (game.seats.length !== 1) return [...SEAT_COLORS];
  return [SEAT_COLORS[game.colour], ...SEAT_COLORS.filter((_, k) => k !== game.colour)];
}

export const playerName = (seat: number): string => `Player ${seat + 1}`;

const players = (setup: LifeSetup) => Math.min(6, Math.max(1, Math.round(setup.players)));

/** A fresh game from a setup. */
export function newGame(setup: LifeSetup, now: number): GameState {
  const n = players(setup);
  const life = clampLife(BigInt(Math.max(1, Math.round(setup.life))));
  // One player still takes commander damage, from opponents who are not on the board: three to
  // start with, changed from the menu.
  const foes = n === 1 && setup.commander ? 3 : 0;
  const seats: SeatState[] = Array.from({ length: n }, () => ({
    life,
    delta: 0n,
    movedAt: 0,
    poison: 0,
    tax: 0,
    energy: 0,
    xp: 0,
    blessed: false,
  }));
  return {
    setup,
    seats,
    dmg: seats.map(() => Array.from({ length: n + foes }, () => 0)),
    foes,
    colour: 0,
    poisonOn: false,
    // The monarch is a Commander thing: one player in a Commander game always has the crown on
    // the board; from two players it is switched on from the menu.
    monarchOn: setup.commander && n === 1,
    energyOn: false,
    xpOn: false,
    blessOn: false,
    monarch: null,
    turn: 0,
    turnNo: 1,
    turnStart: now,
    paused: false,
    pausedAt: 0,
    picked: false,
  };
}

export const INITIAL_VIEW: ViewState = {
  cmdFor: null,
  stepper: null,
  stepperStamp: 0,
  edit: null,
  menu: false,
  spin: null,
  confirm: null,
};

export function boardFrom(game: GameState): BoardState {
  return { game, view: INITIAL_VIEW };
}

/** The commander whose damage has killed `seat`, or −1. */
export function lethalFrom(game: GameState, seat: number): number {
  if (!game.setup.commander) return -1;
  return game.dmg[seat].findIndex((taken) => taken >= LETHAL_COMMANDER);
}

/** Ten poison counters lose the game, counted only while poison is being tracked. */
export function poisoned(game: GameState, seat: number): boolean {
  return game.poisonOn && game.seats[seat].poison >= LETHAL_POISON;
}

export function isDead(game: GameState, seat: number): boolean {
  return game.seats[seat].life <= 0n || lethalFrom(game, seat) >= 0 || poisoned(game, seat);
}

/** The seats still in the game, in table order. */
export function livingSeats(game: GameState): number[] {
  return game.seats.map((_, i) => i).filter((i) => !isDead(game, i));
}

/** The delta as it stands at `now`: nothing once it has stood still for {@link FADE_MS}. */
export function liveDelta(seat: SeatState, now: number): bigint {
  return seat.delta !== 0n && now - seat.movedAt < FADE_MS ? seat.delta : 0n;
}

/** The turn clock: time left, or over time with a `+`. */
export function turnClock(game: GameState, now: number): { text: string; over: boolean } {
  const at = game.paused ? game.pausedAt : now;
  const left = game.setup.timerSeconds - Math.floor((at - game.turnStart) / 1000);
  const over = left < 0;
  const secs = Math.abs(left);
  const text = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  return { text: over ? `+${text}` : text, over };
}

/** What the open calculator sets, and the bounds its answer is held to. */
export function calcTarget(game: GameState, edit: EditState): CalcTarget {
  return edit.source === null
    ? { base: game.seats[edit.seat].life, least: LIFE_MIN, most: LIFE_MAX }
    : { base: BigInt(game.dmg[edit.seat][edit.source]), least: 0n, most: BigInt(MOST_DAMAGE) };
}

function withSeat(game: GameState, i: number, change: Partial<SeatState>): GameState {
  return { ...game, seats: game.seats.map((s, k) => (k === i ? { ...s, ...change } : s)) };
}

/**
 * A new life total. The delta under the number gathers every change made inside
 * {@link FADE_MS} of the last, and starts again from nothing after.
 */
export function setLife(game: GameState, i: number, value: bigint, now: number): GameState {
  const seat = game.seats[i];
  const next = clampLife(value);
  return withSeat(game, i, {
    life: next,
    delta: liveDelta(seat, now) + (next - seat.life),
    movedAt: now,
  });
}

/**
 * One commander's damage to a seat. **Commander damage is combat damage**: under the setup's
 * "Commander damage lowers life" the total moves with it; off, the total is the players' to change.
 */
export function setDamage(
  game: GameState,
  target: number,
  source: number,
  value: number,
  now: number,
): GameState {
  const next = Math.min(MOST_DAMAGE, Math.max(0, value));
  const diff = next - game.dmg[target][source];
  const dmg = game.dmg.map((row, t) =>
    t === target ? row.map((v, s) => (s === source ? next : v)) : row,
  );
  const moved = { ...game, dmg };
  return game.setup.autoLife && diff !== 0
    ? setLife(moved, target, moved.seats[target].life - BigInt(diff), now)
    : moved;
}

/** The menu's switches. */
export type GameSwitch = "poisonOn" | "monarchOn" | "energyOn" | "xpOn" | "blessOn";

export type BoardAction =
  /** A tap on a half of a panel (or of one player's opponent tile, `seat` ≥ the seat count). */
  | { type: "tap"; seat: number; by: 1 | -1; now: number }
  | { type: "openCalc"; seat: number; now: number }
  | { type: "calcKey"; key: CalcKey }
  | { type: "closeCalc" }
  | { type: "applyCalc"; now: number }
  /** Open a seat's commander damage, or close it with `null`. */
  | { type: "commander"; seat: number | null }
  /** A stepper chip: `by` 0 opens or shuts it, anything else steps it. */
  | { type: "stepper"; stepper: Stepper; by: number }
  | { type: "closeStepper" }
  /** A press on a chip of its own: it only takes the goes-first chip away. */
  | { type: "pressChip" }
  /** Any other press on the board: it shuts a stepper and takes the goes-first chip away. */
  | { type: "pressElsewhere" }
  | { type: "bless" }
  | { type: "crown"; seat: number }
  | { type: "passTurn"; now: number }
  | { type: "menu"; open: boolean }
  | { type: "switch"; name: GameSwitch }
  | { type: "foes"; count: number }
  | { type: "colour"; colour: number }
  | { type: "pause"; now: number }
  | { type: "spinStart"; at: number }
  | { type: "spinStep"; at: number }
  | { type: "spinLand" }
  | { type: "spinBlink"; blink: boolean }
  | { type: "spinEnd"; now: number }
  | { type: "confirm"; ask: ViewState["confirm"] }
  | { type: "restart"; now: number };

const clampCount = (v: number, most: number) => Math.min(most, Math.max(0, v));

function sameStepper(a: Stepper | null, b: Stepper): boolean {
  if (a === null || a.kind !== b.kind) return false;
  return !("seat" in a) || !("seat" in b) || a.seat === b.seat;
}

function stepGame(game: GameState, stepper: Stepper, by: number): GameState {
  switch (stepper.kind) {
    case "poison":
      return withSeat(game, stepper.seat, {
        poison: clampCount(game.seats[stepper.seat].poison + by, 99),
      });
    case "tax":
      return withSeat(game, stepper.seat, {
        tax: clampCount(game.seats[stepper.seat].tax + by, 98),
      });
    case "energy":
      return withSeat(game, 0, { energy: clampCount(game.seats[0].energy + by, 999) });
    case "xp":
      return withSeat(game, 0, { xp: clampCount(game.seats[0].xp + by, 999) });
  }
}

/**
 * The same setup again, with what the players chose from the menu kept: the switches, one
 * player's colour and their opponents.
 */
export function restartGame(game: GameState, now: number): GameState {
  const fresh = newGame(game.setup, now);
  const foes = game.foes > 0 ? game.foes : fresh.foes;
  const n = fresh.seats.length;
  return {
    ...fresh,
    poisonOn: game.poisonOn,
    monarchOn: game.monarchOn,
    energyOn: game.energyOn,
    xpOn: game.xpOn,
    blessOn: game.blessOn,
    colour: game.colour,
    foes,
    dmg: fresh.seats.map(() => Array.from({ length: n + foes }, () => 0)),
  };
}

export function boardReducer(state: BoardState, action: BoardAction): BoardState {
  const { game, view } = state;
  switch (action.type) {
    case "tap": {
      const unpicked = { ...game, picked: false };
      const next =
        view.cmdFor !== null && view.cmdFor !== action.seat
          ? setDamage(
              unpicked,
              view.cmdFor,
              action.seat,
              game.dmg[view.cmdFor][action.seat] + action.by,
              action.now,
            )
          : setLife(
              unpicked,
              action.seat,
              game.seats[action.seat].life + BigInt(action.by),
              action.now,
            );
      return { game: next, view };
    }
    case "openCalc": {
      // A held press on another seat's panel while one seat's commander damage is open sets the
      // damage that seat's commander has dealt, not its life.
      const source = view.cmdFor !== null && view.cmdFor !== action.seat;
      return {
        game,
        view: {
          ...view,
          stepper: null,
          edit: {
            seat: source ? view.cmdFor! : action.seat,
            source: source ? action.seat : null,
            calc: EMPTY_CALC,
            at: action.now,
          },
        },
      };
    }
    case "calcKey": {
      if (!view.edit) return state;
      const calc = pressKey(view.edit.calc, action.key, calcTarget(game, view.edit));
      return { game, view: { ...view, edit: { ...view.edit, calc } } };
    }
    case "closeCalc":
      return { game, view: { ...view, edit: null } };
    case "applyCalc": {
      const edit = view.edit;
      if (!edit) return state;
      const result = edit.calc.tokens.length ? calcResult(edit.calc, calcTarget(game, edit)) : null;
      // A sum that cannot be worked out (a division by zero) sets nothing.
      if (result === null) return { game, view: { ...view, edit: null } };
      const unpicked = { ...game, picked: false };
      const next =
        edit.source === null
          ? setLife(unpicked, edit.seat, result, action.now)
          : setDamage(unpicked, edit.seat, edit.source, Number(result), action.now);
      return { game: next, view: { ...view, edit: null } };
    }
    case "commander":
      if (action.seat !== null && !game.setup.commander) return state;
      return {
        game: game.picked ? { ...game, picked: false } : game,
        view: { ...view, cmdFor: action.seat, stepper: null },
      };
    case "stepper": {
      const open = sameStepper(view.stepper, action.stepper);
      const stepper = action.by === 0 ? (open ? null : action.stepper) : view.stepper;
      return {
        game: action.by === 0 ? game : stepGame(game, action.stepper, action.by),
        view: { ...view, stepper, stepperStamp: view.stepperStamp + 1 },
      };
    }
    case "closeStepper":
      return view.stepper === null ? state : { game, view: { ...view, stepper: null } };
    case "pressChip":
      return game.picked ? { game: { ...game, picked: false }, view } : state;
    case "pressElsewhere":
      if (view.stepper === null && !game.picked) return state;
      return { game: { ...game, picked: false }, view: { ...view, stepper: null } };
    case "bless":
      return { game: withSeat(game, 0, { blessed: !game.seats[0].blessed }), view };
    case "crown":
      return {
        game: { ...game, monarch: game.monarch === action.seat ? null : action.seat },
        view,
      };
    case "passTurn": {
      const n = game.seats.length;
      let k = game.turn;
      for (let step = 0; step < n; step++) {
        k = (k + 1) % n;
        if (!isDead(game, k)) break;
      }
      return {
        game: {
          ...game,
          turn: k,
          turnNo: game.turnNo + 1,
          turnStart: action.now,
          paused: false,
          picked: false,
        },
        view,
      };
    }
    case "menu":
      return { game, view: { ...view, menu: action.open } };
    case "switch": {
      const on = !game[action.name];
      const shut =
        (action.name === "poisonOn" && view.stepper?.kind === "poison") ||
        ((action.name === "energyOn" || action.name === "xpOn") &&
          (view.stepper?.kind === "energy" || view.stepper?.kind === "xp"));
      return {
        game: { ...game, [action.name]: on },
        view: shut ? { ...view, stepper: null } : view,
      };
    }
    case "foes": {
      // Taking an opponent away takes their damage off the record; the life it cost stays lost.
      const next = Math.min(5, Math.max(1, action.count));
      const n = game.seats.length;
      const row = game.dmg[0].slice(0, n + next);
      while (row.length < n + next) row.push(0);
      return { game: { ...game, foes: next, dmg: [row, ...game.dmg.slice(1)] }, view };
    }
    case "colour":
      return { game: { ...game, colour: action.colour }, view };
    case "pause": {
      const next = game.paused
        ? { ...game, paused: false, turnStart: game.turnStart + (action.now - game.pausedAt) }
        : { ...game, paused: true, pausedAt: action.now };
      return { game: next, view: { ...view, menu: false } };
    }
    case "spinStart":
      return {
        game: { ...game, picked: false },
        view: {
          ...view,
          menu: false,
          stepper: null,
          spin: { at: action.at, landed: false, blink: false },
        },
      };
    case "spinStep":
      return view.spin ? { game, view: { ...view, spin: { ...view.spin, at: action.at } } } : state;
    case "spinLand":
      return view.spin
        ? { game, view: { ...view, spin: { ...view.spin, landed: true, blink: true } } }
        : state;
    case "spinBlink":
      return view.spin
        ? { game, view: { ...view, spin: { ...view.spin, blink: action.blink } } }
        : state;
    case "spinEnd":
      if (!view.spin) return state;
      return {
        game: {
          ...game,
          turn: view.spin.at,
          turnNo: 1,
          turnStart: action.now,
          paused: false,
          picked: true,
        },
        view: { ...view, spin: null },
      };
    case "confirm":
      return { game, view: { ...view, confirm: action.ask, menu: false } };
    case "restart":
      return boardFrom(restartGame(game, action.now));
  }
}
