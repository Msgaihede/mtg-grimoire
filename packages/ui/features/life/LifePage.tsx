import { useState, type JSX } from "react";
import { PageBar } from "@/components/PageBar";
import { BELOW_CAPTION } from "@/components/TitleBar";
import { LAYER } from "@/lib/layers";
import { cn } from "@/lib/utils";
import { BoardFrame } from "./BoardFrame";
import { LifeSetupScreen, type LifeGame } from "./setup/LifeSetupScreen";

/**
 * The Life view on the light app's desktop face (1024px and wider): the setup in the page, under
 * the page title, and — once a game is started or continued — the board.
 *
 * **The board covers the window below the caption, at `LAYER.stage`**, as Playtesting's does
 * (`features/playtesting/play/PlaytestPage.tsx`): the game is the whole screen, the rail and the
 * header band under it, and every dialog, menu and toast the board or the shell opens still draws
 * above it. The window is also the width the seating is decided by — a setup that has not picked
 * faces one way from 1024px (`types.ts`' `resolveSeating`), which is this face's width, not its
 * `main`'s.
 *
 * **The way out is the board's**: its menu's end of the game asks "End this game?" and then calls
 * `onLeave`, the save already cleared, and the setup comes back with the caret on Start game.
 * **Browser Back just leaves the view** — this face lends its dialogs no Back step, so the board's
 * `useBackClaim` claims nothing here, and the URL moves as for any other view. The game is saved as
 * it is played, so the setup's *Continue game* brings it back, there or on the phone face.
 *
 * Light edition only: `App.tsx` draws this arm only where the edition has `life`, and loads it
 * lazily with the board — one chunk.
 */
export function LifePage(): JSX.Element {
  const [game, setGame] = useState<LifeGame | null>(null);
  const [returned, setReturned] = useState(false);
  if (game !== null) {
    return (
      <BoardFrame
        // **Below the header band whatever the edition says about caption buttons.** The light
        // edition has no window verbs (`caption: false`) but `TitleBar` still draws its 34px band
        // at `LAYER.caption`, above this frame — at `top-0` the band covered the board's top edge
        // and half of its menu button (measured at 1280 × 800, 2026-11-20).
        className={cn("fixed inset-x-0 bottom-0", BELOW_CAPTION, LAYER.stage)}
        game={game}
        onLeave={() => {
          setGame(null);
          setReturned(true);
        }}
      />
    );
  }
  return (
    <section className="flex h-full min-h-0 flex-col">
      <LifeSetupScreen
        frame="page"
        head={<PageBar title="Life" />}
        focusStart={returned}
        onPlay={setGame}
      />
    </section>
  );
}
