import { useRef, type ReactNode } from "react";
import { motion, useIsPresent } from "motion/react";
import {
  Crown,
  Minus,
  Plus,
  RotateCcw,
  Shuffle,
  SlidersHorizontal,
  Timer,
  Users,
} from "lucide-react";
import { FOCUS, FOCUS_INSET } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { popup, PRESS_SOFT, scrim } from "@/lib/motion";
import { trapTab } from "@/lib/trapTab";
import { cn } from "@/lib/utils";
import {
  SEAT_COLORS,
  SEAT_COLOR_NAMES,
  type BoardAction,
  type GameState,
  type GameSwitch,
} from "../game/gameState";
import { useOverlayFocus } from "./useOverlayFocus";

const ROW =
  "flex h-12 w-full shrink-0 cursor-pointer items-center gap-3 rounded-md border-0 bg-transparent px-3 text-left text-[15px] text-text";

/** A row's leading mark, dimmed, 20px square. */
function Lead({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden className="flex w-5 shrink-0 items-center justify-center text-dim">
      {children}
    </span>
  );
}

function SwitchRow({
  on,
  label,
  mark,
  onToggle,
}: {
  on: boolean;
  label: string;
  mark: ReactNode;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      className={cn(ROW, PRESS_SOFT, FOCUS_INSET)}
    >
      <Lead>{mark}</Lead>
      <span className="min-w-0 flex-1">{label}</span>
      <span
        aria-hidden
        className={cn(
          "relative box-border block h-[26px] w-11 shrink-0 rounded-full border",
          on ? "border-accent bg-accent" : "border-border bg-bg",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 block size-5 rounded-full",
            on ? "left-5 bg-accent-fg" : "left-0.5 bg-dim",
          )}
        />
      </span>
    </button>
  );
}

/**
 * The game menu, from the button where the panels meet: who goes first, the switches for what the
 * board tracks, the turn timer's pause, and the two ways out of this game — each of which asks
 * first (`LifeBoard`'s confirmation), because a press here must never lose a game by accident.
 *
 * One player has nobody to go first against, and has their opponents to count, their colour and
 * their own counters' switches instead. The monarch's switch is a Commander game's from two
 * players; one player in a Commander game always has the crown.
 */
