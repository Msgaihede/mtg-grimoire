import type { JSX } from "react";
import { BELOW_CAPTION } from "@/components/TitleBar";
import { useEdition } from "@/lib/edition";
import { LAYER } from "@/lib/layers";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { PlaytestBoard } from "./PlaytestBoard";
import { usePlaytestGame, type PlaytestPicks } from "./usePlaytestGame";

/**
 * The game board over the whole window: a game of the reader's deck against the goldfish, against
 * another of their decks, or against three of them at a four-player table, each deck opponent
 * played by phase.rs's AI (`crates/grimoire-play`'s `playtest`). One game on one board, whichever
 * it is (`picks.opponents` empty is the goldfish).
 *
 * **Opened from two places** (`returnTo`): the Playtesting page's setup screen mounts it once
 * Start is pressed, and the deck editor's "Goldfish this deck" through `../GoldfishPage.tsx`.
 * Either unmounts it on the way back, which puts the game away (`usePlaytestGame`'s
 * `playtestEnd`).
 *
 * **Below the caption, over the rail and `main` both, at `LAYER.stage`** — above the shell,
 * below every popup and dialog, so the board's own menus open over it and the caption stays
 * uncovered.
 *
 * **Escape is the way back** (the `Esc` on the back button), on the navigation rung, so a menu or
 * a dialog open over the board takes the key first. **While the opponent's turn is being played
 * back it skips the replay instead** — a reader pressing Escape then wants the animation gone,
 * not the game.
 */
export function PlaytestPage({
  picks,
  deckName,
  opponentNames,
  returnTo = "setup",
  onBack,
}: {
  picks: PlaytestPicks;
  deckName: string;
  /** Each opponent's name, in `picks.opponents`' order, for their plates: the deck's — or
   *  `["Goldfish"]` for the goldfish, which has no deck to name. */
  opponentNames: readonly string[];
  /** Where the board was opened from, which its way back returns to — `PlaytestBoard`'s own
   *  `returnTo`, passed on: the setup page (the default) or the deck editor. */
  returnTo?: "setup" | "deck";
  onBack: () => void;
}): JSX.Element {
  const game = usePlaytestGame(picks);
  const edition = useEdition();
  useDismissOnEscape({
    layer: "navigation",
    onDismiss: game.replaying ? game.skip : onBack,
  });

  return (
    <div
      role="region"
      aria-label={picks.opponents.length === 0 ? "Goldfish" : "Playtest"}
      className={cn(
        "fixed inset-x-0 bottom-0",
        edition.caption ? BELOW_CAPTION : "top-0",
        LAYER.stage,
      )}
    >
      <PlaytestBoard
        deckName={deckName}
        opponentNames={opponentNames}
        returnTo={returnTo}
        view={game.view}
        log={game.log}
        error={game.error}
        busy={game.busy}
        happened={game.lastHappened}
        replaying={game.replaying}
        onSkip={game.skip}
        onAct={game.act}
        onBack={onBack}
        onNewGame={game.newGame}
      />
    </div>
  );
}
