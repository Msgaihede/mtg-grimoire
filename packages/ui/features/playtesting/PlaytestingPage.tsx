import { useCallback, useState, type JSX } from "react";
import { useDeckWallMarks } from "@/features/decks/deckWall";
import { useDeckFolders } from "@/features/decks/useDeckFolders";
import { useDecks } from "@/features/decks/useDecks";
import { useDeckSort } from "@/features/decks/useDeckSort";
import { keepGame, keptGame } from "./keptGame";
import { holdGame, type HeldGame, type PlaytestPicks } from "./play/heldGame";
import { PlaytestPage } from "./play/PlaytestPage";
import { PlaytestSetup } from "./PlaytestSetup";

/**
 * The Playtesting view: a setup screen, and the game it starts — against the goldfish, one deck
 * or three.
 *
 * A file of its own so the router branch names a page — it was a `WorkInProgress` sentence, and
 * `App.tsx`'s branch did not change when it grew into this, which is what that placeholder was a
 * file of its own for. `App.tsx` loads it lazily, and the board with it (static here, so one
 * chunk: a session that never playtests fetches neither).
 *
 * **The board covers the window, the setup stays under it** (`PlaytestPage` is `fixed` at
 * `LAYER.stage`), so the way back — the back button, Escape, the result's Back — finds the setup
 * as it was left, its picks still made, and leaving that way puts the game away (asked first
 * while it is underway).
 *
 * **Going to another view does not** (issue #1322): the game is kept (`./keptGame.ts`), and this
 * page opens on it again when the reader comes back — the same board, the same log, an AI turn
 * that finished meanwhile already played.
 *
 * **The setup's wall is the Decks page's**, so it reads what that page reads: the folders, each
 * deck's colours and bracket (`useDeckWallMarks`), and the order the reader keeps the gallery in.
 * Every one of them is a query the gallery shares, so a reader arriving from Decks asks nothing new.
 */
export function PlaytestingPage(): JSX.Element {
  const { decks, query } = useDecks();
  const { folders } = useDeckFolders();
  const marks = useDeckWallMarks(decks);
  const { sort } = useDeckSort();
  const [playing, setPlaying] = useState<HeldGame | null>(keptGame);
  const start = useCallback((picks: PlaytestPicks) => {
    const game = holdGame(picks);
    game.start();
    keepGame(game);
    setPlaying(game);
  }, []);
  const back = useCallback(() => {
    playing?.end();
    keepGame(null);
    setPlaying(null);
  }, [playing]);
  const nameOf = (id: number) => decks.find((d) => d.id === id)?.name ?? "Deck";

  return (
    <>
      <PlaytestSetup
        decks={decks}
        folders={folders}
        marks={marks}
        sort={sort}
        loading={query.isPending}
        onStart={start}
      />
      {playing !== null && (
        <PlaytestPage
          picks={playing.picks}
          held={playing}
          deckName={nameOf(playing.picks.deckId)}
          // The goldfish has no deck to name it: its plate says what it is.
          opponentNames={
            playing.picks.opponents.length === 0
              ? ["Goldfish"]
              : playing.picks.opponents.map((o) => nameOf(o.deckId))
          }
          onBack={back}
        />
      )}
    </>
  );
}
