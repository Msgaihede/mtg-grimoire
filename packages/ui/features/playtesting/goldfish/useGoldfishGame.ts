import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, ipcError, type DeckVariant, type GoldfishAction, type GoldfishView } from "@/lib/ipc";
import { appendLog, linesFor, type LogLine } from "./log";

/**
 * One goldfish game's life on the page: dealt when the board mounts, put away when it leaves, and
 * every action in between sent **one at a time, in the order the reader made them**.
 *
 * **Serial, because an action names cards by the ids of the view it was made on** (`GameCard.id`
 * is a new id after every zone change, CR 400.7). Two drags fired before the first answer would
 * otherwise race, and the second would name a card the first had already moved. Chained instead:
 * each waits for the one before it, and one that names a card no longer there is refused by the
 * engine in a sentence — shown, and the board redrawn from the view that came back with the last
 * answer, so nothing is lost but that one action.
 *
 * **A new game is a new seed** (`crypto.getRandomValues`), which is the shuffle: the engine deals
 * the same game from the same seed, which its own tests rely on and a reader never wants.
 */
export interface GoldfishGame {
  /** `null` until the first deal answers, and while a new game is being dealt. */
  view: GoldfishView | null;
  log: LogLine[];
  /** The last refusal, until the next action. One sentence, the engine's. */
  error: string | null;
  /** An action is with the engine. */
  busy: boolean;
  act: (action: GoldfishAction) => void;
  newGame: () => void;
}

function freshSeed(): number {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  // A JS number holds 53 bits exactly; the engine takes a u64 and any of those is one.
  return words[0] * 2 ** 21 + (words[1] >>> 11);
}

export function useGoldfishGame(deckId: number, variant: DeckVariant): GoldfishGame {
  const [view, setView] = useState<GoldfishView | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The chain every action waits its turn on. */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /**
   * Which deal the page is on. An answer from an older one — a deal that StrictMode's second
   * mount replaced, an action sent before "New game" — is dropped rather than drawn.
   */
  const generation = useRef(0);
  const pending = useRef(0);

  /** Ask the engine for a game; its answer is drawn only if `mine` is still the page's deal. */
  const request = useCallback(
    (mine: number) => {
      queue.current = queue.current
        .catch(() => undefined)
        .then(() => ipc.goldfishStart(deckId, variant, freshSeed()))
        .then(
          (dealt) => {
            if (mine !== generation.current) return;
            setView(dealt);
            setLog([{ turn: 0, text: "Shuffled and drew seven" }]);
          },
          (e: unknown) => {
            if (mine === generation.current) setError(ipcError(e));
          },
        );
    },
    [deckId, variant],
  );

  /** The game menu's New game: clear the board, then deal. An event, so its resets are not an
   *  effect's — the mount below needs none, since a fresh hook already starts empty. */
  const newGame = useCallback(() => {
    const mine = ++generation.current;
    setView(null);
    setError(null);
    setLog([]);
    request(mine);
  }, [request]);

  useEffect(() => {
    // The ref object, not its value: the cleanup must bump the counter the next deal reads.
    const deals = generation;
    request(++deals.current);
    return () => {
      deals.current++;
      void ipc.goldfishEnd().catch(() => undefined);
    };
  }, [request]);

  const act = useCallback((action: GoldfishAction) => {
    const mine = generation.current;
    pending.current++;
    setBusy(true);
    queue.current = queue.current
      .catch(() => undefined)
      .then(() => ipc.goldfishAct(action))
      .then(
        (step) => {
          if (mine !== generation.current) return;
          setError(null);
          setView(step.view);
          setLog((old) => appendLog(old, linesFor(step.happened, step.view.turn)));
        },
        (e: unknown) => {
          if (mine === generation.current) setError(ipcError(e));
        },
      )
      .finally(() => {
        pending.current--;
        if (pending.current === 0) setBusy(false);
      });
  }, []);

  return { view, log, error, busy, act, newGame };
}
