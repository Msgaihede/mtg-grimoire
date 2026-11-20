/**
 * The small things on a panel: the counters that open into steppers, the shield, the crown, the
 * city's blessing and the turn pill.
 *
 * **Every chip is a 44px press round a 30px pill**, the design canvas's sizes: the pill is what a
 * player sees, the press round it is what a finger finds. The pill dips and darkens while the
 * press is held — `PRESS_STILL`'s transition with the pill's own `group-active:` look, so the dip
 * follows the finger and nothing is written into the page's styles.
 *
 * **On a seat's colour a chip is the panel's ink at 14%**, darkening to 30% under a finger; on a
 * dark panel (a dead seat, the counted seat of a commander damage view) it is the app's ground,
 * pressed to its border colour. The four strings are written out whole for Tailwind's scan.
 */
import type { PointerEvent, ReactNode } from "react";
import { Crown, Minus, Plus, Shield, SkipForward } from "lucide-react";
import { FOCUS } from "@/lib/focus";
import { PRESS_STILL } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** The pill's dip under a finger. */
export const DIP = `${PRESS_STILL} group-active:scale-[0.86]`;
/** A press's own dip, on the press itself (the stepper's − and +). */
const DIP_SELF = `${PRESS_STILL} active:scale-[0.86]`;

const CHIP_LIGHT =
  "bg-[color-mix(in_oklab,var(--color-accent-fg)_14%,transparent)] " +
  "group-active:bg-[color-mix(in_oklab,var(--color-accent-fg)_30%,transparent)]";
const CHIP_DARK = "bg-bg group-active:bg-border";
const TINT_LIGHT = "bg-[color-mix(in_oklab,var(--color-accent-fg)_14%,transparent)]";
const TINT_DARK = "bg-bg";

/** A chip's resting look, pressed darker. */
export const chipTone = (dark: boolean): string => (dark ? CHIP_DARK : CHIP_LIGHT);
/** A chip's resting look, unpressed: the open stepper's wrap. */
const tintTone = (dark: boolean): string => (dark ? TINT_DARK : TINT_LIGHT);

/** The bright gold of a crown, a monarch's ring and a blessing: the accent lifted to read on
 *  every seat colour and on the dark gap between panels. */
export const CROWN_GOLD = "oklch(from var(--color-accent) 0.85 0.16 h)";

const CHIP_PRESS =
  "pointer-events-auto inline-flex h-11 shrink-0 cursor-pointer items-center justify-center " +
  "border-0 bg-transparent p-0 text-inherit";

export interface StepperChipProps {
  dark: boolean;
  open: boolean;
  /** What the pill shows: a mark and the count. */
  children: ReactNode;
  /** The chip's accessible name: the count, and whether a press opens or shuts it. */
  label: string;
  lessLabel: string;
  moreLabel: string;
  onToggle: () => void;
  onLess: () => void;
  onMore: () => void;
  /** A press on the chip stays its own (see `LifeBoard`'s `pressElsewhere`). */
  onPointerDown: (e: PointerEvent) => void;
  /** The pill's font: a count is mono, the tax's word is not. */
  sans?: boolean;
}

/**
 * A counter that opens into a stepper: poison, commander tax, energy, experience. Shut, it is the
 * count on a pill a finger wide; open, the count sits tight between its − and +, and the board
 * shuts it a few seconds after the last press. One is open at a time across the whole board.
 */
