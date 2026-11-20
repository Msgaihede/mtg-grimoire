import type { CSSProperties } from "react";
import { Shield } from "lucide-react";
import { soloView, tileNumberSize } from "../game/fit";
import { LETHAL_COMMANDER, type GameState } from "../game/gameState";
import type { HubRoom, SeatBox } from "../game/seating";
import { LifeHalves } from "./LifeHalves";
import { BackButton, OwnLife, type PanelActions } from "./panelParts";

export interface SoloCommanderViewProps {
  game: GameState;
  box: SeatBox;
  keep: HubRoom;
  colors: string[];
  ownText: string;
  ownInk: string;
  targetLine: string;
  delta: bigint;
  deltaLook: CSSProperties;
  movedHigh: number;
  act: PanelActions;
}

/** The life box's ground: the panel's colour in shadow, so the box reads as set into it. */
const SUNK = "color-mix(in srgb, black 24%, transparent)";

/**
 * One player's commander damage. There is no opponent's panel to count each commander on, so the
 * player's own panel is split: **a tile for each opponent's commander, in that opponent's colour**,
 * and their own life with the way back. A tile works like a panel — its left half −, its right
 * half +, a held press opens the calculator, and 21 says *Lethal*.
 *
 * On its side the opponents are a row across the top, and the bottom of the panel is three
 * columns: the life box with its − and +, the menu button's room, and the way back. Upright, the
 * opponents are stacked from under the menu button down, and the same life box and the way back
 * are at the bottom. The player's own end grows with the panel in a large window; inside it, the
 * delta keeps its phone size.
 */
export function SoloCommanderView({
  game,
  box,
  keep,
  colors,
  ownText,
  ownInk,
  targetLine,
  delta,
  deltaLook,
  movedHigh,
  act,
}: SoloCommanderViewProps) {
  const { lw, lh } = box;
  const n = game.seats.length;
  const v = soloView(lw, lh, game.foes, keep, ownText.length);
  const high = Math.min(32, movedHigh);
  const back = () => act.dispatch({ type: "commander", seat: null });
  const title = (
    <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold whitespace-nowrap">
      <Shield aria-hidden size={14} strokeWidth={2.25} className="shrink-0" />
      Commander damage taken
    </span>
  );
  const lifeBox = (className: string, style?: CSSProperties) => (
    <div className={className} style={{ background: SUNK, ...style }}>
      <LifeHalves
        minusLabel="Player 1 loses 1 life"
        plusLabel="Player 1 gains 1 life"
        dark
        onMinus={() => act.tapLife(0, -1)}
        onPlus={() => act.tapLife(0, 1)}
        onPointerDown={(e) => act.holdLife(0, e)}
      />
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <OwnLife
          ownText={ownText}
          ownInk={ownInk}
          targetLine={targetLine}
          delta={delta}
          deltaLook={deltaLook}
          size={v.ownSize}
          high={high}
        />
      </div>
    </div>
  );

  return (
    <div
      className="absolute right-2 left-2 flex flex-col-reverse gap-2 text-text"
      style={{ top: v.top, bottom: v.foot }}
    >
      {v.wide ? (
        <div
          className="flex shrink-0 items-stretch gap-2"
          style={{ height: v.ownHigh, zoom: v.zoom }}
        >
          {lifeBox("relative min-w-0 flex-1 overflow-hidden rounded-[var(--radius)]")}
          <span className="w-[84px] shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2">
            {title}
            <BackButton onPress={back} />
          </div>
        </div>
      ) : (
        <div
          className="box-border flex shrink-0 flex-col items-center justify-center gap-0.5"
          style={{ height: v.ownHigh, zoom: v.zoom }}
        >
          {title}
          {lifeBox(
            "relative mt-1 h-[100px] shrink-0 self-stretch overflow-hidden rounded-[var(--radius)]",
          )}
          <BackButton onPress={back} />
        </div>
      )}
      <div
        className="flex min-h-0 min-w-0 flex-1 gap-2"
        style={{ flexDirection: v.wide ? "row" : "column" }}
      >
        {game.dmg[0].slice(n).map((taken, k) => {
          const from = n + k;
          const lethal = taken >= LETHAL_COMMANDER;
          return (
            <div
              key={from}
              role="group"
              aria-label={`Opponent ${k + 1}`}
              className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-[var(--radius)] text-accent-fg"
              style={{ background: colors[from] }}
            >
              <LifeHalves
                minusLabel={`One less commander damage from opponent ${k + 1}`}
                plusLabel={`One more commander damage from opponent ${k + 1}`}
                dark={false}
                tile={v.tileStacked ? "stacked" : "side"}
                onMinus={() => act.tapLife(from, -1)}
                onPlus={() => act.tapLife(from, 1)}
                onPointerDown={(e) => act.holdLife(from, e)}
              />
              <div
                className="pointer-events-none absolute top-0 right-0 left-0 flex flex-col items-center justify-center gap-0.5"
                style={{ bottom: v.tileStacked ? 36 : 0 }}
              >
                <span
                  aria-live="polite"
                  className="font-mono leading-none font-semibold tracking-[-0.02em] tabular-nums"
                  style={{ fontSize: tileNumberSize(v, String(taken).length) }}
                >
                  {taken}
                </span>
                <span
                  className="text-xs leading-[1.33] font-semibold"
                  style={{ visibility: lethal ? "visible" : "hidden" }}
                >
                  Lethal
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
