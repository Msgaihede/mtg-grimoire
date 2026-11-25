/**
 * One seat's panel: its life total, or — while some seat's commander damage is being counted —
 * either that count's heading (the counted seat) or what this seat's commander has dealt it.
 *
 * Everything is laid out in the panel's own turned frame: the panel is a box on the board, and
 * inside it one `lw` × `lh` frame turned to face its player (`seating.ts`), so "top" below is the
 * edge furthest from the player whichever side of the table they sit at. While a seat's commander
 * damage is open, every other panel's frame faces *that* seat's player instead (`facingSeat`):
 * they read every count and press every − and +.
 *
 * **No names on the board**: a seat is its colour. Another seat is named on this one by a dot of
 * its colour, and everything that used to stand in the top row as words — dead, lethal, goes
 * first — is said on the one line under the number instead, which leaves the top row to its chips
 * and the number free to be as large as the panel allows. Names are for a screen reader, which
 * reads each panel as a region called "Player N".
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { animate, motion, useMotionValue, type MotionValue } from "motion/react";
import { Shield, Skull } from "lucide-react";
import { FOCUS_INSET } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { holdSqueeze, NUMBER_POP, SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  chipZoom,
  grown,
  numberButtonWidth,
  ownLifeSize,
  placeNumber,
  skullSize,
  underHigh,
} from "../game/fit";
import {
  isDead,
  lethalFrom,
  liveDelta,
  playerName,
  turnClock,
  FADE_MS,
  LETHAL_COMMANDER,
  type GameState,
  type Stepper,
  type ViewState,
} from "../game/gameState";
import { deltaText, grouped, humanize } from "../game/lifeNumber";
import type { HubRoom, SeatBox } from "../game/seating";
import {
  BlessChip,
  CommanderChip,
  CROWN_GOLD,
  CrownChip,
  Mark,
  StepperChip,
  TurnPill,
} from "./chips";
import { LifeHalves } from "./LifeHalves";
import { BackButton, OwnLife, type PanelActions } from "./panelParts";
import { SoloCommanderView } from "./SoloCommanderView";

export interface SeatPanelProps {
  game: GameState;
  view: ViewState;
  seat: number;
  box: SeatBox;
  keep: HubRoom;
  /** The one size every number on the board is drawn at (`commonSize`). */
  common: number;
  /** Its − and + go under its number: this panel is turned a quarter from its own seat, to face
   *  the seat whose commander damage is open, and is too narrow for them beside it. */
  glyphsUnder: boolean;
  colors: string[];
  now: number;
  reduced: boolean;
  act: PanelActions;
  /** A press is being held on this panel: it sinks over the hold (`holdSqueeze`). */
  held?: boolean;
  /** How long that hold is, which is how long the sink takes. */
  holdMs?: number;
  /** A commander swipe is on this panel: how far it follows the finger, in its own frame. */
  pull?: MotionValue<number> | null;
}

/**
 * `next` as the turn nearest `from` — the same angle, give or take whole turns — so a panel turning
 * to face another player takes the short way round: 180° to −90° is a quarter turn, not three.
 */
export function nearestTurn(from: number, next: number): number {
  return from + ((((next - from) % 360) + 540) % 360) - 180;
}

/**
 * What the life total just moved by, under the number: bare numerals, green up and red down. On a
 * seat colour they are the system's green and red taken deep enough to read on all six; on a dark
 * panel the tokens as they stand; on the counted seat's shaded colour, light.
 */
function deltaInk(delta: bigint, target: boolean, dark: boolean): string {
  const up = delta > 0n;
  if (target) {
    return up
      ? "oklch(from var(--color-ok) 0.93 0.12 h)"
      : "oklch(from var(--color-destructive) 0.9 0.08 h)";
  }
  if (dark) return up ? "var(--color-ok)" : "var(--color-destructive)";
  return up
    ? "oklch(from var(--color-ok) 0.37 0.12 h)"
    : "oklch(from var(--color-destructive) 0.4 0.17 h)";
}

/** A stepper's open state on this seat. */
function isOpen(stepper: Stepper | null, kind: Stepper["kind"], seat: number): boolean {
  if (stepper === null || stepper.kind !== kind) return false;
  return !("seat" in stepper) || stepper.seat === seat;
}

