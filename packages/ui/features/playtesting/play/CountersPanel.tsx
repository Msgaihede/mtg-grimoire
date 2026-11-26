import { useState, type JSX, type MouseEvent } from "react";
import type { GameCard, PlaytestAction, PlaytestCounters } from "@/lib/ipc";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { CardFace } from "../table/Inspect";
import {
  canTakeMore,
  counterRows,
  countersAction,
  countersConfirm,
  countersCounter,
  stepCounters,
} from "./counters";
import { Stepper } from "./DamagePanel";
import { cardOfRef } from "./prompt";

/**
 * Counters to take off a card as the reader chooses (`prompt.counters`) — "remove any number of
 * counters" (Rhys the Evermore, Tetravus) or "move any number of counters onto…" — drawn in the
 * prompt panel where its answers would be, since the engine lists only none and all.
 *
 * One row a kind of counter (and, for a move, a kind and destination), with the destination's
 * picture pointed while hovered, and a − count + stepper as the division panel's: none is the
 * least, and no kind goes past what the card has, nor the whole past `maxTotal`. None at all is
 * an answer, so the confirm button is always live; Clear starts again.
 */
export function CountersPanel({
  counters,
  table,
  disabled,
  onAct,
  onPoint,
  onUnpoint,
  className,
}: {
  counters: PlaytestCounters;
  table: readonly GameCard[];
  disabled: boolean;
  onAct: (action: PlaytestAction) => void;
  onPoint: (card: GameCard, e: MouseEvent) => void;
  onUnpoint: () => void;
  className?: string;
}): JSX.Element {
  const rows = counterRows(counters);
  const [taking, setTaking] = useState<number[]>(() => rows.map(() => 0));
  const source = counters.source?.name ?? "the card";
  const moving = counters.destinations.length > 0;

  return (
    <section
      aria-label={`${moving ? "Move" : "Remove"} counters from ${source}`}
      className={cn("flex min-w-0 flex-col", className)}
    >
      <ol aria-label="Counters" className="m-0 flex list-none flex-wrap gap-1.5 p-1.5">
        {rows.map((row, i) => {
          const card = row.to === null ? null : cardOfRef(row.to, table);
          const label =
            row.to === null ? `${row.kind} counters` : `${row.kind} onto ${row.to.name}`;
          return (
            <li
              key={`${row.kind}:${row.to?.id ?? "off"}`}
              className="flex h-11 min-w-0 items-center gap-2 rounded-lg border border-border px-1.5 text-[13px]"
              onMouseEnter={card === null ? undefined : (e) => onPoint(card, e)}
              onMouseLeave={card === null ? undefined : onUnpoint}
              data-point={card?.id}
            >
              <span className="rounded-full border border-border px-2 font-mono text-[12px]">
                {row.kind}
              </span>
              {card !== null && (
                <>
                  <span aria-hidden="true" className="text-dim">
                    →
                  </span>
                  <span aria-hidden="true" className="relative h-[34px] w-6 flex-none">
                    <CardFace card={card} />
                  </span>
                  <span className="max-w-[140px] truncate">{row.to?.name}</span>
                </>
              )}
              <Stepper
                label={label}
                value={taking[i] ?? 0}
                disabled={disabled}
                canLess={(taking[i] ?? 0) > 0}
                canMore={canTakeMore(counters, taking, i)}
                noun="counters"
                onStep={(delta) => setTaking((t) => stepCounters(counters, t, i, delta))}
              />
            </li>
          );
        })}
      </ol>
      <div className="flex flex-none items-center justify-end gap-1.5 px-1.5 pb-1.5">
        <span className="mr-auto pl-1.5 font-mono text-xs text-dim tabular-nums">
          {countersCounter(counters, taking)}
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setTaking(rows.map(() => 0))}
          className={cn(SMALL_BUTTON, "border-border text-text hover:border-accent")}
        >
          Clear
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onAct(countersAction(counters, taking))}
          className={cn(
            SMALL_BUTTON,
            "border-accent font-semibold text-accent hover:bg-accent hover:text-accent-fg",
          )}
        >
          {countersConfirm(counters, taking)}
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