export function GameMenu({
  game,
  dispatch,
  onPickFirst,
}: {
  game: GameState;
  dispatch: (action: BoardAction) => void;
  /** The roulette: the board's, since it runs on timers and sound the board owns. */
  onPickFirst: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // On its way out the menu is a picture: `CalculatorDialog`'s rule.
  const present = useIsPresent();
  const close = () => dispatch({ type: "menu", open: false });
  useOverlayFocus(panelRef, close);

  const n = game.seats.length;
  const { setup } = game;
  const toggle = (name: GameSwitch) => () => dispatch({ type: "switch", name });

  return (
    <div
      className={cn("absolute inset-0", LAYER.popup, !present && "pointer-events-none")}
      aria-hidden={present ? undefined : true}
    >
      <motion.button
        {...scrim}
        type="button"
        tabIndex={-1}
        aria-label="Close the menu"
        onClick={close}
        className="absolute inset-0 size-full cursor-default border-0 bg-[color-mix(in_oklab,var(--color-bg)_72%,transparent)] p-0"
      />
      {/* Rises out of the scrim (`popup`). Its centring is Tailwind's `translate`, a property of its
          own, so the scale the tween writes to `transform` composes with it. */}
      <motion.div
        {...popup}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Game menu"
        tabIndex={-1}
        onKeyDown={trapTab}
        className="absolute top-1/2 left-1/2 box-border flex max-h-[calc(100%-16px)] w-[300px] -translate-x-1/2 -translate-y-1/2 flex-col gap-0.5 overflow-y-auto rounded-[var(--radius)] border border-border bg-surface px-2 pt-4 pb-2 outline-none"
      >
        <div className="flex shrink-0 flex-col gap-0.5 px-3 pb-2.5">
          <span className="font-heading text-lg leading-[1.2] font-medium">Game</span>
          <span className="text-xs leading-[1.33] text-dim">
            {n} {n === 1 ? "player" : "players"} · Turn {game.turnNo}
          </span>
        </div>

        {game.foes > 0 && (
          <div
            role="group"
            aria-label="Opponents"
            className="flex h-12 shrink-0 items-center gap-3 pr-1 pl-3 text-[15px]"
          >
            <Lead>
              <Users size={20} strokeWidth={2} />
            </Lead>
            <span className="min-w-0 flex-1">Opponents</span>
            <button
              type="button"
              aria-label="One opponent fewer"
              disabled={game.foes <= 1}
              onClick={() => dispatch({ type: "foes", count: game.foes - 1 })}
              className="inline-flex size-11 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-text disabled:cursor-default disabled:opacity-35"
            >
              <Minus aria-hidden size={18} strokeWidth={2.5} />
            </button>
            <span
              aria-live="polite"
              className="min-w-4 text-center font-mono text-base font-semibold"
            >
              {game.foes}
            </span>
            <button
              type="button"
              aria-label="One opponent more"
              disabled={game.foes >= 5}
              onClick={() => dispatch({ type: "foes", count: game.foes + 1 })}
              className="inline-flex size-11 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-text disabled:cursor-default disabled:opacity-35"
            >
              <Plus aria-hidden size={18} strokeWidth={2.5} />
            </button>
          </div>
        )}

        {n === 1 && (
          <div
            role="group"
            aria-label="Your colour"
            className="flex h-12 shrink-0 items-center gap-3 pr-1.5 pl-3 text-[15px]"
          >
            <span
              aria-hidden
              className="box-border size-5 shrink-0 rounded-full border border-border"
              style={{ background: SEAT_COLORS[game.colour] }}
            />
            <span className="min-w-0 flex-1">Colour</span>
            <span className="flex shrink-0 items-center">
              {SEAT_COLORS.map((color, k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={game.colour === k}
                  aria-label={SEAT_COLOR_NAMES[k] + (game.colour === k ? ", your colour" : "")}
                  onClick={() => dispatch({ type: "colour", colour: k })}
                  className={cn(
                    "inline-flex h-11 w-7 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0",
                    FOCUS,
                  )}
                >
                  <span
                    className="block size-5 rounded-full"
                    style={{
                      background: color,
                      boxShadow:
                        game.colour === k
                          ? "0 0 0 2px var(--color-surface), 0 0 0 4px var(--color-accent)"
                          : "none",
                    }}
                  />
                </button>
              ))}
            </span>
          </div>
        )}

        {n > 1 && (
          <button type="button" onClick={onPickFirst} className={cn(ROW, PRESS_SOFT, FOCUS_INSET)}>
            <Lead>
              <Shuffle size={20} strokeWidth={2} />
            </Lead>
            Pick who goes first
          </button>
        )}

        <SwitchRow
          on={game.poisonOn}
          label="Poison counters"
          mark={<i className="ms ms-p text-[20px] leading-none" />}
          onToggle={toggle("poisonOn")}
        />
        {n === 1 && (
          <>
            <SwitchRow
              on={game.energyOn}
              label="Energy"
              mark={<i className="ms ms-e text-[20px] leading-none" />}
              onToggle={toggle("energyOn")}
            />
            <SwitchRow
              on={game.xpOn}
              label="Experience"
              mark={<span className="font-sans text-xs leading-none font-bold">XP</span>}
              onToggle={toggle("xpOn")}
            />
            <SwitchRow
              on={game.blessOn}
              label="City’s blessing"
              mark={<i className="ms ms-ability-ascend text-[20px] leading-none" />}
              onToggle={toggle("blessOn")}
            />
          </>
        )}
        {n > 1 && setup.commander && (
          <SwitchRow
            on={game.monarchOn}
            label="The monarch"
            mark={<Crown size={20} strokeWidth={2} />}
            onToggle={toggle("monarchOn")}
          />
        )}

        {setup.timerSeconds > 0 && (
          <button
            type="button"
            onClick={() => dispatch({ type: "pause", now: Date.now() })}
            className={cn(ROW, PRESS_SOFT, FOCUS_INSET)}
          >
            <Lead>
              <Timer size={20} strokeWidth={2} />
            </Lead>
            {game.paused ? "Resume the turn timer" : "Pause the turn timer"}
          </button>
        )}
        <button
          type="button"
          onClick={() => dispatch({ type: "confirm", ask: "restart" })}
          className={cn(ROW, PRESS_SOFT, FOCUS_INSET)}
        >
          <Lead>
            <RotateCcw size={20} strokeWidth={2} />
          </Lead>
          Restart with the same setup
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: "confirm", ask: "leave" })}
          className={cn(ROW, PRESS_SOFT, FOCUS_INSET)}
        >
          <Lead>
            <SlidersHorizontal size={20} strokeWidth={2} />
          </Lead>
          End game and change setup
        </button>
        <button
          type="button"
          onClick={close}
          className={cn(
            "mt-1.5 h-11 w-full shrink-0 cursor-pointer rounded-md border border-border bg-transparent px-3 text-sm text-text",
            PRESS_SOFT,
            FOCUS,
          )}
        >
          Back to the game
        </button>
      </motion.div>
    </div>
  );
}