export function SeatPanel({
  game,
  view,
  seat: i,
  box,
  keep,
  common,
  glyphsUnder,
  colors,
  now,
  reduced,
  act,
  held = false,
  holdMs = 0,
  pull = null,
}: SeatPanelProps) {
  const { lw, lh } = box;
  // The angle drawn, kept unwrapped (React's derived-state pattern), so the turn takes the short
  // way round whatever the seating module calls the new one.
  const [turn, setTurn] = useState(box.rot);
  const [lastRot, setLastRot] = useState(box.rot);
  if (box.rot !== lastRot) {
    setLastRot(box.rot);
    setTurn(nearestTurn(turn, box.rot));
  }
  const n = game.seats.length;
  const seat = game.seats[i];
  const name = playerName(i);
  const { setup } = game;
  const lethal = lethalFrom(game, i);
  const dead = isDead(game, i);
  const inCmd = view.cmdFor !== null;
  const target = inCmd && view.cmdFor === i;
  const source = inCmd && !target;
  const dark = target || (dead && !source);
  const spin = view.spin;
  const active =
    !spin && !inCmd && !dead && game.turn === i && (setup.timerSeconds > 0 || game.picked);
  const lit = spin !== null && spin.at === i;

  const value = source ? BigInt(game.dmg[view.cmdFor!][i]) : seat.life;
  const shown = humanize(value);
  const own = humanize(seat.life);

  const roomy = lw >= 330;
  let sub: string;
  let subDot = -1;
  if (source) {
    sub =
      (value >= LETHAL_COMMANDER ? "Lethal · " : "") + (roomy ? "Commander damage to" : "Dealt to");
    subDot = view.cmdFor!;
  } else if (dead && seat.life > 0n && lethal >= 0) {
    sub = `${game.dmg[i][lethal]}${roomy ? " commander damage from" : " from"}`;
    subDot = lethal;
  } else if (dead && seat.life > 0n) {
    sub = `${seat.poison} poison`;
  } else {
    sub = shown.exact;
  }

  const first = active && game.picked;
  const delta = liveDelta(seat, now);
  const age = seat.movedAt ? Math.min(1, Math.max(0, (now - seat.movedAt) / FADE_MS)) : 0;
  // The figure fades the whole five seconds, gently at first so it stays readable. Under reduced
  // motion it holds at full strength and goes at the end.
  const deltaLook: CSSProperties = {
    color: deltaInk(delta, target, dark),
    opacity: reduced ? 1 : Number((1 - age * age).toFixed(2)),
  };
  const movedHigh = underHigh(lw, lh);
  const grow = grown(lw, lh);
  const zoom = chipZoom(n, lw, lh);
  const time = setup.timerSeconds > 0 ? turnClock(game, now) : null;
  const showPill = active && time !== null;
  const showMonarch = game.monarchOn && !inCmd;
  const isMonarch = showMonarch && game.monarch === i;

  // The monarch's border is one ring of bright gold, drawn wholly outside the panel in the dark
  // gap, where gold reads against every seat colour. The gap is 6px, so when the monarch is also
  // the player to move, the turn ring moves inside the panel instead of fighting the gold for it.
  const rings: string[] = [];
  if (isMonarch) rings.push(`0 0 0 5px ${CROWN_GOLD}`);
  if (active)
    rings.push(isMonarch ? "inset 0 0 0 3px var(--color-text)" : "0 0 0 3px var(--color-text)");
  if (dark && !target) rings.push("inset 0 0 0 1px var(--color-border)");
  if (lit) rings.unshift(`0 0 0 ${spin.landed && !spin.blink ? 2 : 5}px var(--color-text)`);

  // The counted seat is not dark like a dead one: it is the seat's own colour in shadow — exactly
  // the shade the panel takes under the menu's backdrop (the app's ground at 72%). Still that
  // player's, plainly not their life view, and not the flat black of a dead seat. Its small print
  // is light text held back a little, not the dark theme's dim grey, which would sink into it.
  const background = target
    ? `color-mix(in srgb, var(--color-bg) 72%, ${colors[i]})`
    : dark
      ? "var(--color-surface)"
      : colors[i];

  const frame: CSSProperties = {
    left: box.x,
    top: box.y,
    width: box.w,
    height: box.h,
    background,
    boxShadow: rings.length ? rings.join(",") : "none",
    // While the roulette runs the seat the light is on is at full strength and every other seat
    // is dimmed; on landing the seat swells (not under reduced motion — it is travel).
    opacity: spin && !lit ? 0.32 : 1,
    transform: lit && spin.landed && !reduced ? "scale(1.05)" : undefined,
    transition: reduced
      ? undefined
      : "opacity 0.07s linear, transform 0.22s cubic-bezier(0.2, 1.6, 0.4, 1), box-shadow 0.1s linear",
    ...(target ? { "--color-dim": "color-mix(in oklab, var(--color-text) 78%, transparent)" } : {}),
  } as CSSProperties;

  const turned: CSSProperties = {
    width: lw,
    height: lh,
    transform: `translate(-50%, -50%) rotate(${turn}deg)`,
    color: dark ? "var(--color-dim)" : "var(--color-accent-fg)",
  };

  const solo = target && n === 1;
  const minusLabel = source ? `One less commander damage from ${name}` : `${name} loses 1 life`;
  const plusLabel = source ? `One more commander damage from ${name}` : `${name} gains 1 life`;

  const targetLine = !dead
    ? "Life total"
    : seat.life <= 0n
      ? "Dead: life at 0 or less"
      : lethal >= 0
        ? "Dead: lethal commander damage"
        : `Dead: ${seat.poison} poison counters`;

  return (
    <section
      aria-label={name}
      className={cn(
        "absolute overflow-hidden rounded-[var(--radius)]",
        (isMonarch || lit) && LAYER.raised,
      )}
      style={frame}
    >
      <div
        // **The panels turn to face the counted player** as commander damage opens, and back as it
        // closes (2026-11-25): a quarter or a half turn on the `slow` tier, the short way round.
        // A CSS tween, not a spring: nothing interrupts it, and the transform is read as written.
        className="absolute top-1/2 left-1/2 transition-transform duration-[var(--duration-slow)] ease-standard motion-reduce:transition-none"
        style={turned}
      >
        {/* The panel's body, in its own turned frame: it sinks under a held press and follows a
            commander swipe along "up" as its player sees it — both a finger's, so both springs. */}
        <motion.div
          className="absolute inset-0"
          initial={false}
          animate={held && !reduced ? holdSqueeze(holdMs) : { scale: 1, transition: SPRING.press }}
          style={pull === null ? undefined : { y: pull }}
        >
          {solo ? (
            <SoloCommanderView
              game={game}
              box={box}
              keep={keep}
              colors={colors}
              ownText={own.text}
              ownInk={dead ? "var(--color-dim)" : "var(--color-text)"}
              targetLine={targetLine}
              delta={delta}
              deltaLook={deltaLook}
              movedHigh={movedHigh}
              act={act}
            />
          ) : target ? (
            <TargetView
              dark={dark}
              dotColor={colors[i]}
              lw={lw}
              lh={lh}
              ownText={own.text}
              ownInk={dead ? "var(--color-dim)" : "var(--color-text)"}
              targetLine={targetLine}
              delta={delta}
              deltaLook={deltaLook}
              movedHigh={movedHigh}
              minusLabel={minusLabel}
              plusLabel={plusLabel}
              seat={i}
              act={act}
            />
          ) : (
            <CountView
              {...{ game, view, i, box, keep, common, colors, act, dark, dead, source, active }}
              {...{
                name,
                shown,
                value,
                sub,
                subDot,
                first,
                delta,
                deltaLook,
                movedHigh,
                grow,
                zoom,
              }}
              {...{ time, showPill, showMonarch, isMonarch, minusLabel, plusLabel, glyphsUnder }}
              reduced={reduced}
            />
          )}
        </motion.div>
      </div>
    </section>
  );
}

