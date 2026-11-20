/**
 * The life tracker's game board: a panel per seat round the table (or upright in a grid, facing a
 * screen), the menu button where the panels meet, and the overlays the board opens over itself —
 * the calculator, the game menu, a seat's commander damage, the roulette.
 *
 * Designed on the *Life Tracker — Light App* canvas (2026-11-19 to 2026-11-20); the canvas's
 * prototype is the specification for everything here, and its rules live in `../game/` as pure
 * modules (`gameState.ts` for the game and every press, `seating.ts` for the table, `fit.ts` for
 * the numbers, `calculator.ts`, `lifeNumber.ts`). This file is the part that has to touch the
 * page: the measured size, the pointer's holds and swipes, the clock, the sound, the confetti, the
 * saved game, and the phone's Back.
 *
 * **It fills its parent** and measures itself: every seat is a share of the board's own width and
 * height, so nothing is drawn until the first measurement lands (a table laid out for a guessed
 * size and then the real one is a flash of the wrong table).
 *
 * **One stacking context of its own** (`isolate`). The seats, the menu button, the roulette's veil
 * and the board's overlays are ordered against each other with `LAYER`'s rungs, and inside the
 * board those rungs compete with nothing else on the page. The end-of-game question is a `Dialog`,
 * window-wide, and is drawn *outside* the board for exactly that reason — inside it, it would be
 * capped by the board's context and the page's own bars could paint over it.
 */
import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type JSX,
  type PointerEvent,
} from "react";
import { useReducedMotion } from "motion/react";
import { Menu } from "lucide-react";
import { useBackClaim } from "@/lib/dialogHost";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { PRESS_STILL } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { resolveSeating, type LifeSetup } from "../types";
import { commonSize } from "../game/fit";
import {
  STEPPER_MS,
  boardFrom,
  boardReducer,
  liveDelta,
  livingSeats,
  newGame,
  seatColors,
  type BoardAction,
} from "../game/gameState";
import { clearSavedGame, loadSavedGame, saveGame } from "../game/savedGame";
import {
  HUB_RADIUS,
  PAD,
  facingSeat,
  hubRoom,
  inSeatFrame,
  quarterApart,
  seatBox,
  seatPlan,
  type SeatPlan,
} from "../game/seating";
import { throwConfetti } from "./boardConfetti";
import { CalculatorDialog } from "./CalculatorDialog";
import { EndGameDialog, type EndAsk } from "./EndGameDialog";
import { GameMenu } from "./GameMenu";
import type { PanelActions } from "./panelParts";
import { RouletteSound } from "./rouletteSound";
import { SeatPanel } from "./SeatPanel";
import { useBoardSize } from "./useBoardSize";

export interface LifeBoardProps {
  setup: LifeSetup;
  /** Start from the saved game — falling back to a fresh one from `setup` when there is none, or
   *  none this build can read. A resumed game keeps its own setup. */
  resume: boolean;
  /** Called once the reader has confirmed ending the game; the save is already cleared. */
  onLeave: () => void;
}

/** A press held this long is the calculator, not a tap. */
const HOLD_MS = 500;
/** A finger that travels this far is no longer holding. */
const HOLD_SLOP_PX = 12;
/** A release this far from the press was not a tap, whether or not it is a swipe. */
const TAP_SLOP_PX = 24;
/** A swipe: at least this far, more along than across by half again, inside this long. */
const SWIPE_PX = 40;
const SWIPE_MS = 800;
/** The save's trailing debounce: every change is kept, at most one write per this. */
const SAVE_MS = 300;
/** The roulette's run, whatever the table; the landing follows. All of it inside five seconds. */
const SPIN_RUN_MS = 3000;

