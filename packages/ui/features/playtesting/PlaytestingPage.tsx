import { useCallback, useState, type JSX } from "react";
import { useDecks } from "@/features/decks/useDecks";
import { PlaytestPage } from "./play/PlaytestPage";
import type { PlaytestPicks } from "./play/usePlaytestGame";
import { PlaytestSetup } from "./PlaytestSetup";

/**
 * The Playtesting view: a setup screen, and the game it starts.
 *
 * A file of its own so the router branch names a page — it was a `WorkInProgress` sentence, and
 * `App.tsx`'s branch did not change when it grew into this, which is what that placeholder was a
 * file of its own for. `App.tsx` loads it lazily, and the board with it (static here, so one
 * chunk: a session that never playtests fetches neither).
 *
 * **The board covers the window, the setup stays under it** (`PlaytestPage` is `fixed` at
 * `LAYER.stage`), so the way back — the back button, Escape, the result's Back — finds the setup
 * as it was left, its picks still made, and leaving puts the game away.
 */
export function PlaytestingPage(): JSX.Element {
  const { decks, query } = useDecks();
  const [playing, setPlaying] = useState<PlaytestPicks | null>(null);
  const back = useCallback(() => setPlaying(null), []);
  const nameOf = (id: number) => decks.find((d) => d.id === id)?.name ?? "Deck";

  return (
    <>
      <PlaytestSetup decks={decks} loading={query.isPending} onStart={setPlaying} />
      {playing !== null && (
        <PlaytestPage
          picks={playing}
          deckName={nameOf(playing.deckId)}
          opponentNames={playing.opponents.map((o) => nameOf(o.deckId))}
          onBack={back}
        />
      )}
    </>
  );
}
