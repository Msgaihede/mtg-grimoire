import { useRef, type JSX, type ReactNode } from "react";
import { Skull } from "lucide-react";
import type { PlaytestPlayer } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useAimTarget, type DropAim } from "../table/tableDrag";

/**
 * A plate's frame: `data-plate`, which the combat's arrows and the life pops find it by (the
 * player's own name, so each of a four-player table's opponents is found apart), a gold glow on
 * the plate of the player whose turn it is, and the player's poison counters when they have any.
 *
 * **It is the player as a drop target too** (`aim`, issue #1335): a creature carried onto an
 * opponent's plate attacks them, and a spell or an ability carried onto any plate aims at that
 * player. The ring while a card it takes is over it is the click target's dashed one, solid.
 */
export function PlateFrame({
  seat,
  active,
  poison,
  compact = false,
  className,
  aim,
  children,
}: {
  seat: PlaytestPlayer;
  active: boolean;
  poison: number;
  compact?: boolean;
  className?: string;
  /** The player as a target a carried card is let go on (`aim.ts`): attacked, or aimed at. */
  aim?: DropAim;
  children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const aimed = useAimTarget({ ref, aim });
  return (
    <div
      ref={ref}
      data-plate={seat}
      data-active={active || undefined}
      className={cn(
        "relative flex items-center gap-2 transition-shadow duration-200 motion-reduce:transition-none",
        compact ? "rounded-full" : "rounded-[14px]",
        active &&
          "shadow-[0_0_0_2px_var(--color-accent),0_0_18px_color-mix(in_oklch,var(--color-accent)_45%,transparent)]",
        aimed && "outline-3 outline-offset-2 outline-accent outline-solid",
        className,
      )}
    >
      {children}
      {poison > 0 && (
        <span
          aria-label={`${poison} poison`}
          className={cn(
            "inline-flex flex-none items-center gap-1 rounded-full border border-mana-g bg-surface px-2 font-mono text-xs/6 font-semibold text-mana-g tabular-nums",
            !compact && "absolute -top-3 right-2",
          )}
        >
          <Skull className="size-3.5" aria-hidden="true" />
          {poison}
        </span>
      )}
    </div>
  );
}
