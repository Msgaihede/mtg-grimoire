import type { CSSProperties, PointerEvent } from "react";
import { Minus, Plus } from "lucide-react";
import { FOCUS_INSET } from "@/lib/focus";
import { PRESS_STILL } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * A panel's two halves, edge to centre: the left is −, the right is +. A tap is one; a press held
 * half a second anywhere on them opens the calculator instead (`LifeBoard`'s `holdLife`), and the
 * click that follows that release counts for nothing.
 *
 * **The − and + are bare symbols**, no chip behind them at rest: a press dips the symbol and
 * flashes a faint disc under it, which is the only time a background shows — darker ink on a seat's
 * colour, the app's border colour on a dark panel. Both halves are real buttons, so a keyboard
 * steps a total one at a time with Enter or Space.
 *
 * They stand at the panel's two edges, level with the number — or, on a panel turned a quarter
 * to face whoever is counting commander damage (`under`), at its foot, each in the middle of its
 * half: such a panel is too narrow for the number between them, and the middle of each half is
 * clear of the menu button wherever along the edge it sits.
 */
const DISC_LIGHT = "group-active:bg-[color-mix(in_oklab,var(--color-accent-fg)_18%,transparent)]";
const DISC_DARK = "group-active:bg-border";

export interface LifeHalvesProps {
  minusLabel: string;
  plusLabel: string;
  dark: boolean;
  onMinus: () => void;
  onPlus: () => void;
  onPointerDown: (e: PointerEvent) => void;
  /** How far the glyphs move down to stay level with the number, and how much they grow. */
  drop?: number;
  zoom?: number;
  /** An opponent tile's smaller glyphs, in its bottom corners when the tile is narrow. */
  tile?: "side" | "stacked";
  /** The glyphs under the number, each in the middle of its half, this far above the foot. */
  under?: number;
}

export function LifeHalves({
  minusLabel,
  plusLabel,
  dark,
  onMinus,
  onPlus,
  onPointerDown,
  drop = 0,
  zoom = 1,
  tile,
  under,
}: LifeHalvesProps) {
  const disc = tile ? 44 : 52;
  const glyph = tile ? 28 : 36;
  const half = (side: "left" | "right"): CSSProperties => ({
    [side]: 0,
    ...(tile
      ? {
          alignItems: tile === "stacked" ? "flex-end" : "center",
          paddingBottom: tile === "stacked" ? 4 : 0,
          [side === "left" ? "paddingLeft" : "paddingRight"]: 2,
        }
      : under !== undefined
        ? { alignItems: "flex-end", justifyContent: "center", paddingBottom: under }
        : { [side === "left" ? "paddingLeft" : "paddingRight"]: 6, alignItems: "center" }),
  });
  const look: CSSProperties = {
    width: disc,
    height: disc,
    zoom,
    transform: drop ? `translateY(${Math.round((drop / zoom) * 10) / 10}px)` : undefined,
  };
  const button =
    "group absolute top-0 box-border flex h-full w-1/2 cursor-pointer border-0 bg-transparent p-0 text-inherit";
  const face = cn(
    "flex items-center justify-center rounded-full",
    PRESS_STILL,
    "group-active:scale-[0.86]",
    dark ? DISC_DARK : DISC_LIGHT,
  );
  return (
    <>
      <button
        type="button"
        aria-label={minusLabel}
        onClick={onMinus}
        onPointerDown={onPointerDown}
        className={cn(button, "justify-start", FOCUS_INSET)}
        style={half("left")}
      >
        <span className={face} style={look}>
          <Minus aria-hidden size={glyph} strokeWidth={2.5} />
        </span>
      </button>
      <button
        type="button"
        aria-label={plusLabel}
        onClick={onPlus}
        onPointerDown={onPointerDown}
        className={cn(button, "justify-end", FOCUS_INSET)}
        style={half("right")}
      >
        <span className={face} style={look}>
          <Plus aria-hidden size={glyph} strokeWidth={2.5} />
        </span>
      </button>
    </>
  );
}
