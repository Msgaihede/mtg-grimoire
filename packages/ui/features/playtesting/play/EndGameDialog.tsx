import type { JSX, ReactNode } from "react";
import { Dialog } from "@/components/Dialog";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * **The question before a game underway is put away** (issue #1322): the board's way back, its
 * New game, and the deck editor's goldfish dealt over the Playtesting page's game. A game is kept
 * until the reader ends it, so the one press that ends it asks first — a game the engine has
 * ended (`over`) is not asked about, there is nothing left of it to lose.
 *
 * **Every way out of the question keeps the game**: Escape, the ✕ and a click outside are all
 * `onCancel`, and only the destructive button, which says what it does, ends it.
 */
export function EndGameDialog({
  open,
  title,
  confirmLabel,
  cancelLabel = "Keep playing",
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** The sentence that says what is lost. */
  children: ReactNode;
}): JSX.Element {
  return (
    <Dialog
      open={open}
      title={title}
      closeLabel="Close"
      size="w-[26rem]"
      onDismiss={onCancel}
      onClose={onCancel}
    >
      <div className="flex flex-col gap-4 px-5 py-4">
        <p className="m-0 text-sm leading-relaxed text-dim">{children}</p>
        <div className="flex justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className={cn(
              "inline-flex h-9 items-center rounded-full border border-border bg-surface px-4",
              "text-[13px] text-text transition-colors motion-reduce:transition-none hover:border-accent",
              PRESS,
              FOCUS,
            )}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={cn(
              "inline-flex h-9 items-center rounded-full border border-destructive bg-surface px-4",
              "text-[13px] font-semibold text-destructive transition-colors motion-reduce:transition-none",
              "hover:bg-destructive hover:text-bg",
              PRESS,
              FOCUS,
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
