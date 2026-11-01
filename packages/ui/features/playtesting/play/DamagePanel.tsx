import { useState, type JSX, type MouseEvent } from "react";
import { ChevronDown, ChevronUp, Minus, Plus } from "lucide-react";
import type { GameCard, PlaytestAction, PlaytestPrompt } from "@/lib/ipc";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { CardFace } from "../table/Inspect";
import {
  amountOf,
  assignAction,
  canAssign,
  canTrample,
  damageCounter,
  left,
  lethalTo,
  NO_SPLIT,
  stepBlocker,
  stepExcess,
  type DamageSplit,
} from "./damage";
import { playerName } from "./players";
import { cardOfRef } from "./prompt";
import { OptionChips } from "./PromptPanel";

/**
 * The reader's attacker is blocked by two creatures or more (or tramples over one): **the
 * attacker's controller divides its combat damage** (CR 510.1c; issue #1448) — `prompt.damage`.
 * The engine offers one split of its own, lethal to each blocker in the order they blocked; this
 * panel lets the reader make theirs, so they choose which blocker dies.
 *
 * Each blocker is drawn large with its share under it: a click on the card gives it lethal (or
 * what is left of it), a second click everything left; the − and + step one point. A blocker
 * with lethal says so. With trample, a last row carries what is left past the blockers to the
 * player, planeswalker or battle attacked — open only once every blocker has lethal
 * (CR 702.19b). Confirm takes the split once every point is assigned.
 *
 * Laid out as the picker is (`PickPanel`): over the middle of the board, folding to its header to
 * look at the table; the engine's own answers (its split, "as though it weren't blocked") behind
 * "Other answers", and "Let the engine choose" as on every prompt.
 */
