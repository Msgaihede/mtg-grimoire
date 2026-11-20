import { describe, expect, it } from "vitest";
import { setupFromFormat, type LifeSetup } from "../types";
import {
  FADE_MS,
  boardFrom,
  boardReducer,
  isDead,
  lethalFrom,
  liveDelta,
  livingSeats,
  newGame,
  restartGame,
  seatColors,
  turnClock,
  type BoardAction,
  type BoardState,
} from "./gameState";
import { LIFE_MAX } from "./lifeNumber";

const T0 = 1_000_000;
const commander = setupFromFormat("commander");
const standard = setupFromFormat("standard");

function board(setup: LifeSetup = commander): BoardState {
  return boardFrom(newGame(setup, T0));
}

function run(state: BoardState, ...actions: BoardAction[]): BoardState {
  return actions.reduce(boardReducer, state);
}

describe("a new game", () => {
  it("seats the setup's players at its life", () => {
    const { game } = board();
    expect(game.seats).toHaveLength(4);
    expect(game.seats.every((s) => s.life === 40n)).toBe(true);
    expect(game.dmg).toEqual([0, 0, 0, 0].map(() => [0, 0, 0, 0]));
    expect(game.monarchOn).toBe(false);
  });

  it("gives one player in a Commander game three opponents, the crown and the tax", () => {
    const { game } = board({ ...commander, players: 1 });
    expect(game.foes).toBe(3);
    expect(game.dmg).toEqual([[0, 0, 0, 0]]);
    expect(game.monarchOn).toBe(true);
    expect(board({ ...standard, players: 1 }).game.foes).toBe(0);
  });

  it("deals one player the colour they pick and their opponents the other five", () => {
    const { game } = board({ ...commander, players: 1 });
    const blue = { ...game, colour: 1 };
    expect(seatColors(blue)[0]).toBe("var(--color-mana-u)");
    expect(seatColors(blue)[1]).toBe("var(--color-mana-w)");
    expect(new Set(seatColors(blue)).size).toBe(6);
  });
});

describe("a tap", () => {
  it("moves a life total by one, and gathers the delta", () => {
    const state = run(
      board(),
      { type: "tap", seat: 0, by: -1, now: T0 + 1 },
      { type: "tap", seat: 0, by: -1, now: T0 + 2 },
    );
    expect(state.game.seats[0].life).toBe(38n);
    expect(liveDelta(state.game.seats[0], T0 + 3)).toBe(-2n);
  });

  it("starts the delta again once it has stood still five seconds", () => {
    const state = run(
      board(),
      { type: "tap", seat: 0, by: -1, now: T0 },
      { type: "tap", seat: 0, by: 1, now: T0 + FADE_MS + 1 },
    );
    expect(liveDelta(state.game.seats[0], T0 + FADE_MS + 2)).toBe(1n);
    expect(liveDelta(state.game.seats[0], T0 + 2 * FADE_MS + 2)).toBe(0n);
  });

  it("holds life to a 64-bit integer", () => {
    const state = run(
      board(),
      { type: "openCalc", seat: 0, now: T0 },
      ...[..."9999999999999999999"].map((key) => ({ type: "calcKey", key }) as BoardAction),
      { type: "applyCalc", now: T0 + 1 },
      { type: "tap", seat: 0, by: 1, now: T0 + 2 },
    );
    expect(state.game.seats[0].life).toBe(LIFE_MAX);
  });

  it("counts a commander's damage while a seat's commander damage is open, and costs the life", () => {
    const state = run(
      board(),
      { type: "commander", seat: 0 },
      { type: "tap", seat: 2, by: 1, now: T0 },
      { type: "tap", seat: 2, by: 1, now: T0 },
    );
    expect(state.game.dmg[0][2]).toBe(2);
    expect(state.game.seats[0].life).toBe(38n);
    // The counted seat's own panel is still its life.
    expect(run(state, { type: "tap", seat: 0, by: 1, now: T0 }).game.seats[0].life).toBe(39n);
  });

  it("leaves life alone when commander damage does not lower it", () => {
    const state = run(
      board({ ...commander, autoLife: false }),
      { type: "commander", seat: 0 },
      { type: "tap", seat: 1, by: 1, now: T0 },
    );
    expect(state.game.dmg[0][1]).toBe(1);
    expect(state.game.seats[0].life).toBe(40n);
  });
});

