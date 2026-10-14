import type { JSX, ReactNode } from "react";
import { Skull } from "lucide-react";
import type { PlaytestPlayer } from "@/lib/ipc";
import { cn } from "@/lib/utils";

/**
 * A plate's frame: `data-plate`, which the combat's arrows and the life pops find it by (the
 * player's own name, so each of a four-player table's opponents is found apart), a gold glow on
 * the plate of the player whose turn it is, and the player's poison counters when they have any.
 */
export function PlateFrame({
  seat,
  active,
  poison,
  compact = false,
  className,
  children,
}: {
  seat: PlaytestPlayer;
  active: boolean;
  poison: number;
  compact?: boolean;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      data-plate={seat}
      data-active={active || undefined}
      className={cn(
        "relative flex items-center gap-2 transition-shadow duration-200 motion-reduce:transition-none",
        compact ? "rounded-full" : "rounded-[14px]",
        active &&
          "shadow-[0_0_0_2px_var(--color-accent),0_0_18px_color-mix(in_oklch,var(--color-accent)_45%,transparent)]",
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