export function LifeBoard({ setup, resume, onLeave }: LifeBoardProps): JSX.Element {
  const [state, dispatch] = useReducer(boardReducer, null, () =>
    boardFrom((resume ? loadSavedGame() : null) ?? newGame(setup, Date.now())),
  );
  const { game, view } = state;
  const [rootRef, size] = useBoardSize<HTMLDivElement>();
  const reduced = useReducedMotion() === true;

  // The clock the board draws by — fades, the turn timer. Set by an interval only while something
  // is moving, and to the press's own stamp by every press that stamps the game, so a turn that
  // just started never reads a second over.
  const [now, setNow] = useState(() => Date.now());
  const act = (make: (at: number) => BoardAction) => {
    const at = Date.now();
    setNow(at);
    dispatch(make(at));
  };

  const fading = game.seats.some((s) => liveDelta(s, now) !== 0n);
  const timing = game.setup.timerSeconds > 0 && !game.paused;
  // 80ms is the fade's step, smooth enough for an opacity; under reduced motion the figure holds
  // still and only has to go at the end, and the timer only has to change its seconds.
  const period = fading && !reduced ? 80 : fading || timing ? 250 : null;
  useEffect(() => {
    if (period === null) return;
    const id = window.setInterval(() => setNow(Date.now()), period);
    return () => window.clearInterval(id);
  }, [period]);

  // An open stepper shuts itself a few seconds after its last press.
  useEffect(() => {
    if (view.stepper === null) return;
    const id = window.setTimeout(() => dispatch({ type: "closeStepper" }), STEPPER_MS);
    return () => window.clearTimeout(id);
  }, [view.stepper, view.stepperStamp]);

  // ---- The saved game. Every change, after a short quiet; and at once when the page is hidden or
  // thrown away, or the board leaves — Android can kill a hidden app without another word.
  const ended = useRef(false);
  const latest = useRef(game);
  useEffect(() => {
    latest.current = game;
    if (ended.current) return;
    const id = window.setTimeout(() => saveGame(game, Date.now()), SAVE_MS);
    return () => window.clearTimeout(id);
  }, [game]);
  useEffect(() => {
    const flush = () => {
      if (!ended.current) saveGame(latest.current, Date.now());
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
      flush();
    };
  }, []);

  // ---- Geometry. Nothing that depends on it exists until the board has a size.
  const W = size?.width ?? 0;
  const H = size?.height ?? 0;
  const n = game.seats.length;
  const plan: SeatPlan | null = size
    ? seatPlan(n, game.setup.layout, resolveSeating(game.setup, W), W, H)
    : null;
  const geometry = useRef<{ plan: SeatPlan; W: number; H: number } | null>(null);
  useLayoutEffect(() => {
    geometry.current = plan ? { plan, W, H } : null;
  });

  // ---- Back. The board itself is a step whose Back asks before ending the game; every overlay
  // over it is a step above that, closed by its own Back. Later claims sit above earlier ones, so
  // Back closes the topmost first. A host that lends no Back (the desktop face, a test) makes
  // these nothing.
  useBackClaim({ enabled: true, onBack: () => dispatch({ type: "confirm", ask: "leave" }) });
  useBackClaim({
    enabled: view.cmdFor !== null,
    onBack: () => dispatch({ type: "commander", seat: null }),
  });
  useBackClaim({ enabled: view.menu, onBack: () => dispatch({ type: "menu", open: false }) });
  useBackClaim({ enabled: view.edit !== null, onBack: () => dispatch({ type: "closeCalc" }) });

  // ---- Holds and swipes. Refs, because they live between a press going down and the click
  // after it comes up, and none of it is drawn.
  const longTimer = useRef(0);
  const longFired = useRef(false);
  const swipe = useRef<{ seat: number; x: number; y: number; at: number } | null>(null);

  const openCalc = (seat: number) => act((at) => ({ type: "openCalc", seat, now: at }));

  /**
   * A press going down on a half of a panel. A tap is one life; a press held for half a second
   * anywhere on the panel opens the calculator instead, and the release that follows counts for
   * nothing. The same press is where a swipe starts: in a Commander game a swipe up a panel — up
   * as its player sees it — opens that player's commander damage, as their shield chip does, and
   * a swipe down closes it again.
   */
  const holdLife = (seat: number, e: PointerEvent) => {
    longFired.current = false;
    window.clearTimeout(longTimer.current);
    longTimer.current = window.setTimeout(() => {
      longFired.current = true;
      openCalc(seat);
    }, HOLD_MS);
    swipe.current = { seat, x: e.clientX, y: e.clientY, at: Date.now() };
  };

  const tapLife = (seat: number, by: 1 | -1) => {
    if (longFired.current) {
      longFired.current = false;
      return;
    }
    act((at) => ({ type: "tap", seat, by, now: at }));
  };

  const letGo = () => window.clearTimeout(longTimer.current);

  /**
   * On release: far enough, quick enough, and more up than across, **measured in the panel's own
   * turned frame**, so "up" is away from the player whichever edge of the table they sit at. Up
   * opens the swiped panel's commander damage; down closes it, read on the panel whose damage is
   * open (or, with one player, on an opponent's tile inside it). A swipe on another player's panel
   * is theirs, not a way out of this view.
   */
  const swipeEnd = (e: PointerEvent) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    // A finger that travelled was not tapping − or +: a drag the wrong way changes nothing.
    if (Math.hypot(dx, dy) > TAP_SLOP_PX) longFired.current = true;
    if (!game.setup.commander || view.edit || view.spin || view.menu || !plan) return;
    const closing = view.cmdFor !== null;
    if (closing && s.seat !== view.cmdFor && s.seat < n) return;
    const rect = plan.seats[closing ? view.cmdFor! : s.seat];
    if (!rect) return;
    const { up, across } = inSeatFrame(rect.rot, dx, dy);
    const far = closing ? -up : up;
    if (far < SWIPE_PX || far < Math.abs(across) * 1.5 || Date.now() - s.at > SWIPE_MS) return;
    window.clearTimeout(longTimer.current);
    // The click that follows the release is not a tap on − or +.
    longFired.current = true;
    dispatch({ type: "commander", seat: closing ? null : s.seat });
  };

  // ---- Who goes first, as a roulette. The light runs round the living seats in table order,
  // quick at first and slower with every step, and stops on a seat chosen before it started; the
  // landing — a chime, the panel swelling, its ring blinking, the confetti — starts there. The
  // other seats stay dimmed while the confetti is in the air, because it is pale and they are what
  // it shows against. The board is back in play by 4.9s.
  const spinTimers = useRef<number[]>([]);
  const sound = useRef<RouletteSound | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stopConfetti = useRef<(() => void) | undefined>(undefined);

  const fireConfetti = (seat: number) => {
    const canvas = canvasRef.current;
    const at = geometry.current;
    if (reduced || !canvas || !at) return;
    const r = at.plan.seats[seat];
    if (!r) return;
    const cx = PAD + r.x * (at.W - 2 * PAD) + (r.w * (at.W - 2 * PAD)) / 2;
    const cy = PAD + r.y * (at.H - 2 * PAD) + (r.h * (at.H - 2 * PAD)) / 2;
    stopConfetti.current?.();
    stopConfetti.current = throwConfetti(canvas, cx, cy, r.rot, `${seat}:${Date.now()}`);
  };

  const pickFirst = () => {
    spinTimers.current.forEach((id) => window.clearTimeout(id));
    spinTimers.current = [];
    const alive = livingSeats(game);
    if (alive.length === 0) {
      dispatch({ type: "menu", open: false });
      return;
    }
    const run = alive.length === 1 ? 0 : SPIN_RUN_MS;
    const start = Math.floor(Math.random() * alive.length);
    const winner = Math.floor(Math.random() * alive.length);
    // Round the table a few times — fewer laps the more seats — and on to the winner.
    const steps =
      alive.length === 1
        ? 0
        : Math.max(2, Math.round(16 / alive.length)) * alive.length +
          ((winner - start + alive.length) % alive.length);
    const later = (ms: number, fn: () => void) => {
      spinTimers.current.push(window.setTimeout(fn, ms));
    };
    dispatch({ type: "spinStart", at: alive[start] });

    // The sound is put on the audio clock up front — a tick for every seat the light lands on,
    // then the chime — so it keeps time with the light however busy the page is. Made on this
    // press, which is the user gesture a browser asks for before it will play anything.
    sound.current ??= new RouletteSound();
    const voice = sound.current;
    voice.stopAll();
    const t0 = voice.start();
    if (t0 !== null) voice.tickAt(t0);
    for (let k = 1; k <= steps; k++) {
      const u = k / steps;
      const when = run * (0.25 * u + 0.75 * u ** 2.6);
      if (t0 !== null) voice.tickAt(t0 + when / 1000);
      const seat = alive[(start + k) % alive.length];
      later(when, () => dispatch({ type: "spinStep", at: seat }));
    }
    if (t0 !== null) voice.chimeAt(t0 + (run + 80) / 1000);
    const landed = alive[winner];
    later(run + 80, () => {
      dispatch({ type: "spinLand" });
      fireConfetti(landed);
    });
    [240, 380, 520, 660].forEach((ms, k) =>
      later(run + ms, () => dispatch({ type: "spinBlink", blink: k % 2 === 1 })),
    );
    later(run + 1900, () => act((at) => ({ type: "spinEnd", now: at })));
  };

  useEffect(
    () => () => {
      window.clearTimeout(longTimer.current);
      spinTimers.current.forEach((id) => window.clearTimeout(id));
      stopConfetti.current?.();
      sound.current?.close();
    },
    [],
  );

  // ---- The end of the game.
  const confirmEnd = (ask: EndAsk) => {
    if (ask === "leave") {
      ended.current = true;
      clearSavedGame();
      dispatch({ type: "confirm", ask: null });
      onLeave();
      return;
    }
    act((at) => ({ type: "restart", now: at }));
  };

  const panelActions: PanelActions = {
    dispatch,
    holdLife,
    tapLife,
    openCalc,
    passTurn: () => act((at) => ({ type: "passTurn", now: at })),
    pressChip: (e) => {
      // A press on a stepper stays its own: it does not shut the stepper it is opening.
      e.stopPropagation();
      dispatch({ type: "pressChip" });
    },
  };

  const colors = seatColors(game);
  const common = plan ? commonSize(plan, W, H) : 0;
  // While a seat's commander damage is open its player reads and counts every panel, so every
  // panel faces them. The numbers keep the board's one size where a panel has the room for it.
  const drawn = plan && view.cmdFor !== null ? facingSeat(plan, view.cmdFor) : plan;
  // The calculator faces the player whose total it sets: for commander damage, the player it was
  // dealt to, who is the one counting it — not the commander's own seat.
  const editRect = plan && view.edit ? plan.seats[view.edit.seat] : null;

  return (
    <>
      <div
        ref={rootRef}
        // Any press on the board shuts an open stepper and is the "first press" that takes the
        // goes-first chip away; the press still does what it was aimed at.
        onPointerDown={() => dispatch({ type: "pressElsewhere" })}
        onPointerMove={(e) => {
          const s = swipe.current;
          if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > HOLD_SLOP_PX) letGo();
        }}
        onPointerUp={(e) => {
          swipeEnd(e);
          letGo();
        }}
        onPointerCancel={() => {
          swipe.current = null;
          letGo();
        }}
        onPointerLeave={() => {
          swipe.current = null;
          letGo();
        }}
        // A held press is the calculator, not the platform's long-press menu.
        onContextMenu={(e) => e.preventDefault()}
        // `touch-none`: the page this sits in pans, and a swipe up a panel is the board's.
        className="relative isolate size-full touch-none overflow-hidden bg-bg font-sans text-sm leading-[1.43] text-text select-none [-webkit-touch-callout:none]"
      >
        {plan && (
          <>
            {plan.blanks.map((b, k) => {
              const box = seatBox(b, W, H);
              return (
                <div
                  key={`blank${k}`}
                  aria-hidden
                  className="absolute box-border rounded-[var(--radius)] border border-dashed border-border"
                  style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
                />
              );
            })}

            {plan.seats.map((own, i) => {
              const rect = drawn?.seats[i] ?? own;
              return (
                <SeatPanel
                  key={i}
                  game={game}
                  view={view}
                  seat={i}
                  box={seatBox(rect, W, H)}
                  keep={hubRoom(rect, plan.hub, W, H)}
                  common={common}
                  glyphsUnder={quarterApart(rect.rot, own.rot)}
                  colors={colors}
                  now={now}
                  reduced={reduced}
                  act={panelActions}
                />
              );
            })}

            {!reduced && (
              <canvas
                ref={canvasRef}
                aria-hidden
                className={cn("pointer-events-none absolute inset-0 size-full", LAYER.stage)}
              />
            )}

            {view.spin && (
              // The veil that keeps the board still while the light runs: a press here would
              // change a total under a roulette that is choosing between them.
              <div
                role="status"
                aria-label="Picking who goes first"
                className={cn("absolute inset-0", LAYER.stage)}
              />
            )}

            <button
              type="button"
              aria-label="Game menu"
              onClick={() => dispatch({ type: "menu", open: true })}
              className={cn(
                "absolute box-border flex size-12 cursor-pointer items-center justify-center rounded-full border-2 border-border bg-bg p-0 text-text",
                PRESS_STILL,
                "active:scale-[0.86]",
                FOCUS,
                LAYER.header,
              )}
              style={{
                left: Math.round((plan.hub.x * W - HUB_RADIUS) * 10) / 10,
                top: Math.round((plan.hub.y * H - HUB_RADIUS) * 10) / 10,
              }}
            >
              <Menu aria-hidden size={20} strokeWidth={2} />
            </button>

            {view.edit && editRect && (
              <CalculatorDialog
                game={game}
                edit={view.edit}
                rot={editRect.rot}
                dispatch={dispatch}
              />
            )}
            {view.menu && <GameMenu game={game} dispatch={dispatch} onPickFirst={pickFirst} />}
          </>
        )}
      </div>
      <EndGameDialog
        ask={view.confirm}
        onKeep={() => dispatch({ type: "confirm", ask: null })}
        onConfirm={confirmEnd}
      />
    </>
  );
}