interface CountViewProps {
  game: GameState;
  view: ViewState;
  i: number;
  box: SeatBox;
  keep: HubRoom;
  common: number;
  glyphsUnder: boolean;
  colors: string[];
  act: PanelActions;
  dark: boolean;
  dead: boolean;
  source: boolean;
  active: boolean;
  name: string;
  shown: { text: string; exact: string };
  value: bigint;
  sub: string;
  subDot: number;
  first: boolean;
  delta: bigint;
  deltaLook: CSSProperties;
  movedHigh: number;
  grow: number;
  zoom: number;
  time: { text: string; over: boolean } | null;
  showPill: boolean;
  showMonarch: boolean;
  isMonarch: boolean;
  minusLabel: string;
  plusLabel: string;
  reduced: boolean;
}

/**
 * The number's pop: it grows to `NUMBER_POP` the moment `value` changes and springs back — a tap
 * counted where it was made. Not on the first draw, and not under reduced motion.
 */
function usePop(value: bigint, reduced: boolean): MotionValue<number> {
  const scale = useMotionValue(1);
  const last = useRef(value);
  useEffect(() => {
    if (last.current === value) return;
    last.current = value;
    if (reduced) return;
    scale.set(NUMBER_POP);
    void animate(scale, 1, SPRING.press);
  }, [value, reduced, scale]);
  return scale;
}

