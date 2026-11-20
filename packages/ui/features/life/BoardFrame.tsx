import { useEffect, useRef, type JSX } from "react";
import { cn } from "@/lib/utils";
import { LifeBoard } from "./board/LifeBoard";
import type { LifeGame } from "./setup/LifeSetupScreen";

/**
 * The box a board fills — `LifeBoard` measures its parent and fills it whole. **A landing pad**
 * (`tabIndex={-1}`, no outline: `@/lib/focus`'s rule) that takes the caret as the board comes up,
 * unless the board has put it somewhere already: the press that started the game is gone with the
 * setup, and a caret left on `<body>` restarts the tab order from the top of the app. Shared with
 * the phone face's page, which hands it its own placement.
 *
 * **A file of its own so the phone face can import it**: the desktop face's page reads the window's
 * caption (`components/TitleBar`), which the phone face's import fence refuses.
 */
export function BoardFrame({
  className,
  game,
  onLeave,
}: {
  className: string;
  game: LifeGame;
  onLeave: () => void;
}): JSX.Element {
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!frame.current?.contains(document.activeElement)) {
      frame.current?.focus({ preventScroll: true });
    }
  }, []);
  return (
    <div
      ref={frame}
      tabIndex={-1}
      data-testid="life-board-frame"
      className={cn("bg-bg outline-none", className)}
    >
      <LifeBoard setup={game.setup} resume={game.resume} onLeave={onLeave} />
    </div>
  );
}
