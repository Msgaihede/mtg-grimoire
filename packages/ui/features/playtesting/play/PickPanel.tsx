import { useState, type JSX, type MouseEvent } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { GameCard, PlaytestAction, PlaytestCardRef, PlaytestPrompt } from "@/lib/ipc";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { CardFace } from "../table/Inspect";
import {
  canConfirm,
  confirmLabel,
  hasRoom,
  pickCounter,
  pickedPower,
  pickTitle,
  pickZones,
  togglePick,
} from "./pick";
import { cardOfRef } from "./prompt";
import { OptionChips } from "./PromptPanel";

/**
 * The engine's question when the answer is a set of cards — a scry, a surveil, a discard, a
 * search, a keep-the-rest-are-sacrificed (`prompt.pick`): the cards large, a click to pick or put
 * back, a count against the bounds, and Confirm only within them. Under a power cap the count is
 * the picked creatures' power too, and a creature that would pass it is drawn dim.
 *
 * **A scry or a surveil sorts into two zones** — "Keep on top" and "Bottom", "Top" and
 * "Graveyard" — the picked ones in the order picked, numbered, the first on top: the order is the
 * answer (`ordered`). Any other ordered pick numbers its cards where they lie.
 *
 * **Over the middle of the board, and folding to its header**: the cards it asks about are drawn
 * in it, so it covers nothing it needs, and "Look at the table" folds it away for a reader who
 * wants to see what is in play before they decide. The prompt's plain answers, when it has any,
 * are behind "Other answers"; "Let the engine choose" and Cancel are as on the prompt panel.
 */
export function PickPanel({
  prompt,
  table,
  disabled,
  onAct,
  onPoint,
  onUnpoint,
  opponents = 1,
  className,
}: {
  prompt: PlaytestPrompt & { pick: NonNullable<PlaytestPrompt["pick"]> };
  table: readonly GameCard[];
  disabled: boolean;
  onAct: (action: PlaytestAction) => void;
  onPoint: (card: GameCard, e: MouseEvent) => void;
  onUnpoint: () => void;
  /** How many opponents the game has, for "Other answers" that name one. */
  opponents?: number;
  className?: string;
}): JSX.Element {
  const { pick } = prompt;
  const [picked, setPicked] = useState<number[]>([]);
  const [folded, setFolded] = useState(false);
  const [others, setOthers] = useState(false);
  const title = pickTitle(pick);
  const zones = pickZones(pick);
  const byId = new Map(pick.cards.map((c) => [c.id, c]));
  const powerOf = (id: number) => {
    const ref = byId.get(id);
    return ref === undefined ? 0 : (cardOfRef(ref, table).power ?? 0);
  };
  const power = pickedPower(picked, powerOf);
  const ready = canConfirm(pick, picked.length, power) && !disabled;

  const tile = (ref: PlaytestCardRef) => {
    const card = cardOfRef(ref, table);
    const at = picked.indexOf(ref.id);
    const eligible = pick.eligible.includes(ref.id);
    const over =
      eligible && at < 0 && pick.powerCap !== null && !hasRoom(picked, ref.id, pick, powerOf);
    return (
      <li key={ref.id} className="flex-none">
        <button
          type="button"
          aria-pressed={at >= 0}
          aria-disabled={!eligible || disabled}
          aria-label={`${ref.name}${at >= 0 && pick.ordered ? `, ${at + 1}` : ""}${eligible ? "" : ", cannot be picked"}`}
          onClick={() => {
            if (eligible && !disabled) setPicked((p) => togglePick(p, ref.id, pick, powerOf));
          }}
          onMouseEnter={(e) => onPoint(card, e)}
          onMouseLeave={onUnpoint}
          data-point={ref.id}
          className={cn(
            "relative block h-[129px] w-[92px] rounded-md p-0",
            "transition-[translate,opacity] duration-150 motion-reduce:transition-none",
            FOCUS,
            !eligible && "cursor-not-allowed opacity-40",
            over && "opacity-60",
            at >= 0 &&
              !zones &&
              "-translate-y-2 outline-2 outline-offset-2 outline-accent outline-solid",
          )}
        >
          <CardFace card={card} />
          {at >= 0 && pick.ordered && (
            <span
              aria-hidden="true"
              className="absolute -top-2 -left-2 inline-flex size-6 items-center justify-center rounded-full bg-accent font-mono text-xs font-semibold text-accent-fg"
            >
              {at + 1}
            </span>
          )}
        </button>
      </li>
    );
  };

  const row = (refs: readonly PlaytestCardRef[], label: string, empty: string) => (
    <section aria-label={label} className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[11px] tracking-[0.08em] text-dim uppercase">{label}</span>
      {refs.length === 0 ? (
        <p className="m-0 flex h-[129px] items-center text-xs text-dim">{empty}</p>
      ) : (
        <ol className="m-0 flex list-none flex-wrap gap-2.5 p-0 pt-2">{refs.map(tile)}</ol>
      )}
    </section>
  );

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
        {prompt.source !== null && (
          <span className="min-w-0 truncate text-xs text-dim">{prompt.source}</span>
        )}
        <span className="ml-auto flex-none font-mono text-xs text-dim tabular-nums">
          {pickCounter(pick, picked.length, power)}
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
          {folded ? "Show the cards" : "Look at the table"}
        </button>
      </header>

      {!folded && (
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-3 py-2.5">
          {zones === null ? (
            <ol className="m-0 flex list-none flex-wrap gap-2.5 p-0 pt-2">
              {pick.cards.map(tile)}
            </ol>
          ) : (
            <>
              {row(
                picked.flatMap((id) => byId.get(id) ?? []),
                zones.picked,
                "Click a card to keep it here; the first you click is the top.",
              )}
              {row(
                pick.cards.filter((c) => !picked.includes(c.id)),
                zones.rest,
                "Every card is staying on top.",
              )}
            </>
          )}
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
        {prompt.cancellable && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAct({ type: "cancel" })}
            className={cn(SMALL_BUTTON, "border-border text-text hover:border-accent")}
          >
            Cancel
          </button>
        )}
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
            if (ready) onAct({ type: "pickCards", ids: picked });
          }}
          className={cn(
            SMALL_BUTTON,
            "border-accent font-semibold text-accent",
            ready
              ? "hover:bg-accent hover:text-accent-fg"
              : "cursor-default opacity-45 active:scale-100",
          )}
        >
          {confirmLabel(pick, picked.length)}
        </button>
      </footer>
    </section>
  );
}

const SMALL_BUTTON = cn(
  "inline-flex h-7 items-center gap-1 rounded-full border bg-surface px-3 text-[12px]",
  "transition-colors motion-reduce:transition-none disabled:opacity-45",
  PRESS,
  FOCUS,
);