/** The life view: the number, its line, and the chips round it. */
function CountView(p: CountViewProps) {
  const { game, view, i, box, keep, colors, act, dark, dead, source } = p;
  const { lw, lh } = box;
  const n = game.seats.length;
  const seat = game.seats[i];
  const { setup } = game;
  const inCmd = view.cmdFor !== null;
  const place = placeNumber({
    lw,
    lh,
    chars: p.shown.text.length,
    common: p.common,
    keep,
    solo: n === 1,
    commanderBand: setup.commander,
    under: p.glyphsUnder,
  });

  // The shield is filled with the colour of whoever has dealt this seat the most; empty at none.
  let worst = 0;
  let worstFrom = -1;
  game.dmg[i].forEach((taken, j) => {
    if (taken > worst) {
      worst = taken;
      worstFrom = j;
    }
  });
  const foesTaken = game.dmg[i].slice(n);

  const tag = p.first && setup.timerSeconds === 0 ? "Goes first" : "";
  const showBless = game.blessOn && i === 0 && !inCmd;
  const showTax = setup.commander && n === 1 && !inCmd;
  const taxOpen = isOpen(view.stepper, "tax", i);
  const poisonOpen = isOpen(view.stepper, "poison", i);
  const showSub = p.sub !== "" && (p.delta === 0n || source);
  const showDelta = p.delta !== 0n && !source;
  const step = (stepper: Stepper, by: number) => act.dispatch({ type: "stepper", stepper, by });
  const pop = usePop(p.value, p.reduced);

  const counter = (kind: "energy" | "xp", on: boolean, said: string) => {
    if (!on || inCmd || i !== 0) return null;
    const open = isOpen(view.stepper, kind, i);
    const count = seat[kind];
    return (
      <StepperChip
        key={kind}
        dark={dark}
        open={open}
        label={`${p.name} has ${count} ${said}. ${open ? "Close" : "Change"}`}
        lessLabel={`One less ${said} for ${p.name}`}
        moreLabel={`One more ${said} for ${p.name}`}
        onToggle={() => step({ kind }, 0)}
        onLess={() => step({ kind }, -1)}
        onMore={() => step({ kind }, 1)}
        onPointerDown={act.pressChip}
      >
        <Mark count={count}>
          {kind === "energy" ? (
            <i className="ms ms-e text-[18px]" />
          ) : (
            <span className="font-sans text-xs font-bold tracking-[0.02em]">XP</span>
          )}
        </Mark>
        {String(count)}
      </StepperChip>
    );
  };

  return (
    <div className="absolute inset-0">
      <LifeHalves
        minusLabel={p.minusLabel}
        plusLabel={p.plusLabel}
        dark={dark}
        onMinus={() => act.tapLife(i, -1)}
        onPlus={() => act.tapLife(i, 1)}
        onPointerDown={(e) => act.holdLife(i, e)}
        drop={place.glyphDrop}
        zoom={p.grow}
        under={p.glyphsUnder ? place.glyphLift : undefined}
      />

      {/* The top row. From two players it stands in from the corners, where the menu button can
          sit; one player's corners are free, so their chips go right into them. */}
      <div
        className="pointer-events-none absolute top-1 flex h-9 items-center gap-1.5"
        style={{ zoom: p.zoom, left: n === 1 ? 10 : 30, right: n === 1 ? 10 : 30 }}
      >
        {dark && (
          <span className="size-2 shrink-0 rounded-full" style={{ background: colors[i] }} />
        )}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[13px] font-semibold",
            dead && !source && "font-heading tracking-[0.12em] text-text uppercase",
          )}
        >
          {dead && !source ? "Dead" : ""}
        </span>
        {tag && (
          <span className="order-[-1] -ml-1 shrink-0 rounded-full bg-accent-fg px-[9px] py-1.5 font-sans text-xs leading-none font-semibold text-text">
            {tag}
          </span>
        )}
        {p.showPill && p.time && (
          <TurnPill
            clock={p.time.text}
            over={p.time.over}
            first={p.first}
            label={
              (p.first ? "Goes first. " : "") +
              "End the turn. " +
              (p.time.over ? `Over time by ${p.time.text.slice(1)}` : `${p.time.text} left`)
            }
            onPress={act.passTurn}
          />
        )}
        {showBless && (
          <BlessChip
            dark={dark}
            blessed={seat.blessed}
            label={
              seat.blessed
                ? `${p.name} has the city’s blessing. Take it away`
                : `Give ${p.name} the city’s blessing`
            }
            pull={p.showMonarch ? -12 : -7}
            onPress={() => act.dispatch({ type: "bless" })}
          />
        )}
        {p.showMonarch && (
          <CrownChip
            dark={dark}
            monarch={p.isMonarch}
            label={
              p.isMonarch
                ? `${p.name} is the monarch. Take the crown away`
                : `Make ${p.name} the monarch`
            }
            onPress={() => act.dispatch({ type: "crown", seat: i })}
          />
        )}
      </div>

      {dead && !source && (
        <div
          aria-hidden
          className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 opacity-[0.16]"
        >
          <Skull size={skullSize(lw, lh)} strokeWidth={1.25} />
        </div>
      )}

      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-start">
        <div className="relative flex shrink-0 justify-center" style={{ marginTop: place.top }}>
          <motion.span
            aria-hidden
            className="font-mono leading-none font-semibold tracking-[-0.02em] whitespace-nowrap tabular-nums"
            style={{ fontSize: place.size, scale: pop }}
          >
            {p.shown.text}
          </motion.span>
          {/* Fingers never land on this: it lets presses through to the − and + beneath. It
              stays in the page so a keyboard or a screen reader, which cannot hold a press, can
              still open the calculator. */}
          <button
            type="button"
            aria-label={
              source
                ? `${p.name} has dealt ${p.value} commander damage. Set the damage`
                : `${p.name} is at ${grouped(seat.life)} life. Set the life total`
            }
            onClick={() => act.openCalc(i)}
            className={cn(
              "pointer-events-none absolute top-0 bottom-0 left-1/2 -translate-x-1/2 border-0 bg-transparent p-0",
              FOCUS_INSET,
            )}
            style={{ width: numberButtonWidth(lw, p.shown.text.length, place.size) }}
          />
        </div>
        <div
          className="flex shrink-0 items-center justify-center whitespace-nowrap"
          style={{
            height: p.movedHigh,
            marginTop: place.underLift,
            maxWidth: place.lineWidth,
          }}
        >
          {showSub && (
            <span
              className={cn(
                "min-w-0 truncate text-center text-xs leading-[1.33]",
                dark ? "text-dim" : "opacity-85",
              )}
            >
              {p.sub}
              {p.subDot >= 0 && (
                <span
                  className="ml-[5px] inline-block size-2.5 rounded-full align-[-1px] shadow-[0_0_0_1.5px_currentColor]"
                  style={{ background: colors[p.subDot] }}
                />
              )}
            </span>
          )}
          {/* Always mounted, filled and emptied: a live region mounted with its words inside is
              one a screen reader never hears. */}
          <span
            aria-live="polite"
            className="inline-flex items-center font-mono leading-none font-bold tabular-nums"
            style={{ height: p.movedHigh, fontSize: p.movedHigh - 2, ...p.deltaLook }}
          >
            {showDelta ? deltaText(p.delta) : ""}
          </span>
        </div>
      </div>

      {/* Commander damage and tax. From two players, the shield in the bottom left. One player's
          are a band of their own above the total, centred: along the top edge on its side, under
          the menu button upright, the tax dropping to a second row if the band runs out. */}
      <div
        className={cn(
          "pointer-events-none absolute flex items-center",
          n === 1 ? "right-1.5 left-1.5 flex-wrap justify-center" : "bottom-0.5 left-1.5 min-h-11",
        )}
        style={{ zoom: p.zoom, top: n === 1 ? (lw > lh ? 4 : 50) : undefined }}
      >
        {setup.commander && !inCmd && (
          <CommanderChip
            dark={dark}
            zoom={n === 1 ? 1.25 : 1}
            text={n === 1 ? "" : String(worst)}
            fill={n === 1 || worstFrom < 0 ? "none" : colors[worstFrom]}
            badges={
              n === 1
                ? foesTaken.map((taken, k) => ({
                    text: String(taken),
                    color: colors[n + k],
                    lethal: taken >= LETHAL_COMMANDER,
                  }))
                : []
            }
            label={
              n === 1
                ? `Commander damage dealt to ${p.name}: ${foesTaken.join(", ")}. Open`
                : `Commander damage dealt to ${p.name}, ${worst} at most from one commander. Open`
            }
            onOpen={() => act.dispatch({ type: "commander", seat: i })}
          />
        )}
        {showTax && (
          <StepperChip
            dark={dark}
            open={taxOpen}
            sans
            label={`Commander tax is ${seat.tax}. ${taxOpen ? "Close" : "Change"}`}
            lessLabel="Commander tax down by 2"
            moreLabel="Commander played: tax up by 2"
            onToggle={() => step({ kind: "tax", seat: i }, 0)}
            onLess={() => step({ kind: "tax", seat: i }, -2)}
            onMore={() => step({ kind: "tax", seat: i }, 2)}
            onPointerDown={act.pressChip}
          >
            Tax
            <span
              className="box-border inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full border-[1.5px] border-current px-[3px] font-mono text-xs leading-none font-semibold"
              style={{ opacity: seat.tax > 0 ? 1 : 0.5 }}
            >
              {seat.tax}
            </span>
          </StepperChip>
        )}
      </div>

      {/* The counters, bottom right. On its side, one player's menu button sits in the middle of
          the bottom edge: the counters keep to the half beyond it and wrap upwards short of it. */}
      <div
        className={cn(
          "pointer-events-none absolute right-1.5 bottom-0.5 flex min-h-11 items-center justify-end",
          n === 1 ? "flex-wrap-reverse" : "flex-nowrap",
        )}
        style={{ zoom: p.zoom, left: n === 1 && lw > lh ? "calc(50% + 30px)" : 6 }}
      >
        {counter("energy", game.energyOn, "energy")}
        {counter("xp", game.xpOn, "experience")}
        {game.poisonOn && !inCmd && (
          <StepperChip
            dark={dark}
            open={poisonOpen}
            label={`${p.name} has ${seat.poison} poison. ${poisonOpen ? "Close" : "Change"}`}
            lessLabel={`One less poison for ${p.name}`}
            moreLabel={`One more poison for ${p.name}`}
            onToggle={() => step({ kind: "poison", seat: i }, 0)}
            onLess={() => step({ kind: "poison", seat: i }, -1)}
            onMore={() => step({ kind: "poison", seat: i }, 1)}
            onPointerDown={act.pressChip}
          >
            {/* The Phyrexian symbol, Magic's own mark for poison. */}
            <Mark count={seat.poison}>
              <i className="ms ms-p text-[18px]" />
            </Mark>
            {String(seat.poison)}
          </StepperChip>
        )}
      </div>
    </div>
  );
}

