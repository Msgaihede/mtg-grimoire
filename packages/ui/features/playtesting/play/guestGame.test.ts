import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestGame, PlaytestAction } from "@/lib/ipc";
import { lobbyWaiting, openingHand, turnFive } from "./fixtures";
import { holdGuestGame, isGuestGame } from "./guestGame";
import { holdGame, isGoldfish } from "./heldGame";

// The host's two pushes, caught so a test can play them; `lobbyAct` is what a guest's board sends.
const pushes = vi.hoisted(() => ({
  game: null as ((g: GuestGame) => void) | null,
  refused: null as ((reason: string) => void) | null,
  offGame: vi.fn(),
  offRefused: vi.fn(),
}));
const lobbyAct = vi.hoisted(() => vi.fn<(action: PlaytestAction) => Promise<void>>());

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    lobbyAct,
    onLobbyGame: (cb: (g: GuestGame) => void) => {
      pushes.game = cb;
      return pushes.offGame;
    },
    onLobbyRefused: (cb: (reason: string) => void) => {
      pushes.refused = cb;
      return pushes.offRefused;
    },
  },
}));

const dealt = (): GuestGame => ({
  step: {
    view: { ...openingHand(), lobby: true },
    happened: [{ type: "drew", seat: "opponent", name: null }],
    frames: [],
  },
  names: ["Ada"],
  deck: "Simic Tempo",
  dealt: true,
});

beforeEach(() => {
  pushes.game = null;
  pushes.refused = null;
  pushes.offGame.mockReset();
  pushes.offRefused.mockReset();
  lobbyAct.mockReset().mockResolvedValue(undefined);
});

describe("holdGuestGame", () => {
  it("listens from start, before anything is dealt, and shows the board on the first step", () => {
    const game = holdGuestGame();
    expect(pushes.game).toBeNull();
    game.start();
    expect(game.live()).toBe(true);
    expect(game.state().dealt).toBe(false);
    pushes.game?.(dealt());
    const state = game.state();
    expect(state.dealt).toBe(true);
    expect(state.view?.stage).toBe("mulligan");
    expect(state.names).toEqual(["Ada"]);
    expect(state.deck).toBe("Simic Tempo");
    expect(state.book.log.map((l) => l.text)).toEqual([
      "The opponent drew a card",
      "Shuffled both decks and drew seven",
    ]);
  });

  it("writes a later step on the log as it stands, and a new deal on a fresh one", () => {
    const game = holdGuestGame();
    game.start();
    pushes.game?.(dealt());
    pushes.game?.({
      step: {
        view: { ...lobbyWaiting().view },
        happened: [{ type: "turnBegan", turn: 5, seat: "opponent" }],
        frames: [],
      },
      names: ["Ada"],
      deck: "Simic Tempo",
      dealt: false,
    });
    expect(game.state().view?.stage).toBe("waiting");
    expect(game.state().book.log).toHaveLength(3);
    pushes.game?.(dealt());
    expect(game.state().book.log).toHaveLength(2);
  });

  it("sends an action to the host, busy until its answer or its refusal arrives", () => {
    const game = holdGuestGame();
    game.start();
    pushes.game?.(dealt());
    game.act({ type: "keep", bottom: [] });
    expect(lobbyAct).toHaveBeenCalledWith({ type: "keep", bottom: [] });
    expect(game.state().busy).toBe(true);
    pushes.refused?.("It is not your turn.");
    expect(game.state()).toMatchObject({ busy: false, error: "It is not your turn." });
    game.act({ type: "pass" });
    expect(game.state()).toMatchObject({ busy: true, error: null });
    pushes.game?.({
      ...dealt(),
      step: { view: turnFive().view, happened: [], frames: [] },
      dealt: false,
    });
    expect(game.state().busy).toBe(false);
  });

  it("says a send that failed, and waits no longer", async () => {
    lobbyAct.mockRejectedValue("The lobby has closed.");
    const game = holdGuestGame();
    game.start();
    game.act({ type: "pass" });
    await vi.waitFor(() => expect(game.state().error).toBe("The lobby has closed."));
    expect(game.state().busy).toBe(false);
  });

  it("stops listening when put away, and hears nothing after", () => {
    const game = holdGuestGame();
    game.start();
    game.end();
    expect(pushes.offGame).toHaveBeenCalled();
    expect(pushes.offRefused).toHaveBeenCalled();
    expect(game.live()).toBe(false);
    pushes.game?.(dealt());
    expect(game.state().dealt).toBe(false);
  });

  it("is told apart from the host's game, and is never the goldfish", () => {
    const guest = holdGuestGame();
    const own = holdGame({ deckId: 1, variant: "live", opponents: [] });
    expect(isGuestGame(guest)).toBe(true);
    expect(isGuestGame(own)).toBe(false);
    expect(isGoldfish(guest.picks)).toBe(false);
    expect(isGoldfish(own.picks)).toBe(true);
    // A guest's game is never dealt again on its side.
    guest.start();
    guest.newGame();
    expect(guest.state().view).toBeNull();
  });
});
