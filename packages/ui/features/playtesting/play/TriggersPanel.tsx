import { useState, type JSX, type MouseEvent } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { GameCard, PlaytestAction, PlaytestCardRef } from "@/lib/ipc";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { CardFace } from "../table/Inspect";
import { cardOfRef } from "./prompt";
import { moveTrigger, orderAction, startResolving } from "./triggers";

/**
 * Five triggers or more to put in order (`prompt.triggers`), which the engine lists only as they
 * are and reversed: the triggers in the order they resolve, the first on top, each with its
 * card's picture (pointed while hovered), its words, and up and down buttons. "Put on the stack"
 * sends the order (`orderTriggers`).
 */
export function TriggersPanel({
  triggers,
  table,
  disabled,
  onAct,
  onPoint,
  onUnpoint,
  className,
}: {
  triggers: readonly PlaytestCardRef[];
  table: readonly GameCard[];
  disabled: boolean;
  onAct: (action: PlaytestAction) => void;
  onPoint: (card: GameCard, e: MouseEvent) => void;
  onUnpoint: () => void;
  className?: string;
}): JSX.Element {
  const [resolving, setResolving] = useState<number[]>(() => startResolving(triggers.length));

  return (
    <section aria-label="Order of the triggers" className={cn("flex min-w-0 flex-col", className)}>
      <p className="m-0 px-3 pt-1.5 text-[11px] tracking-[0.08em] text-dim uppercase">
        Resolves first
      </p>
      <ol
        aria-label="Triggers, first to resolve first"
        className="m-0 flex list-none flex-col gap-1 p-1.5"
      >
        {resolving.map((index, at) => {
          const ref = triggers[index];
          if (ref === undefined) return null;
          const card = cardOfRef(ref, table);
          return (
            <li
              key={index}
              className="flex h-11 min-w-0 items-center gap-2 rounded-lg border border-border px-1.5 text-[13px]"
              onMouseEnter={(e) => onPoint(card, e)}
              onMouseLeave={onUnpoint}
              data-point={card.id}
            >
              <span className="w-4 flex-none text-center font-mono text-xs text-dim tabular-nums">
                {at + 1}
              </span>
              <span aria-hidden="true" className="relative h-[34px] w-6 flex-none">
                <CardFace card={card} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{ref.name}</span>
                {ref.text !== null && (
                  <span className="truncate text-[11px] text-dim">{ref.text}</span>
                )}
              </span>
              <button
                type="button"
                aria-label={`Resolve ${ref.name} earlier`}
                disabled={disabled || at === 0}
                onClick={() => setResolving((r) => moveTrigger(r, at, -1))}
                className={STEP_BUTTON}
              >
                <ChevronUp className="size-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={`Resolve ${ref.name} later`}
                disabled={disabled || at === resolving.length - 1}
                onClick={() => setResolving((r) => moveTrigger(r, at, 1))}
                className={STEP_BUTTON}
              >
                <ChevronDown className="size-3.5" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-none items-center justify-end gap-1.5 px-1.5 pb-1.5">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setResolving(startResolving(triggers.length))}
          className={cn(SMALL_BUTTON, "border-border text-text hover:border-accent")}
        >
          Reset
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onAct(orderAction(resolving))}
          className={cn(
            SMALL_BUTTON,
            "border-accent font-semibold text-accent hover:bg-accent hover:text-accent-fg",
          )}
        >
          Put on the stack
        </button>
      </div>
    </section>
  );
}

const SMALL_BUTTON = cn(
  "inline-flex h-7 items-center gap-1 rounded-full border bg-surface px-3 text-[12px]",
  "transition-colors motion-reduce:transition-none disabled:opacity-45",
  PRESS,
  FOCUS,
);

const STEP_BUTTON = cn(
  "inline-flex size-7 flex-none items-center justify-center rounded-full border border-border bg-surface",
  "transition-colors motion-reduce:transition-none hover:border-accent disabled:opacity-45",
  PRESS,
  FOCUS,
);
