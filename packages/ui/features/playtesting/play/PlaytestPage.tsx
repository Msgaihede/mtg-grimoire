import { useState, type JSX } from "react";
import { BELOW_CAPTION } from "@/components/TitleBar";
import { useEdition } from "@/lib/edition";
import { LAYER } from "@/lib/layers";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { useTableSounds } from "../sound/useTableSounds";
import { EndGameDialog } from "./EndGameDialog";
import type { HeldGame } from "./heldGame";
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
 * The Playtesting page passes the game it keeps (`held`), which outlives the board when the reader
 * goes to another view (issue #1322); the goldfish passes none, and its board's leaving puts its
 * game away (`usePlaytestGame`).
 *
 * **The way back and New game ask first while the game is underway** (`EndGameDialog`): either
 * one puts the game away for good. A game the engine has ended, or one still being dealt, is left
 * at once.
 *
 * **Below the caption, over the rail and `main` both, at `LAYER.stage`** — above the shell,
 * below every popup and dialog, so the board's own menus open over it and the caption stays
 * uncovered.
 *
 * **Escape is the way back** (the `Esc` on the back button), on the navigation rung, so a menu or
 * a dialog open over the board takes the key first. **While the opponent's turn is being played
 * back it skips the replay instead** — a reader pressing Escape then wants the animation gone,
 * not the game.
 *
 * **The board's sounds are made here** (`../sound/useTableSounds`), from the game's beats and
 * the board's actions, for both ways onto it; the board draws only their mute button.
 */
export function PlaytestPage({
  picks,
  deckName,
  opponentNames,
  returnTo = "setup",
  held,
  onBack,
}: {
  picks: PlaytestPicks;
  /** The game to show, kept by the caller beyond the board's life; none, and the board deals
   *  and ends a game of its own. */
  held?: HeldGame;
  deckName: string;
  /** Each opponent's name, in `picks.opponents`' order, for their plates: the deck's — or
   *  `["Goldfish"]` for the goldfish, which has no deck to name. */
  opponentNames: readonly string[];
  /** Where the board was opened from, which its way back returns to — `PlaytestBoard`'s own
   *  `returnTo`, passed on: the setup page (the default) or the deck editor. */
  returnTo?: "setup" | "deck";
  onBack: () => void;
}): JSX.Element {
  const game = usePlaytestGame(picks, held);
  // Every action the board takes goes through the sounds, so a press can sound and its answer
  // be heard with what it was.
  const act = useTableSounds(game.lastHappened, game.act);
  const edition = useEdition();
  /** Which way out is being asked about — kept while the question closes, so its words stay. */
  const [asking, setAsking] = useState<"back" | "newGame">("back");
  const [open, setOpen] = useState(false);
  const underway = game.view !== null && game.view.stage !== "over";
  const ask = (what: "back" | "newGame") => {
    setAsking(what);
    setOpen(true);
  };
  const back = () => (underway ? ask("back") : onBack());
  const newGame = () => (underway ? ask("newGame") : game.newGame());
  const confirm = () => {
    setOpen(false);
    if (asking === "back") onBack();
    else game.newGame();
  };
  useDismissOnEscape({
    layer: "navigation",
    onDismiss: game.replaying ? game.skip : back,
    enabled: !open,
  });
  const goldfish = picks.opponents.length === 0;

  return (
    <>
      <div
        role="region"
        aria-label={goldfish ? "Goldfish" : "Playtest"}
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
          onAct={act}
          onBack={back}
          onNewGame={newGame}
        />
      </div>
      <EndGameDialog
        open={open}
        title={asking === "newGame" ? "Start a new game?" : "End this game?"}
        confirmLabel={asking === "newGame" ? "New game" : "End game"}
        onConfirm={confirm}
        onCancel={() => setOpen(false)}
      >
        {asking === "newGame"
          ? `This game is put away for good, and a new one is dealt from the same ${goldfish ? "deck" : "decks"}.`
          : held === undefined
            ? "This game is put away for good."
            : "This game is put away for good. To come back to it later, go to another page instead: the game is kept until you end it."}
      </EndGameDialog>
    </>
  );
}
