import { useState, type JSX, type MouseEvent } from "react";
import { OctagonPause } from "lucide-react";
import type { GameCard, GameSeat, PlaytestStackItem, PlaytestStop, PlaytestView } from "@/lib/ipc";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { CardFace } from "../table/Inspect";
import { combatLine, type Picks } from "./combat";
import { opponentNumber, playerPossessive, tableCards } from "./players";
import { cardOfRef } from "./prompt";
import { STOP_STEPS, fixedStop, hasStop, toggleStop } from "./stops";
import { trackerOf } from "./tracker";

/**
 * The line between the two halves of the table: the turn tracker, how the combat stands, and the
 * last thing that happened.
 *
 * **The tracker** is the turn's five places — Beginning, Main 1, Combat, Main 2, End — with the
 * one the game is in lit in the colour of the seat whose turn it is (gold for the reader, red for
 * any opponent), the ones already passed dimmed, and the turn's number before them.
 *
 * **The sandbox's switch is here, beside the stops** (`SandboxButton`): both are settings of the
 * game rather than moves in it, and whether the reader's hand may change the game outside the
 * rules is the first thing to know about what a click will do — so it is always in sight, lit
 * while it is on. The top band has no room for it: the opponent's plate grows with its hand.
 *
 * **The last thing that happened is here too** (the log's newest line, or the engine's refusal),
 * where the eye already is between the two tables. A refusal is said in full text colour and
 * stays until the next action.
 */
export function MiddleLine({
  view,
  picks,
  status,
  failed,
  onStops,
  onSandbox,
  className,
}: {
  view: PlaytestView;
  picks: Picks;
  /** The log's newest line, or the engine's last refusal. */
  status: string;
  /** `status` is a refusal. */
  failed: boolean;
  /** The stops' toggles send the whole new set; absent, there are no toggles (a replay). */
  onStops?: (stops: PlaytestStop[]) => void;
  /** The sandbox's switch sends the setting it turns to; absent, the switch is only shown. */
  onSandbox?: (on: boolean) => void;
  className?: string;
}): JSX.Element {
  const combat = combatLine(view, picks);
  return (
    <div className={cn("flex items-center gap-3 px-1", className)}>
      <TurnTracker view={view} />
      <StopsButton stops={view.stops} many={view.opponents.length > 1} onStops={onStops} />
      <SandboxButton on={view.sandbox} onSandbox={onSandbox} />
      {combat !== null && (
        <span className="flex-none text-xs whitespace-nowrap text-mana-r">{combat}</span>
      )}
      {status !== "" && (
        <span
          role="status"
          className={cn("ml-auto min-w-0 truncate text-xs", failed ? "text-text" : "text-dim")}
        >
          {status}
        </span>
      )}
    </div>
  );
}

/** The turn tracker strip — see {@link MiddleLine}. Named for a screen reader in one sentence. */
export function TurnTracker({ view }: { view: PlaytestView }): JSX.Element {
  const t = trackerOf(view);
  const yours = t.whose === "you";
  // A duel's "Opponent"; at a four-player table, which one ("Opponent 2").
  const theirs = view.opponents.length > 1 ? `Opponent ${opponentNumber(t.whose)}` : "Opponent";
  return (
    <div role="group" aria-label={t.caption} className="flex flex-none items-center gap-1">
      <span
        aria-hidden="true"
        className={cn(
          "mr-1 rounded-full border px-2 font-mono text-[11px]/5 font-semibold whitespace-nowrap tabular-nums",
          t.turn === 0
            ? "border-border text-dim"
            : yours
              ? "border-accent text-accent"
              : "border-mana-r text-mana-r",
        )}
      >
        {t.turn === 0 ? "Opening hands" : `Turn ${t.turn} · ${yours ? "You" : theirs}`}
      </span>
      {t.steps.map((step) => (
        <span
          key={step.id}
          aria-hidden="true"
          data-lit={step.lit || undefined}
          className={cn(
            "rounded-full px-2 text-[11px]/5 whitespace-nowrap",
            step.lit
              ? yours
                ? "bg-accent font-semibold text-accent-fg"
                : "bg-mana-r font-semibold text-bg"
              : step.past
                ? "text-dim/60"
                : "text-dim",
          )}
        >
          {step.label}
        </span>
      ))}
    </div>
  );
}

