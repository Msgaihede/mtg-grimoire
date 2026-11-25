import { useRef, type KeyboardEvent } from "react";
import { motion, useIsPresent } from "motion/react";
import { Delete } from "lucide-react";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { popup, PRESS, scrim } from "@/lib/motion";
import { trapTab } from "@/lib/trapTab";
import { cn } from "@/lib/utils";
import { KEYS, SPOKEN, calcDisplay, type CalcKey } from "../game/calculator";
import {
  calcTarget,
  playerName,
  type BoardAction,
  type EditState,
  type GameState,
} from "../game/gameState";
import { grouped, humanize } from "../game/lifeNumber";
import { useOverlayFocus } from "./useOverlayFocus";

/** How long after opening a press on the backdrop is not a cancel: the finger that held the
 *  calculator open is still down when it appears, and lifting it there must not close it. */
const SCRIM_GRACE_MS = 500;

/** A physical keyboard's keys, for the desktop face: the same keypad, typed. */
const TYPED: Record<string, CalcKey> = {
  "+": "+",
  "-": "−",
  "*": "×",
  x: "×",
  "/": "÷",
  "(": "(",
  ")": ")",
  "=": "=",
  Backspace: "del",
  Delete: "C",
};

const SIGN_KEYS = new Set<string>(["−", "+", "×", "÷", "(", ")", "="]);

/**
 * The calculator, **turned to face whoever opened it** — a quarter or half turn round the table,
 * the same turn as their panel. Commander damage is set by the player it was dealt to, who is
 * counting it and whom every panel faces while it is open, so it faces them, whichever commander's
 * panel was held. Five across: the digits as on any calculator, the four signs in a column beside
 * them, and delete, the brackets and = down the right-hand edge. What it does is all
 * `calculator.ts`'s; this draws its display.
 */
export function CalculatorDialog({
  game,
  edit,
  rot,
  dispatch,
}: {
  game: GameState;
  edit: EditState;
  rot: number;
  dispatch: (action: BoardAction) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // False from the render the close starts in: on its way out the overlay is a picture — nothing
  // to press and nothing for a screen reader, `Dialog`'s rule.
  const present = useIsPresent();
  const close = () => dispatch({ type: "closeCalc" });
  useOverlayFocus(panelRef, close);

  const shown = calcDisplay(edit.calc, calcTarget(game, edit), grouped, (v) => humanize(v).text);
  const name = edit.source === null ? "Life total" : "Commander damage dealt";
  const whose =
    edit.source === null
      ? playerName(edit.seat)
      : `${edit.source < game.seats.length ? playerName(edit.source) : `Opponent ${edit.source - game.seats.length + 1}`} to ${playerName(edit.seat)}`;
  const press = (key: CalcKey) => dispatch({ type: "calcKey", key });
  const apply = () => dispatch({ type: "applyCalc", now: Date.now() });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    trapTab(e);
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^\d$/.test(e.key)) {
      e.preventDefault();
      press(e.key as CalcKey);
    } else if (TYPED[e.key]) {
      e.preventDefault();
      press(TYPED[e.key]);
    } else if (e.key === "Enter" && e.target === e.currentTarget) {
      // Enter on a focused key is that key; on the panel itself it is Set.
      e.preventDefault();
      apply();
    }
  };

  return (
    <div
      className={cn("absolute inset-0", LAYER.popup, !present && "pointer-events-none")}
      aria-hidden={present ? undefined : true}
    >
      <motion.button
        {...scrim}
        type="button"
        tabIndex={-1}
        aria-label="Cancel"
        onClick={() => {
          if (Date.now() - edit.at < SCRIM_GRACE_MS) return;
          close();
        }}
        className="absolute inset-0 size-full cursor-default border-0 bg-[color-mix(in_oklab,var(--color-bg)_72%,transparent)] p-0"
      />
      {/* The panel rises out of the scrim (`popup`) from a point at the board's centre: the box
          that scales is this one, and the panel's own turn and centring are left as they read. */}
      <motion.div {...popup} className="absolute top-1/2 left-1/2 size-0">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={`${name}, ${whose}`}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="absolute top-1/2 left-1/2 box-border flex w-[320px] flex-col gap-2 rounded-[var(--radius)] border border-border bg-surface p-3 outline-none"
          style={{ transform: `translate(-50%, -50%) rotate(${rot}deg)` }}
        >
          <div className="flex flex-col gap-0.5 px-1 pt-0.5 pb-1">
            <span className="h-[18px] truncate text-[13px] leading-[18px] font-semibold text-text">
              {name}
            </span>
            <div
              aria-live="polite"
              className="flex h-[38px] items-center justify-end font-mono leading-none font-semibold whitespace-nowrap tabular-nums"
              style={{
                fontSize: Math.floor(Math.max(14, Math.min(32, 284 / (0.61 * shown.value.length)))),
                color: shown.touched ? "var(--color-text)" : "var(--color-dim)",
              }}
            >
              {shown.value}
            </div>
            <div
              className={cn(
                "flex h-[18px] items-center justify-end leading-[18px] whitespace-nowrap",
                shown.lineIsAnswer
                  ? "font-mono text-[15px] font-semibold text-accent"
                  : "text-xs text-dim",
              )}
            >
              {shown.line}
            </div>
          </div>

          <div className="grid grid-cols-5 gap-1.5">
            {KEYS.map((key) => {
              const held = shown.op === key;
              return (
                <button
                  key={key}
                  type="button"
                  aria-label={SPOKEN[key] ?? key}
                  onClick={() => press(key)}
                  className={cn(
                    "flex h-12 cursor-pointer items-center justify-center rounded-md border border-border p-0 font-mono leading-none font-medium",
                    PRESS,
                    FOCUS,
                    held
                      ? "bg-accent text-2xl text-accent-fg"
                      : SIGN_KEYS.has(key)
                        ? "bg-bg text-2xl text-accent"
                        : key === "del" || key === "C"
                          ? "bg-transparent text-lg text-dim"
                          : "bg-bg text-xl text-text",
                  )}
                >
                  {key === "del" ? <Delete aria-hidden size={22} strokeWidth={2} /> : key}
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={close}
              className={cn(
                "h-11 cursor-pointer rounded-md border border-border bg-transparent px-3 text-sm text-text",
                PRESS,
                FOCUS,
              )}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={apply}
              className={cn(
                "h-11 cursor-pointer rounded-md border-0 bg-accent px-3 text-sm font-semibold text-accent-fg",
                PRESS,
                FOCUS,
              )}
            >
              {shown.applyLabel}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
