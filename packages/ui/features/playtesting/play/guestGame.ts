import {
  ipc,
  ipcError,
  type GuestGame,
  type PlaytestAction,
  type PlaytestHappened,
  type PlaytestStep,
} from "@/lib/ipc";
import { freshBook, writeLog } from "../undo";
import type { HeldBoard, HeldGame, HeldState, PlaytestPicks } from "./heldGame";
import { playtestLines } from "./log";
import { framesOf, replayEntries, type ReplayEntry } from "./useReplay";

/** What a guest's board draws: the held game's state, and the table the host said it sits at. */
export interface GuestHeldState extends HeldState {
  /** The opponents' names in the view's `opponents` order — a person's lobby name, or an AI
   *  seat's deck — as the last `lobby:game` gave them; empty before the first. */
  names: readonly string[];
  /** The guest's own deck's name, as the host read it; `""` before the first step. */
  deck: string;
  /** A step has arrived since the game was held: the board has something to show. */
  dealt: boolean;
}

/** A guest's held game: a {@link HeldGame} whose state also says who sits at the table. */
export interface GuestHeldGame extends HeldGame {
  readonly guest: true;
  state: () => GuestHeldState;
}

/**
 * A guest's picks, which deal nothing: the board is shown from what the host sends. A lobby with
 * no seats, so nothing reads it as the goldfish (`isGoldfish`).
 */
const GUEST_PICKS: PlaytestPicks = {
  deckId: 0,
  variant: "live",
  opponents: [],
  lobby: { seats: [], names: [] },
};

const NONE: readonly PlaytestHappened[] = [];

/** Whether `game` is a guest's — the Playtesting page keeps either kind in the one place. */
export function isGuestGame(game: HeldGame | null): game is GuestHeldGame {
  return game !== null && "guest" in game && game.guest === true;
}

/**
 * **A guest's game in a lobby** (issue #1419): the same {@link HeldGame} the board draws, fed by
 * the host rather than by an engine of its own. The host's app plays the whole game; this app is
 * sent its own seat's step (`lobby:game`, a {@link GuestGame}), and sends its actions back
 * (`lobbyAct`), whose answer arrives as the next `lobby:game` — or, refused, as `lobby:refused`,
 * the engine's sentence, shown as any refusal is.
 *
 * **Listened for from `start`, before anything is dealt**: the host may deal the moment the guest
 * has sent its deck, so the page holds this from the join on, and the first step it hears is the
 * one that shows the board (`dealt`). A step marked `dealt` starts a fresh log — the host dealt a
 * game — and every other is written on the log as it stands, a resend included (the engine's
 * facts are the step's, so a resend of a step already shown adds no lines).
 *
 * **`busy` from an action until the host answers it**: `lobbyAct` resolves once the action is
 * sent, not once it is played, so the wait is held here until a step or a refusal arrives — the
 * board says the table is thinking and offers nothing new meanwhile, which also keeps a second
 * action from naming cards the first has moved.
 *
 * **No undo, no sandbox, no replay**: the host refuses the first two in a lobby game, and a guest's
 * steps carry no frames (`frames: []`), so each is shown at once. **No New game either** — the
 * host deals; `newGame` does nothing.
 */
export function holdGuestGame(): GuestHeldGame {
  let state: GuestHeldState = {
    view: null,
    book: freshBook(),
    error: null,
    busy: false,
    lastHappened: NONE,
    names: [],
    deck: "",
    dealt: false,
  };
  const listeners = new Set<() => void>();
  const set = (next: (s: GuestHeldState) => Partial<GuestHeldState>) => {
    state = { ...state, ...next(state) };
    for (const listener of listeners) listener();
  };

  let live = false;
  let board: HeldBoard | null = null;
  let unlisten: (() => void)[] = [];

  const apply = (entry: ReplayEntry) =>
    set((s) => ({
      view: entry.view,
      lastHappened: entry.quiet || board === null ? NONE : entry.happened,
      book: writeLog(
        s.book,
        playtestLines(
          entry.happened,
          entry.view.turn,
          entry.view.opponents.length,
          entry.view.goldfish,
        ),
      ),
    }));

  const show = (step: PlaytestStep) => {
    const entries = replayEntries(step, framesOf(step));
    if (board !== null) board.play(entries);
    else for (const entry of entries) apply({ ...entry, quiet: true });
  };

  const hear = (game: GuestGame) => {
    if (!live) return;
    if (game.dealt) {
      board?.cancel();
      const line =
        game.step.view.opponents.length > 1
          ? "Shuffled every deck and drew seven"
          : "Shuffled both decks and drew seven";
      set(() => ({
        book: freshBook([{ turn: 0, text: line, kind: "deal" }]),
        lastHappened: NONE,
      }));
    }
    set(() => ({ names: game.names, deck: game.deck, dealt: true, error: null, busy: false }));
    board?.skip();
    show(game.step);
  };

  return {
    guest: true,
    picks: GUEST_PICKS,
    key: "lobby-guest",
    state: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => {
      if (live) return;
      live = true;
      unlisten = [
        ipc.onLobbyGame(hear),
        ipc.onLobbyRefused((reason) => {
          if (live) set(() => ({ error: reason, busy: false }));
        }),
      ];
    },
    live: () => live,
    inPlay: () => live && state.view !== null && state.view.stage !== "over",
    apply,
    act: (action: PlaytestAction) => {
      if (!live) return;
      board?.skip();
      set(() => ({ busy: true, error: null }));
      ipc.lobbyAct(action).catch((e: unknown) => {
        if (live) set(() => ({ error: ipcError(e), busy: false }));
      });
    },
    newGame: () => {},
    end: () => {
      if (!live) return;
      live = false;
      board?.cancel();
      for (const off of unlisten) off();
      unlisten = [];
      set(() => ({ busy: false }));
    },
    attach: (shown) => {
      board = shown;
      return () => {
        if (board === shown) {
          shown.skip();
          board = null;
          set(() => ({ lastHappened: NONE }));
        }
      };
    },
  };
}