interface TargetViewProps {
  dark: boolean;
  dotColor: string;
  lw: number;
  lh: number;
  ownText: string;
  ownInk: string;
  targetLine: string;
  delta: bigint;
  deltaLook: CSSProperties;
  movedHigh: number;
  minusLabel: string;
  plusLabel: string;
  seat: number;
  act: PanelActions;
}

/**
 * The counted seat, while its commander damage is open: every other panel now shows what its
 * commander has dealt this seat, and this one keeps its own life total between its − and +, with
 * the way back.
 */
function TargetView(p: TargetViewProps) {
  const { act, seat } = p;
  return (
    <div className="absolute inset-0">
      <LifeHalves
        minusLabel={p.minusLabel}
        plusLabel={p.plusLabel}
        dark={p.dark}
        onMinus={() => act.tapLife(seat, -1)}
        onPlus={() => act.tapLife(seat, 1)}
        onPointerDown={(e) => act.holdLife(seat, e)}
      />
      <div className="pointer-events-none absolute top-1.5 right-[30px] left-[30px] flex h-6 items-center gap-1.5 text-text">
        <span className="size-2 shrink-0 rounded-full" style={{ background: p.dotColor }} />
        <Shield aria-hidden size={14} strokeWidth={2.25} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
          Commander damage taken
        </span>
      </div>
      <div className="pointer-events-none absolute top-[30px] right-0 bottom-12 left-0 flex flex-col items-center justify-center gap-0.5">
        <OwnLife {...p} size={ownLifeSize(p.lw, p.lh, p.ownText.length)} high={p.movedHigh} />
      </div>
      <div className="pointer-events-none absolute right-0 bottom-0.5 left-0 flex h-11 items-center justify-center">
        <BackButton onPress={() => act.dispatch({ type: "commander", seat: null })} small />
      </div>
    </div>
  );
}
