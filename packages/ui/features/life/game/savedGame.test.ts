import { afterEach, describe, expect, it, vi } from "vitest";
import { setupFromFormat } from "../types";
import { newGame, setLife, setDamage, type GameState } from "./gameState";
import { LIFE_MAX, LIFE_MIN } from "./lifeNumber";
import {
  SAVE_KEY,
  clearSavedGame,
  loadSavedGame,
  parseSavedGame,
  peekSavedGame,
  saveGame,
  serializeGame,
} from "./savedGame";

const T0 = 1_700_000_000_000;

/** A game some way in: totals past what a `number` holds, damage, poison, a crown. */
function played(): GameState {
  let game = newGame({ ...setupFromFormat("commander"), timerSeconds: 60 }, T0);
  game = setLife(game, 0, LIFE_MAX, T0);
  game = setLife(game, 1, LIFE_MIN, T0);
  game = setDamage(game, 2, 3, 14, T0);
  return {
    ...game,
    seats: game.seats.map((s, k) => (k === 3 ? { ...s, poison: 7 } : s)),
    poisonOn: true,
    monarchOn: true,
    monarch: 2,
    turn: 1,
    turnNo: 6,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("the saved game", () => {
  it("reads back what it wrote, 64-bit totals and all", () => {
    const game = played();
    const back = parseSavedGame(serializeGame(game, T0 + 5));
    expect(back?.savedAt).toBe(T0 + 5);
    expect(back?.game.seats.map((s) => s.life)).toEqual([LIFE_MAX, LIFE_MIN, 26n, 40n]);
    // The deltas are not kept: a reload is longer than a fade.
    expect(back?.game.seats.every((s) => s.delta === 0n)).toBe(true);
    const { seats, ...rest } = game;
    const { seats: readSeats, ...readRest } = back!.game;
    expect(readRest).toEqual(rest);
    expect(readSeats.map((s) => s.poison)).toEqual(seats.map((s) => s.poison));
  });

  it("keeps the game in storage, and forgets it when asked", () => {
    saveGame(played(), T0 + 9);
    expect(loadSavedGame()?.turnNo).toBe(6);
    expect(peekSavedGame()).toMatchObject({ savedAt: T0 + 9, turnNo: 6, players: 4 });
    expect(peekSavedGame()?.setup.timerSeconds).toBe(60);
    clearSavedGame();
    expect(localStorage.getItem(SAVE_KEY)).toBeNull();
    expect(loadSavedGame()).toBeNull();
    expect(peekSavedGame()).toBeNull();
  });

  it.each([
    ["not JSON", "{ torn"],
    ["another version", JSON.stringify({ version: 2, savedAt: 1, game: {} })],
    ["no game", JSON.stringify({ version: 1, savedAt: 1 })],
  ])("ignores a payload that is %s", (_, text) => {
    localStorage.setItem(SAVE_KEY, text);
    expect(loadSavedGame()).toBeNull();
    expect(peekSavedGame()).toBeNull();
  });

  it("ignores a game whose parts do not agree", () => {
    const good = JSON.parse(serializeGame(played(), T0));
    const broken = [
      { ...good, game: { ...good.game, seats: good.game.seats.slice(1) } },
      { ...good, game: { ...good.game, dmg: good.game.dmg.slice(1) } },
      { ...good, game: { ...good.game, turn: 9 } },
      { ...good, game: { ...good.game, setup: { ...good.game.setup, players: 7 } } },
      {
        ...good,
        game: {
          ...good.game,
          seats: [
            { ...good.game.seats[0], life: "9223372036854775808" },
            ...good.game.seats.slice(1),
          ],
        },
      },
      {
        ...good,
        game: {
          ...good.game,
          seats: [{ ...good.game.seats[0], life: 40 }, ...good.game.seats.slice(1)],
        },
      },
    ];
    for (const payload of broken) expect(parseSavedGame(JSON.stringify(payload))).toBeNull();
  });

  it("goes on without storage", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("refused", "SecurityError");
    });
    expect(() => saveGame(played(), T0)).not.toThrow();
    expect(loadSavedGame()).toBeNull();
    expect(peekSavedGame()).toBeNull();
    expect(() => clearSavedGame()).not.toThrow();
  });
});