export function StepperChip({
  dark,
  open,
  children,
  label,
  lessLabel,
  moreLabel,
  onToggle,
  onLess,
  onMore,
  onPointerDown,
  sans = false,
}: StepperChipProps) {
  return (
    <div
      onPointerDown={onPointerDown}
      className="pointer-events-auto inline-flex h-11 items-center"
    >
      <div
        className={cn(
          "inline-flex h-[30px] items-center rounded-full",
          open ? tintTone(dark) : "bg-transparent",
        )}
      >
        {open && (
          <button
            type="button"
            aria-label={lessLabel}
            onClick={onLess}
            className={cn(CHIP_PRESS, "w-8", DIP_SELF, FOCUS)}
          >
            <Minus aria-hidden size={16} strokeWidth={2.5} />
          </button>
        )}
        <button
          type="button"
          aria-label={label}
          aria-expanded={open}
          onClick={onToggle}
          className={cn("group", CHIP_PRESS, open ? "min-w-0" : "min-w-[52px] px-1", FOCUS)}
        >
          <span
            className={cn(
              "inline-flex h-[30px] items-center gap-1 rounded-full text-[13px] font-semibold",
              sans ? "gap-1.5 font-sans" : "font-mono",
              open ? "px-0" : cn("px-2.5", chipTone(dark)),
              DIP,
            )}
          >
            {children}
          </span>
        </button>
        {open && (
          <button
            type="button"
            aria-label={moreLabel}
            onClick={onMore}
            className={cn(CHIP_PRESS, "w-8", DIP_SELF, FOCUS)}
          >
            <Plus aria-hidden size={16} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
}

/** A count's mark, faint at nought. */
export function Mark({ count, children }: { count: number; children: ReactNode }) {
  return (
    <span aria-hidden className="shrink-0 leading-none" style={{ opacity: count > 0 ? 1 : 0.5 }}>
      {children}
    </span>
  );
}

export interface CommanderChipProps {
  dark: boolean;
  label: string;
  /** From two players: the most one commander has dealt. With one: nothing, the badges say it. */
  text: string;
  /** The shield's fill: the top dealer's colour, or `none`. */
  fill: string;
  badges: { text: string; color: string; lethal: boolean }[];
  zoom: number;
  onOpen: () => void;
}

/**
 * The shield: commander damage taken. From two players it is a summary — the most any one
 * commander has dealt this seat, the shield filled with that commander's colour — and the rest is
 * a tap away on the other panels. One player has no other panels, so their chip shows every
 * opponent at once, always, nought included: a badge in each opponent's colour, ringed in red at
 * 21, and the shield left empty.
 */
export function CommanderChip({
  dark,
  label,
  text,
  fill,
  badges,
  zoom,
  onOpen,
}: CommanderChipProps) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onOpen}
      className={cn("group", CHIP_PRESS, "min-w-[52px] px-1", FOCUS)}
      style={{ zoom }}
    >
      <span
        className={cn(
          "inline-flex h-[30px] items-center gap-1 rounded-full px-2.5 font-mono text-[13px] font-semibold",
          chipTone(dark),
          DIP,
        )}
      >
        <Shield aria-hidden size={18} strokeWidth={2} className="shrink-0" style={{ fill }} />
        {text}
        {badges.map((badge, k) => (
          <span
            key={k}
            className="box-border inline-flex h-[22px] min-w-6 items-center justify-center rounded-md px-[5px] leading-none text-accent-fg"
            style={{
              background: badge.color,
              boxShadow: badge.lethal ? "0 0 0 2px var(--color-destructive)" : "none",
            }}
          >
            {badge.text}
          </span>
        ))}
      </span>
    </button>
  );
}

/**
 * The crown. One monarch at a time: the crown in any panel's top right hands it over. Every crown
 * sits on the same chip; the monarch's is filled gold inside its dark outline.
 */
export function CrownChip({
  dark,
  monarch,
  label,
  onPress,
}: {
  dark: boolean;
  monarch: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={monarch}
      aria-label={label}
      onClick={onPress}
      className={cn("group", CHIP_PRESS, "-mr-[7px] w-11", FOCUS)}
    >
      <span
        className={cn(
          "inline-flex size-[30px] items-center justify-center rounded-full",
          chipTone(dark),
          DIP,
        )}
      >
        <Crown
          aria-hidden
          size={18}
          strokeWidth={2}
          style={{ fill: monarch ? CROWN_GOLD : "none" }}
        />
      </span>
    </button>
  );
}

/**
 * The city's blessing, under Ascend's mark (`ms-ability-ascend`). Without it, the bare mark on
 * the usual chip, held back; with it, the chip filled dark and the mark gold (gold filled with dark
 * ink on a dead seat's dark panel).
 */
export function BlessChip({
  dark,
  blessed,
  label,
  pull,
  onPress,
}: {
  dark: boolean;
  blessed: boolean;
  label: string;
  /** How far it tucks in towards the crown beside it. */
  pull: number;
  onPress: () => void;
}) {
  const look = !blessed
    ? { opacity: 0.6 }
    : dark
      ? { background: CROWN_GOLD, color: "var(--color-accent-fg)" }
      : { background: "var(--color-accent-fg)", color: CROWN_GOLD };
  return (
    <button
      type="button"
      aria-pressed={blessed}
      aria-label={label}
      onClick={onPress}
      className={cn("group", CHIP_PRESS, "w-11", FOCUS)}
      style={{ marginRight: pull }}
    >
      <span
        className={cn(
          "inline-flex size-[30px] items-center justify-center rounded-full text-[18px] leading-none",
          !blessed && chipTone(dark),
          DIP,
        )}
        style={look}
      >
        <i aria-hidden className="ms ms-ability-ascend" />
      </span>
    </button>
  );
}

/**
 * The turn timer's pill, on the seat to move: the time left (red once over, counting on with a
 * `+`), and a press that ends the turn. Straight after the roulette it says *1st* where its arrow
 * goes, so the corner never grows past what the number was sized to clear.
 */
export function TurnPill({
  clock,
  over,
  first,
  label,
  onPress,
}: {
  clock: string;
  over: boolean;
  first: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onPress}
      className={cn("group order-[-2] -ml-1 px-1", CHIP_PRESS, "h-9", FOCUS)}
    >
      <span
        className={cn(
          "inline-flex h-[30px] items-center gap-[5px] whitespace-nowrap rounded-full px-2.5 text-[13px] font-semibold",
          over ? "bg-destructive text-accent-fg" : "bg-accent-fg text-text",
          DIP,
        )}
      >
        {first ? (
          <span className="font-bold">1st</span>
        ) : (
          <SkipForward aria-hidden size={14} strokeWidth={2.25} fill="currentColor" />
        )}
        <span className="font-mono">{clock}</span>
      </span>
    </button>
  );
}
