import { useState, type JSX, type MouseEvent } from "react";
import type { GameCard, PlaytestAction, PlaytestDistribute } from "@/lib/ipc";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { CardFace } from "../table/Inspect";
import { Stepper } from "./DamagePanel";
import {
  canDivide,
  divideAction,
  divisionCounter,
  leftToDivide,
  startDivision,
  stepShare,
} from "./distribute";
import { playerName } from "./players";
import { cardOfRef } from "./prompt";

/**
 * An amount to divide among targets as the reader chooses (`prompt.distribute`, CR 601.2d) —
 * Fireball's damage, Forked Bolt's, counters "divided as you choose" — drawn in the prompt panel
 * where its answers would be, since the engine cannot list every division.
 *
 * One row a target, its card's picture (pointed while hovered, as a row of answers is) or its
 * player, and a − amount + stepper as the combat damage panel's (`DamagePanel`'s `Stepper`):
 * each share starts at its least and never goes under it, and none goes past what is left.
 * "Divide" sends the division (`distribute`) once every point is given; Clear starts again.
 */
export function DistributePanel({
  distribute,
  table,
  disabled,
  onAct,
  onPoint,
  onUnpoint,
  opponents = 1,
  className,
}: {
  distribute: PlaytestDistribute;
  table: readonly GameCard[];
  disabled: boolean;
  onAct: (action: PlaytestAction) => void;
  onPoint: (card: GameCard, e: MouseEvent) => void;
  onUnpoint: () => void;
  /** How many opponents the game has, to name a player target. */
  opponents?: number;
  className?: string;
}): JSX.Element {
  const [division, setDivision] = useState<number[]>(() => startDivision(distribute));
  const noun = distribute.unit.toLowerCase();
  const left = leftToDivide(distribute, division);
  const ready = canDivide(distribute, division) && !disabled;

  return (
    <section
      aria-label={`Divide ${distribute.total} ${noun}`}
      className={cn("flex min-w-0 flex-col", className)}
    >
      <ol aria-label="Targets" className="m-0 flex list-none flex-wrap gap-1.5 p-1.5">
        {distribute.targets.map((target, i) => {
          const card = target.card === null ? null : cardOfRef(target.card, table);
          const name =
            target.card?.name ??
            (target.player === null ? "Target" : playerName(target.player, opponents));
          const label =
            target.card?.name ??
            (target.player === null ? "the target" : playerName(target.player, opponents, "mid"));
          return (
            <li
              key={target.card === null ? `player-${target.player}` : target.card.id}
              className="flex h-11 min-w-0 items-center gap-2 rounded-lg border border-border px-1.5 text-[13px]"
              onMouseEnter={card === null ? undefined : (e) => onPoint(card, e)}
              onMouseLeave={card === null ? undefined : onUnpoint}
              data-point={card?.id}
            >
              {card !== null && (
                <span aria-hidden="true" className="relative h-[34px] w-6 flex-none">
                  <CardFace card={card} />
                </span>
              )}
              <span className={cn("max-w-[140px] truncate", card === null && "pl-1.5")}>
                {name}
              </span>
              <Stepper
                label={label}
                value={division[i] ?? target.min}
                disabled={disabled}
                canLess={(division[i] ?? target.min) > target.min}
                canMore={left > 0}
                noun={noun}
                onStep={(delta) => setDivision((d) => stepShare(distribute, d, i, delta))}
              />
            </li>
          );
        })}
      </ol>
      <div className="flex flex-none items-center justify-end gap-1.5 px-1.5 pb-1.5">
        <span className="mr-auto pl-1.5 font-mono text-xs text-dim tabular-nums">
          {divisionCounter(distribute, division)}
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setDivision(startDivision(distribute))}
          className={cn(SMALL_BUTTON, "border-border text-text hover:border-accent")}
        >
          Clear
        </button>
        <button
          type="button"
          aria-disabled={!ready}
          onClick={() => {
            if (ready) onAct(divideAction(distribute, division));
          }}
          className={cn(
            SMALL_BUTTON,
            "border-accent font-semibold text-accent",
            ready
              ? "hover:bg-accent hover:text-accent-fg"
              : "cursor-default opacity-45 active:scale-100",
          )}
        >
          Divide
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
