import type { JSX, MouseEvent } from "react";
import type { GameCard, PlaytestAction, PlaytestStackItem, PlaytestView } from "@/lib/ipc";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { CardFace } from "../table/Inspect";
import { playerName, playerPossessive, tableCards } from "./players";
import { cardOfRef, causeWords } from "./prompt";

/**
 * What the reader is asked to respond to: the stack's top item when it is an opponent's and the
 * reader holds priority over it (`stage: "respond"`), or `null` — a step's stop with the stack
 * empty, or the reader's own spell on top, asks about nothing on the stack.
 */
export function respondingTo(view: PlaytestView | null): PlaytestStackItem | null {
  if (view === null || view.stage !== "respond") return null;
  const top = view.stack[0];
  return top !== undefined && top.seat !== "you" ? top : null;
}

/**
 * What an item on the stack targets, as a sentence's end: "Tarmogoyf and you". Cards first, in
 * the order chosen, by their names on the tables or the stack; `null` when it targets nothing.
 */
export function targetWords(item: PlaytestStackItem, view: PlaytestView): string | null {
  const opponents = view.opponents.length;
  const named = [...tableCards(view), ...view.stack];
  const names = [
    ...item.targets.map((id) => named.find((c) => c.id === id)?.name ?? null),
    ...item.targetPlayers.map((p) => playerName(p, opponents, "mid")),
  ].filter((n): n is string => n !== null);
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * **The opponent's action, asked about at the top centre of the board, over their table** (issue
 * #1334). An opponent's spell or ability on top of the stack is the one moment the reader decides
 * something about the other side's play, and the stack's column in the right gutter — 52 px cards
 * under a 10 px "Respond?" — read too small for it. So the question is drawn large where the
 * reader's eyes are already on the opponent: the item's card at 120 × 168 (pointable, for the
 * preview), whose it is and whether it is cast or an ability, its words and what set it off, and
 * what it targets — the arrows from the stack's column still draw where.
 *
 * **A panel, not a dialog**, as the prompt's: the answer to it is a card from the reader's hand or
 * an ability on their table, so it takes no scrim, holds no focus, and leaves the foot's stage
 * buttons as they are — Pass (Space's) and Pass turn. Its own button is that Pass, named for what
 * it does here: "Let it resolve".
 */
export function RespondPrompt({
  item,
  view,
  disabled,
  onAct,
  onPoint,
  onUnpoint,
  className,
}: {
  item: PlaytestStackItem;
  view: PlaytestView;
  /** An action is with the engine: nothing more can be sent until it answers. */
  disabled: boolean;
  onAct: (action: PlaytestAction) => void;
  onPoint: (card: GameCard, item: PlaytestStackItem, e: MouseEvent) => void;
  onUnpoint: () => void;
  className?: string;
}): JSX.Element {
  const opponents = view.opponents.length;
  const card = cardOfRef(item, tableCards(view));
  const title = `Respond to ${item.name}?`;
  const whose = item.ability
    ? `${playerPossessive(item.seat, opponents)} ability`
    : `${playerName(item.seat, opponents)} cast`;
  const by = causeWords(item.cause, opponents);
  const targets = targetWords(item, view);
  return (
    <section
      aria-label={title}
      className={cn(
        "flex gap-4 rounded-2xl border-2 border-accent bg-surface p-3 pr-4 shadow-xl",
        LAYER.raised,
        className,
      )}
    >
      <span
        onMouseEnter={(e) => onPoint(card, item, e)}
        onMouseLeave={onUnpoint}
        data-point={item.id}
        className="relative h-[168px] w-[120px] flex-none rounded-lg border-2 border-mana-r shadow-md"
      >
        <CardFace card={card} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-1">
        <span className="text-[12px] font-semibold tracking-[0.08em] text-mana-r uppercase">
          {whose}
        </span>
        <h2 className="m-0 text-[22px]/7 font-semibold text-balance">{title}</h2>
        {item.ability && (item.text !== null || by !== null) && (
          <p className="m-0 line-clamp-2 text-[14px] text-text">
            {item.text}
            {by !== null && <span className="text-dim">{` (for ${by})`}</span>}
          </p>
        )}
        {targets !== null && (
          <p className="m-0 truncate text-[14px] text-text">
            <span className="text-dim">Targeting </span>
            {targets}
          </p>
        )}
        <div className="mt-auto flex items-center gap-3 pt-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAct({ type: "pass" })}
            aria-keyshortcuts="Space"
            className={cn(
              "inline-flex h-11 flex-none items-center gap-2 rounded-2xl border border-accent bg-accent px-5",
              "text-[15px] font-semibold text-accent-fg transition-opacity motion-reduce:transition-none disabled:opacity-45",
              PRESS,
              FOCUS,
            )}
          >
            Let it resolve
            <kbd className="rounded border border-current px-1.5 font-mono text-[10px] leading-4 font-normal opacity-70">
              Space
            </kbd>
          </button>
          <span className="min-w-0 text-[13px] text-dim">
            Or cast an instant or activate an ability to respond.
          </span>
        </div>
      </div>
    </section>
  );
}
