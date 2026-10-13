import type { JSX } from "react";
import { BELOW_CAPTION } from "@/components/TitleBar";
import { useEdition } from "@/lib/edition";
import { LAYER } from "@/lib/layers";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { PlaytestBoard } from "./PlaytestBoard";
import { usePlaytestGame, type PlaytestPicks } from "./usePlaytestGame";

/**
 * The playtest board over the whole window: a game of the reader's deck against another of their
 * decks, the opponent played by phase.rs's AI (`crates/grimoire-play`'s `playtest`).
 *
 * **`GoldfishPage`'s frame**: below the caption, over the rail and `main` both, at `LAYER.stage`
 * — above the shell, below every popup and dialog, so the board's own menus open over it. The
 * Playtesting page's setup screen mounts it once Start is pressed and unmounts it on the way
 * back, which puts the game away (`usePlaytestGame`'s `playtestEnd`).
 *
 * **Escape is the way back** (the `Esc` on the back button), on the navigation rung, so a menu or
 * a dialog open over the board takes the key first.
 */
export function PlaytestPage({
  picks,
  deckName,
  opponentName,
  onBack,
}: {
  picks: PlaytestPicks;
  deckName: string;
  opponentName: string;
  onBack: () => void;
}): JSX.Element {
  const game = usePlaytestGame(picks);
  const edition = useEdition();
  useDismissOnEscape({ layer: "navigation", onDismiss: onBack });

  return (
    <div
      role="region"
      aria-label="Playtest"
      className={cn(
        "fixed inset-x-0 bottom-0",
        edition.caption ? BELOW_CAPTION : "top-0",
        LAYER.stage,
      )}
    >
      <PlaytestBoard
        deckName={deckName}
        opponentName={opponentName}
        view={game.view}
        log={game.log}
        error={game.error}
        busy={game.busy}
        onAct={game.act}
        onBack={onBack}
        onNewGame={game.newGame}
      />
    </div>
  );
}
