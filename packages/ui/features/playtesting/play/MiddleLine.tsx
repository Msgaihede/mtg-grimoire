import type { JSX, MouseEvent } from "react";
import type { GameCard, PlaytestStackItem, PlaytestView } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { CardFace } from "../goldfish/Inspect";
import { combatLine, phaseLine, type Picks } from "./combat";
import { cardOfRef } from "./prompt";

/**
 * The line between the two halves of the table: where the turn is, what is waiting on the stack,
 * and how the combat stands.
 *
 * **The stack is drawn top first**, the order it resolves in, each spell or ability a chip with
 * its card's picture and name — gold-edged for the reader's, red for the opponent's, and "ability"
 * after the name of an ability (its source's picture, not a card being cast). A chip is pointable
 * like a card on the table, so a spell the opponent has just cast can be read before it resolves.
 *
 * **The last thing that happened is here too** (the log's newest line, or the engine's refusal),
 * where the eye already is between the two tables rather than in a corner the hand and plate
 * crowd. A refusal is said in full text colour and stays until the next action.
 */
export function MiddleLine({
  view,
  picks,
  status,
  failed,
  onPoint,
  onUnpoint,
  className,
}: {
  view: PlaytestView;
  picks: Picks;
  /** The log's newest line, or the engine's last refusal. */
  status: string;
  /** `status` is a refusal. */
  failed: boolean;
  onPoint: (card: GameCard, item: PlaytestStackItem, e: MouseEvent) => void;
  onUnpoint: () => void;
  className?: string;
}): JSX.Element {
  const combat = combatLine(view, picks);
  return (
    <div
      role="group"
      aria-label="Turn"
      className={cn(
        "flex items-center gap-3 border-y border-dashed border-border/60 px-3",
        className,
      )}
    >
      <span className="flex-none text-[13px] font-semibold whitespace-nowrap">
        {phaseLine(view)}
      </span>
      {combat !== null && (
        <span className="flex-none text-xs whitespace-nowrap text-mana-r">{combat}</span>
      )}
      {status !== "" && (failed || view.stack.length === 0) && (
        <span
          role="status"
          className={cn("min-w-0 truncate text-xs", failed ? "text-text" : "text-dim")}
        >
          {status}
        </span>
      )}
      {view.stack.length > 0 && (
        <ol
          aria-label="The stack, top first"
          className="m-0 ml-auto flex min-w-0 list-none items-center gap-1.5 overflow-hidden p-0"
        >
          {view.stack.map((item) => {
            const card = cardOfRef(item, [...view.you.battlefield, ...view.opponent.battlefield]);
            const whose = item.seat === "you" ? "Yours" : "The opponent's";
            return (
              <li
                key={item.id}
                aria-label={`${whose}: ${item.name}${item.ability ? ", ability" : ""}`}
                onMouseEnter={(e) => onPoint(card, item, e)}
                onMouseLeave={onUnpoint}
                data-point={item.id}
                className={cn(
                  "flex h-7 max-w-[180px] flex-none items-center gap-1.5 rounded-full border bg-surface py-0.5 pr-2.5 pl-0.5 text-xs",
                  item.seat === "you" ? "border-accent" : "border-mana-r",
                )}
              >
                <span
                  aria-hidden="true"
                  className="h-6 w-[17px] flex-none overflow-hidden rounded-sm"
                >
                  <CardFace card={card} />
                </span>
                <span className="truncate">{item.name}</span>
                {item.ability && <span className="flex-none text-dim">ability</span>}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