/**
 * The stack, as cards: what is waiting to resolve, **top first** and drawn in front, each with
 * whose it is (a gold edge for the reader's, red for an opponent's) and "ability" on an ability
 * (its source's picture, not a card being cast). It stands in the board's right gutter between
 * the two tables' zone columns, where it covers no card, and each card is pointable like one on
 * the table, so a spell the opponent has just cast can be read before it resolves.
 */
export function StackColumn({
  view,
  prominent = false,
  onPoint,
  onUnpoint,
  className,
}: {
  view: PlaytestView;
  /** The reader may respond to it: the column says so, in gold. */
  prominent?: boolean;
  onPoint: (card: GameCard, item: PlaytestStackItem, e: MouseEvent) => void;
  onUnpoint: () => void;
  className?: string;
}): JSX.Element | null {
  if (view.stack.length === 0) return null;
  const shown = view.stack.slice(0, STACK_SHOWN);
  const table = tableCards(view);
  const many = view.opponents.length > 1;
  const more = view.stack.length - shown.length;
  return (
    <section aria-label="The stack" className={cn("flex flex-col items-center gap-1", className)}>
      <span
        className={cn(
          "text-[10px] tracking-[0.08em] uppercase",
          prominent ? "font-semibold text-accent" : "text-dim",
        )}
      >
        {prominent ? "Respond?" : "Stack"}
        {more > 0 ? ` +${more}` : ""}
      </span>
      <ol
        aria-label="The stack"
        className="relative m-0 list-none p-0"
        style={{ width: STACK_W, height: STACK_H + (shown.length - 1) * STACK_STEP }}
      >
        {/* Drawn bottom first, so the top of the stack is painted over the rest; each card says
            where it is from the top, since that is also the order a reader hears them in. */}
        {[...shown].reverse().map((item, j) => {
          const i = shown.length - 1 - j;
          const card = cardOfRef(item, table);
          const whose =
            item.seat === "you" ? "Yours" : playerPossessive(item.seat, view.opponents.length);
          return (
            <li
              key={item.id}
              aria-label={`${i === 0 ? "Top" : `${i + 1} from the top`}: ${whose} ${item.name}${item.ability ? ", ability" : ""}`}
              onMouseEnter={(e) => onPoint(card, item, e)}
              onMouseLeave={onUnpoint}
              data-point={item.id}
              data-stack={item.id}
              className={cn(
                "absolute left-0 rounded-md border-2 bg-surface shadow-md",
                item.seat === "you" ? "border-accent" : "border-mana-r",
              )}
              style={{ top: i * STACK_STEP, width: STACK_W, height: STACK_H }}
            >
              <CardFace card={card} />
              <span
                aria-hidden="true"
                className={cn(
                  "absolute inset-x-0 bottom-0 rounded-b-[4px] text-center text-[9px]/[13px] font-semibold",
                  item.seat === "you" ? "bg-accent text-accent-fg" : "bg-mana-r text-bg",
                )}
              >
                {item.seat === "you" ? "You" : many ? `Opp ${opponentNumber(item.seat)}` : "Opp"}
                {item.ability ? " · ability" : ""}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The stack's card, the step between two of them, and how many are drawn before "+N". */
const STACK_W = 52;
const STACK_H = 73;
const STACK_STEP = 20;
const STACK_SHOWN = 3;

/**
 * The sandbox's switch (`setSandbox`): pressed, the reader's hand may move, tap and change any card
 * the table shows, outside the rules; unpressed, only the rules' plays are offered. A setting the
 * engine takes at any stage, so it is not greyed while a step waits on the reader.
 */
function SandboxButton({
  on,
  onSandbox,
}: {
  on: boolean;
  onSandbox?: (on: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={onSandbox === undefined}
      title={
        on
          ? "Sandbox on: move, tap and change any card by hand, outside the rules"
          : "Sandbox off: only the rules' plays. Turn it on to change cards by hand"
      }
      onClick={() => onSandbox?.(!on)}
      className={cn(
        "inline-flex h-5 flex-none items-center gap-1 rounded-full border border-border px-2 text-[11px] text-dim",
        "transition-colors motion-reduce:transition-none hover:border-accent hover:text-text disabled:opacity-45",
        on && "border-accent text-accent hover:text-accent",
        FOCUS,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-2 rounded-full border border-current", on && "bg-current")}
      />
      Sandbox
    </button>
  );
}

/**
 * The stops, by the tracker: a button that opens Arena's two rows of step toggles — "Your turn"
 * and "Opponent's turn" — each pressed step one the game stops at for the reader. Every toggle
 * sends the whole set (`setStops`); the reader's own main phases are always on and drawn so.
 *
 * **A stop on the opponents' side is a stop on each of their turns** (`PlaytestStop.seat` is a
 * side, not a player), so a four-player table (`many`) has the same two rows, the second named
 * "Opponents' turns".
 */
function StopsButton({
  stops,
  many = false,
  onStops,
}: {
  stops: readonly PlaytestStop[];
  many?: boolean;
  onStops?: (stops: PlaytestStop[]) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  useDismissOnEscape({ layer: "inner", onDismiss: () => setOpen(false), enabled: open });
  const extra = stops.length;
  return (
    <div className="relative flex-none">
      <button
        type="button"
        aria-expanded={open}
        aria-label="Stops"
        disabled={onStops === undefined}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex h-5 items-center gap-1 rounded-full border border-border px-2 text-[11px] text-dim",
          "transition-colors motion-reduce:transition-none hover:border-accent hover:text-text disabled:opacity-45",
          open && "border-accent text-accent",
          FOCUS,
        )}
      >
        <OctagonPause className="size-3" aria-hidden="true" />
        Stops{extra > 0 ? ` · ${extra}` : ""}
      </button>
      {open && onStops !== undefined && (
        <section
          aria-label="Stops"
          className={cn(
            "absolute top-full left-0 mt-1.5 flex flex-col gap-2 rounded-xl border border-border bg-surface p-3 shadow-lg",
            LAYER.header,
          )}
        >
          <span className="text-xs text-dim">Stop for me at these steps, to respond.</span>
          {(["you", "opponent"] as GameSeat[]).map((seat) => (
            <div
              key={seat}
              role="group"
              aria-label={
                seat === "you" ? "Your turn" : many ? "Opponents' turns" : "Opponent's turn"
              }
              className="flex items-center gap-1"
            >
              <span className="w-[128px] flex-none text-[11px] tracking-[0.08em] whitespace-nowrap text-dim uppercase">
                {seat === "you" ? "Your turn" : many ? "Opponents’ turns" : "Opponent’s turn"}
              </span>
              {STOP_STEPS.map(({ step, label }) => {
                const fixed = fixedStop(seat, step);
                const on = hasStop(stops, seat, step);
                return (
                  <button
                    key={step}
                    type="button"
                    aria-pressed={on}
                    aria-disabled={fixed}
                    onClick={() => {
                      if (!fixed) onStops(toggleStop(stops, seat, step));
                    }}
                    className={cn(
                      "h-6 rounded-full border px-2 text-[11px] whitespace-nowrap",
                      "transition-colors motion-reduce:transition-none",
                      on
                        ? seat === "you"
                          ? "border-accent bg-accent text-accent-fg"
                          : "border-mana-r bg-mana-r text-bg"
                        : "border-border text-dim hover:text-text",
                      fixed && "cursor-default opacity-70",
                      FOCUS,
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
