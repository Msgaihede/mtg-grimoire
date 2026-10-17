import type { JSX, MouseEvent } from "react";
import type { GameCard, PlaytestAction, PlaytestPrompt } from "@/lib/ipc";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { CardFace } from "../table/Inspect";
import {
  cardOfRef,
  distinctOptions,
  optionCards,
  optionDetail,
  optionLabel,
  promptHelp,
  promptSource,
  promptTitle,
} from "./prompt";

/**
 * The engine's question, docked at the foot of the board over the reader's hand — `stage:
 * "prompt"`. **Docked where nothing the question lights can be**: the prompt makes cards on the
 * two tables clickable, and a panel floating over a table would sooner or later cover the one it
 * asks for. The foot holds only the reader's hand, whose cards an answer names in its row (with
 * the card's picture), so the answers lie in one wrapping row of chips there, and scroll inside
 * the panel's 104 px when there are many.
 *
 * **A panel, not a dialog.** A target is chosen by looking at the table: the panel takes no scrim
 * and holds no focus trap, the board under it stays pointable (a row hovered points its card, and
 * the preview opens as it does on the table), and an answer that names one card on the table is
 * also that card, clickable where it lies (`tablePicks`).
 *
 * **An answer says what it does.** A row names the cards it points at with their pictures; an
 * order of triggers is shown first-to-resolve first, each picture numbered, and a row standing
 * for abilities (triggers, replacement effects) carries their words in its tooltip. A question
 * whose title alone does not say what an answer decides has a line under it (`promptHelp`).
 *
 * **No two rows alike** (issue #1076): a trigger is named by what tells it from the others in its
 * row — its words, or what set it off — and an order of triggers that reads the same as another
 * is offered once (`distinctOptions`). A question about one trigger (its targets) says the
 * trigger's cause beside its card, and its words in the tooltip (`promptSource`).
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
  opponents = 1,
  className,
}: {
  prompt: PlaytestPrompt;
  /** Every card on the tables, so a row names the card as it lies (its state, its counters). */
  table: readonly GameCard[];
  /** An action is with the engine: nothing more can be sent until it answers. */
  disabled: boolean;
  onAct: (action: PlaytestAction) => void;
  onPoint: (card: GameCard, e: MouseEvent) => void;
  onUnpoint: () => void;
  /** How many opponents the game has, so an answer naming one says which (`optionLabel`). */
  opponents?: number;
  className?: string;
}): JSX.Element {
  const title = promptTitle(prompt.kind);
  const help = promptHelp(prompt.kind);
  const source = promptSource(prompt, opponents);
  const line = help ?? source?.text ?? null;
  return (
    <section
      aria-label={title}
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border border-accent bg-surface shadow-lg",
        LAYER.raised,
        className,
      )}
    >
      <header className="flex flex-none items-center gap-2 border-b border-border py-1.5 pr-1.5 pl-3">
        <h2 className="m-0 flex-none text-[14px] font-semibold">{title}</h2>
        {line !== null && (
          <span
            title={help === null ? (source?.detail ?? undefined) : undefined}
            className="min-w-0 truncate text-xs text-dim"
          >
            {line}
          </span>
        )}
        <span className="ml-auto flex flex-none gap-1.5">
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
        </span>
      </header>

      {prompt.options.length === 0 ? (
        <p className="m-0 px-3 py-2 text-[13px] text-dim">
          The board can’t show this choice. Let the engine choose for you
          {prompt.cancellable ? ", or cancel." : "."}
        </p>
      ) : (
        <OptionChips
          prompt={prompt}
          table={table}
          disabled={disabled}
          onAct={onAct}
          onPoint={onPoint}
          onUnpoint={onUnpoint}
          opponents={opponents}
        />
      )}
    </section>
  );
}

/** The prompt's answers as one wrapping row of chips — the panel's body, and the picker's
 *  "Other answers". */
export function OptionChips({
  prompt,
  table,
  disabled,
  onAct,
  onPoint,
  onUnpoint,
  opponents = 1,
}: {
  prompt: PlaytestPrompt;
  table: readonly GameCard[];
  disabled: boolean;
  onAct: (action: PlaytestAction) => void;
  onPoint: (card: GameCard, e: MouseEvent) => void;
  onUnpoint: () => void;
  opponents?: number;
}): JSX.Element {
  return (
    <ul className="m-0 flex min-h-0 list-none flex-wrap gap-1.5 overflow-y-auto p-1.5">
      {distinctOptions(prompt).map((option) => {
        const { text, hint } = optionLabel(option, prompt, opponents);
        const cards = optionCards(option, prompt).map((ref) => cardOfRef(ref, table));
        const numbered = prompt.kind === "OrderTriggers" && cards.length > 1;
        const first = cards[0];
        return (
          <li key={option.index} className="min-w-0">
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
              title={optionDetail(option, prompt, opponents) ?? undefined}
              className={cn(
                "flex h-11 max-w-[260px] items-center gap-2 rounded-lg border border-border px-1.5 text-left text-[13px]",
                "transition-colors motion-reduce:transition-none hover:border-accent disabled:opacity-45",
                FOCUS,
              )}
            >
              {cards.slice(0, 3).map((card, i) => (
                // By place, not id: an order can name one card's two triggers.
                <span
                  key={`${card.id}-${i}`}
                  aria-hidden="true"
                  className="relative h-[34px] w-6 flex-none"
                >
                  <CardFace card={card} />
                  {numbered && (
                    <span className="absolute -top-1 -left-1 inline-flex size-3.5 items-center justify-center rounded-full bg-accent font-mono text-[9px] leading-none font-semibold text-accent-fg">
                      {i + 1}
                    </span>
                  )}
                </span>
              ))}
              <span className={cn("flex min-w-0 flex-col", cards.length === 0 && "px-1.5")}>
                <span className="truncate">{text}</span>
                {hint !== null && <span className="truncate text-[11px] text-dim">{hint}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const FOOTER_BUTTON = cn(
  "inline-flex h-7 items-center rounded-full border bg-surface px-3 text-[12px]",
  "transition-colors motion-reduce:transition-none disabled:opacity-45",
  PRESS,
  FOCUS,
);