describe("death", () => {
  it("comes at 0 life, and goes again above it", () => {
    let state = board(standard);
    for (let k = 0; k < 20; k++) state = run(state, { type: "tap", seat: 1, by: -1, now: T0 });
    expect(isDead(state.game, 1)).toBe(true);
    expect(isDead(run(state, { type: "tap", seat: 1, by: 1, now: T0 }).game, 1)).toBe(false);
  });

  it("comes at 21 commander damage from one commander, not from several", () => {
    const { game } = board({ ...commander, autoLife: false });
    const spread = { ...game, dmg: [[0, 20, 20, 20], ...game.dmg.slice(1)] };
    expect(isDead(spread, 0)).toBe(false);
    const lethal = { ...game, dmg: [[0, 21, 0, 0], ...game.dmg.slice(1)] };
    expect(isDead(lethal, 0)).toBe(true);
    expect(lethalFrom(lethal, 0)).toBe(1);
    // Outside a Commander game there is no commander damage to die of.
    const plain = { ...lethal, setup: { ...lethal.setup, commander: false } };
    expect(isDead(plain, 0)).toBe(false);
  });

  it("comes at ten poison, only while poison is tracked", () => {
    let state = board(standard);
    for (let k = 0; k < 10; k++) {
      state = run(state, { type: "stepper", stepper: { kind: "poison", seat: 0 }, by: 1 });
    }
    expect(state.game.seats[0].poison).toBe(10);
    expect(isDead(state.game, 0)).toBe(false);
    state = run(state, { type: "switch", name: "poisonOn" });
    expect(isDead(state.game, 0)).toBe(true);
    expect(livingSeats(state.game)).toEqual([1]);
  });

  it("is passed over when the turn passes", () => {
    const { game } = board();
    const dead = { ...game, seats: game.seats.map((s, k) => (k === 1 ? { ...s, life: 0n } : s)) };
    const next = boardReducer(boardFrom(dead), { type: "passTurn", now: T0 + 5 });
    expect(next.game.turn).toBe(2);
    expect(next.game.turnNo).toBe(2);
    expect(next.game.turnStart).toBe(T0 + 5);
  });
});

describe("the calculator", () => {
  it("sets the commander damage a held press on another seat's panel opened", () => {
    const state = run(
      board(),
      { type: "commander", seat: 0 },
      { type: "openCalc", seat: 3, now: T0 },
    );
    expect(state.view.edit).toMatchObject({ seat: 0, source: 3 });
    const set = run(state, { type: "calcKey", key: "7" }, { type: "applyCalc", now: T0 + 1 });
    expect(set.game.dmg[0][3]).toBe(7);
    expect(set.game.seats[0].life).toBe(33n);
    expect(set.view.edit).toBeNull();
  });

  it("sets nothing on a division by zero", () => {
    const state = run(
      board(),
      { type: "openCalc", seat: 0, now: T0 },
      { type: "calcKey", key: "÷" },
      { type: "calcKey", key: "0" },
      { type: "applyCalc", now: T0 },
    );
    expect(state.game.seats[0].life).toBe(40n);
    expect(state.view.edit).toBeNull();
  });
});

describe("the steppers and the menu", () => {
  it("opens one stepper at a time, and steps the tax by two", () => {
    const solo = board({ ...commander, players: 1 });
    const state = run(
      solo,
      { type: "stepper", stepper: { kind: "tax", seat: 0 }, by: 0 },
      { type: "stepper", stepper: { kind: "tax", seat: 0 }, by: 2 },
      { type: "stepper", stepper: { kind: "energy" }, by: 0 },
    );
    expect(state.game.seats[0].tax).toBe(2);
    expect(state.view.stepper).toEqual({ kind: "energy" });
    expect(run(state, { type: "pressElsewhere" }).view.stepper).toBeNull();
  });

  it("takes an opponent's damage off the record with them, and keeps the life it cost", () => {
    const solo = board({ ...commander, players: 1 });
    const hit = run(
      solo,
      { type: "commander", seat: 0 },
      { type: "tap", seat: 3, by: 1, now: T0 },
      { type: "foes", count: 2 },
    );
    expect(hit.game.dmg[0]).toEqual([0, 0, 0]);
    expect(hit.game.seats[0].life).toBe(39n);
    expect(run(hit, { type: "foes", count: 9 }).game.dmg[0]).toHaveLength(6);
  });

  it("restarts with the same setup and keeps the menu's choices", () => {
    const played = run(
      board({ ...commander, players: 1 }),
      { type: "switch", name: "poisonOn" },
      { type: "switch", name: "energyOn" },
      { type: "colour", colour: 4 },
      { type: "foes", count: 5 },
      { type: "tap", seat: 0, by: -1, now: T0 },
    );
    const again = restartGame(played.game, T0 + 10);
    expect(again.seats[0].life).toBe(40n);
    expect(again).toMatchObject({ poisonOn: true, energyOn: true, colour: 4, foes: 5 });
    expect(again.dmg[0]).toHaveLength(6);
  });

  it("pauses the turn clock and gives the paused time back", () => {
    const timed = board({ ...standard, timerSeconds: 60 });
    expect(turnClock(timed.game, T0 + 15_000)).toEqual({ text: "0:45", over: false });
    const paused = run(timed, { type: "pause", now: T0 + 15_000 });
    expect(turnClock(paused.game, T0 + 50_000).text).toBe("0:45");
    const resumed = run(paused, { type: "pause", now: T0 + 50_000 });
    expect(turnClock(resumed.game, T0 + 60_000).text).toBe("0:35");
    expect(turnClock(resumed.game, T0 + 200_000)).toEqual({ text: "+1:45", over: true });
  });
});

describe("the roulette", () => {
  it("hands the turn to the seat it landed on, and says so until the first press", () => {
    const state = run(
      board(),
      { type: "menu", open: true },
      { type: "spinStart", at: 1 },
      { type: "spinStep", at: 2 },
      { type: "spinLand" },
      { type: "spinEnd", now: T0 + 4000 },
    );
    expect(state.view.menu).toBe(false);
    expect(state.view.spin).toBeNull();
    expect(state.game).toMatchObject({ turn: 2, turnNo: 1, picked: true, turnStart: T0 + 4000 });
    expect(run(state, { type: "pressElsewhere" }).game.picked).toBe(false);
  });
});
