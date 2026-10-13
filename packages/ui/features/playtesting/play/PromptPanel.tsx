import type { JSX, MouseEvent } from "react";
import type { GameCard, PlaytestAction, PlaytestPrompt } from "@/lib/ipc";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { CardFace } from "../goldfish/Inspect";
import { cardOfRef, optionLabel, promptTitle } from "./prompt";

/**
 * The engine's question, beside the table — `stage: "prompt"`.
 *
 * **A panel, not a dialog.** A target is chosen by looking at the table: the panel takes no scrim
 * and holds no focus trap, the board under it stays pointable (a row hovered points its card, and
 * the preview opens as it does on the table), and an answer that names one card on the table is
 * also that card, clickable where it lies (`tablePicks`).
 *
 * **"Let the engine choose" is always there** (`auto`): phase's engine has well over a hundred
 * kinds of question, and a kind whose answers the board cannot draw — none sent, or none it can
 * name — is still one the reader can get past. Cancel only when the question came out of the
 * reader's own cast or activation, which it takes back.
 */
export function PromptPanel({
  prompt,
  table,
  disabled,
  onAct,
  onPoint,
  onUnpoint,
  className,
}: {
  prompt: PlaytestPrompt;
  /** Every card on both tables, so a row names the card as it lies (its state, its counters). */
  table: readonly GameCard[];
  /** An action is with the engine: nothing more can be sent until it answers. */
  disabled: boolean;
  onAct: (action: PlaytestAction) => void;
  onPoint: (card: GameCard, e: MouseEvent) => void;
  onUnpoint: () => void;
  className?: string;
}): JSX.Element {
  const title = promptTitle(prompt.kind);
  return (
    <section
      aria-label={title}
      className={cn(
        "flex w-[300px] flex-col overflow-hidden rounded-xl border border-accent bg-surface shadow-lg",
        LAYER.raised,
        className,
      )}
    >
      <header className="flex flex-col gap-0.5 border-b border-border px-3.5 py-2.5">
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        {prompt.source !== null && <span className="text-xs text-dim">{prompt.source}</span>}
      </header>

      {prompt.options.length === 0 ? (
        <p className="m-0 px-3.5 py-3 text-[13px] text-dim">
          The board can’t show this choice. Let the engine choose for you
          {prompt.cancellable ? ", or cancel." : "."}
        </p>
      ) : (
        <ul className="m-0 flex min-h-0 list-none flex-col gap-1 overflow-y-auto p-2">
          {prompt.options.map((option) => {
            const { text, hint } = optionLabel(option, prompt);
            const cards = option.cards.map((ref) => cardOfRef(ref, table));
            const first = cards[0];
            return (
              <li key={option.index}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onUnpoint();
                    onAct({ type: "choose", index: option.index });
                  }}
                  onMouseEnter={first === undefined ? undefined : (e) => onPoint(first, e)}
                  onMouseLeave={first === undefined ? undefined : onUnpoint}
                  data-point={first?.id}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg border border-transparent px-2 py-1.5 text-left text-[13px]",
                    "transition-colors motion-reduce:transition-none hover:border-accent disabled:opacity-45",
                    FOCUS,
                  )}
                >
                  {cards.slice(0, 3).map((card) => (
                    <span key={card.id} aria-hidden="true" className="h-[42px] w-[30px] flex-none">
                      <CardFace card={card} />
                    </span>
                  ))}
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{text}</span>
                    {hint !== null && <span className="text-xs text-dim">{hint}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <footer className="flex flex-wrap justify-end gap-2 border-t border-border px-3 py-2.5">
        {prompt.cancellable && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAct({ type: "cancel" })}
            className={cn(FOOTER_BUTTON, "border-border text-text hover:border-accent")}
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onAct({ type: "auto" })}
          className={cn(
            FOOTER_BUTTON,
            "border-accent text-accent hover:bg-accent hover:text-accent-fg",
          )}
        >
          Let the engine choose
        </button>
      </footer>
    </section>
  );
}

const FOOTER_BUTTON = cn(
  "inline-flex h-8 items-center rounded-full border bg-surface px-3.5 text-[13px]",
  "transition-colors motion-reduce:transition-none disabled:opacity-45",
  PRESS,
  FOCUS,
);
