import { useCallback, useState, type JSX } from "react";
import { useDeckWallMarks } from "@/features/decks/deckWall";
import { useDeckFolders } from "@/features/decks/useDeckFolders";
import { useDecks } from "@/features/decks/useDecks";
import { useDeckSort } from "@/features/decks/useDeckSort";
import { PlaytestPage } from "./play/PlaytestPage";
import type { PlaytestPicks } from "./play/usePlaytestGame";
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
 * as it was left, its picks still made, and leaving puts the game away.
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
  const [playing, setPlaying] = useState<PlaytestPicks | null>(null);
  const back = useCallback(() => setPlaying(null), []);
  const nameOf = (id: number) => decks.find((d) => d.id === id)?.name ?? "Deck";

  return (
    <>
      <PlaytestSetup
        decks={decks}
        folders={folders}
        marks={marks}
        sort={sort}
        loading={query.isPending}
        onStart={setPlaying}
      />
      {playing !== null && (
        <PlaytestPage
          picks={playing}
          deckName={nameOf(playing.deckId)}
          // The goldfish has no deck to name it: its plate says what it is.
          opponentNames={
            playing.opponents.length === 0
              ? ["Goldfish"]
              : playing.opponents.map((o) => nameOf(o.deckId))
          }
          onBack={back}
        />
      )}
    </>
  );
}