export function DamagePanel({
  prompt,
  table,
  disabled,
  onAct,
  onPoint,
  onUnpoint,
  opponents = 1,
  className,
}: {
  prompt: PlaytestPrompt & { damage: NonNullable<PlaytestPrompt["damage"]> };
  table: readonly GameCard[];
  disabled: boolean;
  onAct: (action: PlaytestAction) => void;
  onPoint: (card: GameCard, e: MouseEvent) => void;
  onUnpoint: () => void;
  /** How many opponents the game has, to name the one the excess goes to. */
  opponents?: number;
  className?: string;
}): JSX.Element {
  const { damage } = prompt;
  const [split, setSplit] = useState<DamageSplit>(NO_SPLIT);
  const [folded, setFolded] = useState(false);
  const [others, setOthers] = useState(false);
  const ready = canAssign(damage, split) && !disabled;
  const attacker = cardOfRef(damage.attacker, table);
  const past = damage.target?.name ?? playerName(damage.defender, opponents);
  const rest = left(damage, split);

  return (
    <section
      aria-label="Assign combat damage"
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border border-accent bg-surface shadow-lg",
        LAYER.raised,
        className,
      )}
    >
      <header className="flex flex-none items-center gap-2 border-b border-border py-1.5 pr-1.5 pl-3">
        <h2 className="m-0 flex-none text-[14px] font-semibold">Assign combat damage</h2>
        <span className="min-w-0 truncate text-xs text-dim">
          {damage.attacker.name} deals {damage.total}
        </span>
        <span className="ml-auto flex-none font-mono text-xs text-dim tabular-nums">
          {damageCounter(damage, split)}
        </span>
        <button
          type="button"
          aria-expanded={!folded}
          onClick={() => setFolded((f) => !f)}
          className={cn(SMALL_BUTTON, "border-border text-dim hover:text-text")}
        >
          {folded ? (
            <ChevronUp className="size-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden="true" />
          )}
          {folded ? "Show the blockers" : "Look at the table"}
        </button>
      </header>

      {!folded && (
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-3 py-2.5">
          <div className="flex flex-wrap items-start gap-4">
            <div
              className="flex flex-none flex-col items-center gap-1.5"
              onMouseEnter={(e) => onPoint(attacker, e)}
              onMouseLeave={onUnpoint}
              data-point={attacker.id}
            >
              <span className="text-[11px] tracking-[0.08em] text-dim uppercase">Attacker</span>
              <span aria-hidden="true" className="relative block h-[129px] w-[92px] opacity-80">
                <CardFace card={attacker} />
              </span>
            </div>
            <ol
              aria-label="Blockers"
              className="m-0 flex min-w-0 flex-1 list-none flex-wrap gap-3 p-0"
            >
              {damage.blockers.map((blocker) => {
                const card = cardOfRef(blocker.card, table);
                const amount = amountOf(split, blocker.card.id);
                const lethal = amount >= blocker.lethal;
                return (
                  <li key={blocker.card.id} className="flex flex-none flex-col items-center gap-1.5">
                    <span
                      className={cn(
                        "text-[11px] tracking-[0.08em] uppercase",
                        lethal ? "text-mana-r" : "text-dim",
                      )}
                    >
                      {lethal ? "Lethal" : `Lethal ${blocker.lethal}`}
                    </span>
                    <button
                      type="button"
                      aria-label={`${blocker.card.name}, ${amount} damage`}
                      aria-disabled={disabled}
                      onClick={() => {
                        if (!disabled) setSplit((s) => lethalTo(damage, s, blocker.card.id));
                      }}
                      onMouseEnter={(e) => onPoint(card, e)}
                      onMouseLeave={onUnpoint}
                      data-point={blocker.card.id}
                      className={cn(
                        "relative block h-[129px] w-[92px] rounded-md p-0",
                        "transition-[translate,opacity] duration-150 motion-reduce:transition-none",
                        FOCUS,
                        amount > 0 && "outline-2 outline-offset-2 outline-solid",
                        lethal ? "outline-mana-r" : "outline-accent",
                      )}
                    >
                      <CardFace card={card} />
                    </button>
                    <Stepper
                      label={blocker.card.name}
                      value={amount}
                      disabled={disabled}
                      canLess={amount > 0}
                      canMore={rest > 0}
                      onStep={(delta) =>
                        setSplit((s) => stepBlocker(damage, s, blocker.card.id, delta))
                      }
                    />
                  </li>
                );
              })}
              {damage.trample && (
                <li className="flex flex-none flex-col items-center justify-end gap-1.5 self-stretch">
                  <span className="text-[11px] tracking-[0.08em] text-dim uppercase">Trample</span>
                  <p className="m-0 flex h-[129px] w-[120px] items-center text-center text-xs text-dim">
                    {canTrample(damage, split)
                      ? `Past the blockers to ${past}`
                      : "Assign lethal to every blocker first"}
                  </p>
                  <Stepper
                    label={past}
                    value={split.excess}
                    disabled={disabled}
                    canLess={split.excess > 0}
                    canMore={rest > 0 && canTrample(damage, split)}
                    onStep={(delta) => setSplit((s) => stepExcess(damage, s, delta))}
                  />
                </li>
              )}
            </ol>
          </div>
          {others && prompt.options.length > 0 && (
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
        </div>
      )}

      <footer className="flex flex-none flex-wrap items-center justify-end gap-1.5 border-t border-border px-2 py-1.5">
        {prompt.options.length > 0 && (
          <button
            type="button"
            aria-expanded={others}
            onClick={() => setOthers((o) => !o)}
            className={cn(SMALL_BUTTON, "mr-auto border-transparent text-dim hover:text-text")}
          >
            Other answers
          </button>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={() => setSplit(NO_SPLIT)}
          className={cn(SMALL_BUTTON, "border-border text-text hover:border-accent")}
        >
          Clear
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onAct({ type: "auto" })}
          className={cn(SMALL_BUTTON, "border-border text-text hover:border-accent")}
        >
          Let the engine choose
        </button>
        <button
          type="button"
          aria-disabled={!ready}
          onClick={() => {
            if (ready) onAct(assignAction(damage, split));
          }}
          className={cn(
            SMALL_BUTTON,
            "border-accent font-semibold text-accent",
            ready
              ? "hover:bg-accent hover:text-accent-fg"
              : "cursor-default opacity-45 active:scale-100",
          )}
        >
          Assign damage
        </button>
      </footer>
    </section>
  );
}

/** − amount +, one point a press. */
function Stepper({
  label,
  value,
  disabled,
  canLess,
  canMore,
  onStep,
}: {
  label: string;
  value: number;
  disabled: boolean;
  canLess: boolean;
  canMore: boolean;
  onStep: (delta: number) => void;
}): JSX.Element {
  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        aria-label={`Less damage to ${label}`}
        disabled={disabled || !canLess}
        onClick={() => onStep(-1)}
        className={STEP_BUTTON}
      >
        <Minus className="size-3.5" aria-hidden="true" />
      </button>
      <output
        aria-label={`Damage to ${label}`}
        className="w-6 text-center font-mono text-[13px] tabular-nums"
      >
        {value}
      </output>
      <button
        type="button"
        aria-label={`More damage to ${label}`}
        disabled={disabled || !canMore}
        onClick={() => onStep(1)}
        className={STEP_BUTTON}
      >
        <Plus className="size-3.5" aria-hidden="true" />
      </button>
    </span>
  );
}

const SMALL_BUTTON = cn(
  "inline-flex h-7 items-center gap-1 rounded-full border bg-surface px-3 text-[12px]",
  "transition-colors motion-reduce:transition-none disabled:opacity-45",
  PRESS,
  FOCUS,
);

const STEP_BUTTON = cn(
  "inline-flex size-7 items-center justify-center rounded-full border border-border bg-surface",
  "transition-colors motion-reduce:transition-none hover:border-accent disabled:opacity-45",
  PRESS,
  FOCUS,
);
