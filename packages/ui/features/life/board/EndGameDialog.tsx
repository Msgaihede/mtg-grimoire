import { useEffect, useRef } from "react";
import { Dialog } from "@/components/Dialog";
import { cn } from "@/lib/utils";
import { PANEL_BUTTON } from "@/features/settings/controls";

/** The two questions the board asks before it throws a game away. */
export type EndAsk = "leave" | "restart";

const WORDS: Record<EndAsk, { title: string; body: string; confirm: string }> = {
  leave: {
    title: "End this game?",
    body: "Life totals and counters are lost.",
    confirm: "End game",
  },
  restart: {
    title: "Restart this game?",
    body: "Life totals and counters go back to the start. The menu’s switches stay as they are.",
    confirm: "Restart",
  },
};

/**
 * **Back returns to the setup, and never deletes a game by accident** — the owner's request: on a
 * phone, Back is the gesture a thumb makes without looking, and a table four turns into a game is
 * one stray swipe from losing every total. So Back on the board, *End game and change setup* and
 * *Restart with the same setup* all ask, and the safe answer — *Keep playing* — holds the caret,
 * so Enter, Escape and Back again all keep the game.
 *
 * On the shared `Dialog`, which claims its own Back step and handles Escape and the caret; drawn
 * window-wide and upright, outside the board, since it is a question for the whole table.
 */
export function EndGameDialog({
  ask,
  onKeep,
  onConfirm,
}: {
  ask: EndAsk | null;
  onKeep: () => void;
  onConfirm: (ask: EndAsk) => void;
}) {
  const words = ask ? WORDS[ask] : WORDS.leave;
  return (
    <Dialog
      open={ask !== null}
      title={words.title}
      closeLabel="Close"
      size="w-[24rem]"
      onDismiss={onKeep}
      onClose={onKeep}
    >
      {ask && <Body ask={ask} onKeep={onKeep} onConfirm={onConfirm} />}
    </Dialog>
  );
}

function Body({
  ask,
  onKeep,
  onConfirm,
}: {
  ask: EndAsk;
  onKeep: () => void;
  onConfirm: (ask: EndAsk) => void;
}) {
  const keepRef = useRef<HTMLButtonElement>(null);
  // The safe answer holds the caret. `Dialog` stands down when its body has already placed it.
  useEffect(() => {
    keepRef.current?.focus();
  }, []);
  const words = WORDS[ask];
  return (
    <div className="space-y-4 p-4 pt-0 text-sm">
      <p className="leading-relaxed text-dim">{words.body}</p>
      <div className="flex justify-end gap-2">
        <button ref={keepRef} type="button" onClick={onKeep} className={PANEL_BUTTON}>
          Keep playing
        </button>
        <button
          type="button"
          onClick={() => onConfirm(ask)}
          className={cn(
            PANEL_BUTTON,
            "border-destructive text-destructive hover:bg-destructive hover:text-bg",
          )}
        >
          {words.confirm}
        </button>
      </div>
    </div>
  );
}
