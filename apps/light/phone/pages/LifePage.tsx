import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { BoardFrame } from "@grimoire/ui/features/life/BoardFrame";
import { LifeSetupScreen, type LifeGame } from "@grimoire/ui/features/life/setup/LifeSetupScreen";
import { setImmersive } from "@grimoire/ui/lib/core/hostImmersive";
import { LAYER } from "@grimoire/ui/lib/layers";
import { cn } from "@grimoire/ui/lib/utils";

/**
 * The Life tracker on the phone face: the shared setup inside the `Shell`, as every page is drawn,
 * and — once Start game or Continue game is pressed — **the board over the whole screen**.
 *
 * **Over the header and the tab bar**: `fixed inset-0` at `LAYER.stage`, which neither bar takes a
 * rung for, and below every dialog (`overlay`), menu (`popup`) and toast — so the board's own
 * menus and its "End this game?" question, the card sheet and the face's toasts still draw above
 * it. It fills the safe area (padded by every `env()` inset, which the Android host's own padding
 * makes 0 there), and the board fills it.
 *
 * **Immersive while the board is up** (the owner's request, 2026-11-20; issue #1716): the system
 * bars are put away, the rotation the board came up in is held and the screen is kept on, from the
 * press that brought the board up — a browser grants full screen only during a press, so it is
 * asked in the handler and not in an effect — and all three are let go when the board goes, when
 * the page is left, and on `pagehide`. The setup is never held: its Layout pictures are drawn in
 * the window's shape, so the reader turns the phone there and the board keeps that shape.
 * `@grimoire/ui/lib/core/hostImmersive` is where the hosts differ about how; this page never asks
 * which it is on.
 *
 * **Back is the board's** (the owner's decision: Back goes back to the menu, with a confirmation,
 * so a game is never lost by accident). The board claims a Back step while it is up
 * (`useBackClaim`, which this face's `DialogHost` answers with an entry in `sheetHistory.ts`), and
 * Android's gesture — or a browser's button — lands on its "End this game?" question rather than
 * on the page beneath. Confirming ends the game and calls `onLeave`; the setup comes back, the
 * caret on Start game. Nothing else on the face takes that Back first: the entry is pushed at the
 * address the reader is on, so the router sees the same place either side of it, and the tab bar
 * that would move the reader is under the board.
 *
 * **A page that goes any other way keeps the game** — a card link, a crossing to the desktop face
 * at 1024px: the board saves as it is played, and the setup's *Continue game* brings it back.
 */
export function LifePage() {
  const [game, setGame] = useState<LifeGame | null>(null);
  const [returned, setReturned] = useState(false);
  const playing = game !== null;

  // The bars, the rotation and the screen's sleep come back however the board goes: unmounted with
  // the page, or the page hidden for good. Turning immersive *on* is the press's, below.
  useEffect(() => {
    if (!playing) return;
    const restore = () => setImmersive(false);
    window.addEventListener("pagehide", restore);
    return () => {
      window.removeEventListener("pagehide", restore);
      restore();
    };
  }, [playing]);

  return (
    <>
      {/* The board rises over the setup and sinks back to it (`BoardFrame`): held in a presence,
          so the setup is drawn again beneath it as it goes. */}
      <AnimatePresence>
        {game !== null && (
          <BoardFrame
            key="board"
            className={cn(
              "fixed inset-0",
              "pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]",
              LAYER.stage,
            )}
            game={game}
            onLeave={() => {
              setGame(null);
              setReturned(true);
            }}
          />
        )}
      </AnimatePresence>
      {game === null && (
        <LifeSetupScreen
          frame="phone"
          focusStart={returned}
          onPlay={(next) => {
            // Inside the press: a browser's Fullscreen API answers only to one.
            setImmersive(true);
            setGame(next);
          }}
        />
      )}
    </>
  );
}
