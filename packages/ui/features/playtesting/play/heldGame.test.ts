import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostStep, PlaytestStep } from "@/lib/ipc";
import { lobbyWaiting, openingHand, turnFive } from "./fixtures";
import { holdGame, picksKey, type PlaytestPicks } from "./heldGame";

// A lobby game is the host's (issue #1419): dealt by `lobbyGameStart`, acted on by
// `playtestAct`, and moved by its guests' actions through `playtest:step`.
const { lobbyGameStart, playtestStart, playtestAct, playtestEnd, pushed, off } = vi.hoisted(() => ({
  lobbyGameStart: vi.fn<(...args: unknown[]) => Promise<PlaytestStep>>(),
  playtestStart: vi.fn<(...args: unknown[]) => Promise<PlaytestStep>>(),
  playtestAct: vi.fn<(...args: unknown[]) => Promise<PlaytestStep>>(),
  playtestEnd: vi.fn<(game: number) => Promise<void>>(),
  pushed: { cb: null as ((step: HostStep) => void) | null },
  off: vi.fn(),
}));

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    lobbyGameStart,
    playtestStart,
    playtestAct,
    playtestEnd,
    onPlaytestStep: (cb: (step: HostStep) => void) => {
      pushed.cb = cb;
      return off;
    },
  },
}));

const LOBBY: PlaytestPicks = {
  deckId: 7,
  variant: "theory",
  opponents: [],
  difficulty: "hard",
  lobby: {
    seats: [
      { peer: "p1", deckId: null, variant: null },
      { peer: null, deckId: 9, variant: "live" },
      { peer: null, deckId: 11, variant: "theory" },
    ],
    names: ["Bea", "Boros Aggro", "Kenrith Pod"],
  },
};

const step = (view = openingHand()): PlaytestStep => ({ view, happened: [], frames: [] });

beforeEach(() => {
  lobbyGameStart.mockReset().mockResolvedValue(step({ ...openingHand(), lobby: true }));
  playtestStart.mockReset();
  playtestAct.mockReset();
  playtestEnd.mockReset().mockResolvedValue(undefined);
  pushed.cb = null;
  off.mockReset();
});

describe("a lobby game held by its host", () => {
  it("is dealt by lobbyGameStart from the seats, with a fresh seed, never by playtestStart", async () => {
    const game = holdGame(LOBBY);
    game.start();
    await vi.waitFor(() => expect(game.state().view?.stage).toBe("mulligan"));
    expect(playtestStart).not.toHaveBeenCalled();
    expect(lobbyGameStart).toHaveBeenCalledWith(
      expect.any(Number),
      7,
      "theory",
      LOBBY.lobby?.seats,
      "hard",
      expect.any(Number),
    );
    expect(game.state().book.log.map((l) => l.text)).toEqual([
      "Shuffled every deck and drew seven",
    ]);
  });

  it("shows a step a guest's action pushed for its own game, and no other game's", async () => {
    const game = holdGame(LOBBY);
    game.start();
    await vi.waitFor(() => expect(game.state().view).not.toBeNull());
    const named = lobbyGameStart.mock.calls[0][0] as number;
    pushed.cb?.({ game: named + 1, step: step(turnFive().view) });
    expect(game.state().view?.stage).toBe("mulligan");
    pushed.cb?.({ game: named, step: step(lobbyWaiting().view) });
    expect(game.state().view?.stage).toBe("waiting");
  });

  it("is never dealt again, and stops listening when put away", async () => {
    const game = holdGame(LOBBY);
    game.start();
    await vi.waitFor(() => expect(game.state().view).not.toBeNull());
    game.newGame();
    expect(lobbyGameStart).toHaveBeenCalledTimes(1);
    expect(game.state().view).not.toBeNull();
    game.end();
    expect(off).toHaveBeenCalled();
    expect(playtestEnd).toHaveBeenCalledWith(lobbyGameStart.mock.calls[0][0]);
  });

  it("keys on the seats too, so another table is another game", () => {
    const other: PlaytestPicks = {
      ...LOBBY,
      lobby: { seats: [{ peer: "p2", deckId: null, variant: null }], names: ["Cy"] },
    };
    expect(picksKey(other)).not.toBe(picksKey(LOBBY));
    expect(picksKey({ ...LOBBY, lobby: undefined })).not.toBe(picksKey(LOBBY));
  });
});
