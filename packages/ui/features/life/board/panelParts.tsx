/**
 * The pieces a seat's panel and one player's commander damage view share.
 */
import type { CSSProperties, PointerEvent } from "react";
import { FOCUS_INSET } from "@/lib/focus";
import { cn } from "@/lib/utils";
import type { BoardAction } from "../game/gameState";
import { deltaText } from "../game/lifeNumber";

/** What a panel can ask the board to do. */
export interface PanelActions {
  dispatch: (action: BoardAction) => void;
  /** A press going down on a − or + (or an opponent tile's): the hold and the swipe start here. */
  holdLife: (seat: number, e: PointerEvent) => void;
  /** The click after it: one life, unless the press was a hold or a swipe. */
  tapLife: (seat: number, by: 1 | -1) => void;
  openCalc: (seat: number) => void;
  passTurn: () => void;
  /** A press on a stepper chip: its own, and not a press elsewhere on the board. */
  pressChip: (e: PointerEvent) => void;
}

/** A life total inside a commander damage view, its caption and its delta. */
export function OwnLife({
  ownText,
  ownInk,
  targetLine,
  delta,
  deltaLook,
  size,
  high,
}: {
  ownText: string;
  ownInk: string;
  targetLine: string;
  delta: bigint;
  deltaLook: CSSProperties;
  size: number;
  high: number;
}) {
  return (
    <>
      <span
        aria-live="polite"
        className="font-mono leading-none font-semibold tracking-[-0.02em] tabular-nums"
        style={{ fontSize: size, color: ownInk }}
      >
        {ownText}
      </span>
      {delta === 0n && (
        <span
          className="flex items-center text-xs leading-[1.33] whitespace-nowrap text-dim"
          style={{ height: high }}
        >
          {targetLine}
        </span>
      )}
      <span
        className="inline-flex items-center font-mono leading-none font-bold tabular-nums"
        style={{
          height: delta === 0n ? 0 : high,
          fontSize: high - 2,
          ...deltaLook,
        }}
      >
        {delta === 0n ? "" : deltaText(delta)}
      </span>
    </>
  );
}

/** The way out of a commander damage view: the gold button, the one gold thing on the panel. */
export function BackButton({ onPress, small = false }: { onPress: () => void; small?: boolean }) {
  return (
    <button
      type="button"
      onClick={onPress}
      className={cn(
        "group pointer-events-auto inline-flex h-11 shrink-0 cursor-pointer items-center border-0 bg-transparent px-1",
        FOCUS_INSET,
      )}
    >
      <span
        className={cn(
          "inline-flex items-center rounded-md bg-accent font-semibold whitespace-nowrap text-accent-fg",
          small ? "h-[34px] px-4 text-sm" : "h-10 px-5 text-[15px]",
        )}
      >
        Back to life totals
      </span>
    </button>
  );
}
