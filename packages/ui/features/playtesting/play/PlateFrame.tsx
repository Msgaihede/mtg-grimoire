import { useRef, type JSX, type ReactNode } from "react";
import { Crown, Skull } from "lucide-react";
import { CardImage } from "@/components/CardImage";
import type { PlaytestCommanderDamage, PlaytestPlayer } from "@/lib/ipc";
import { cardImageUrl } from "@/lib/images";
import { cn } from "@/lib/utils";
import { useAimTarget, type DropAim } from "../table/tableDrag";

/**
 * A plate's frame: `data-plate`, which the combat's arrows and the life pops find it by (the
 * player's own name, so each of a four-player table's opponents is found apart), a gold glow on
 * the plate of the player whose turn it is, and the player's marks — their poison counters when
 * they have any, and the commander damage they have been dealt (issue #1336).
 *
 * **One commander, one mark** (CR 903.10a): each commander that has dealt the player combat damage
 * has a mark of its own — its art and its count — so a pair of partners is two counts, never their
 * sum. A count at `lethal` (21, the view's `commanderDamageLethal`) turns red: the player has lost,
 * unless something says they can't (the goldfish's plate says "dead on" instead).
 *
 * **It is the player as a drop target too** (`aim`, issue #1335): a creature carried onto an
 * opponent's plate attacks them, and a spell or an ability carried onto any plate aims at that
 * player. The ring while a card it takes is over it is the click target's dashed one, solid.
 */
export function PlateFrame({
  seat,
  active,
  poison,
  commanderDamage = [],
  lethal = null,
  compact = false,
  className,
  aim,
  children,
}: {
  seat: PlaytestPlayer;
  active: boolean;
  poison: number;
  /** The commander damage this player has been dealt, one entry a commander. */
  commanderDamage?: readonly PlaytestCommanderDamage[];
  /** The commander damage that loses the game; `null` outside a Commander game. */
  lethal?: number | null;
  compact?: boolean;
  className?: string;
  /** The player as a target a carried card is let go on (`aim.ts`): attacked, or aimed at. */
  aim?: DropAim;
  children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const aimed = useAimTarget({ ref, aim });
  const marked = poison > 0 || commanderDamage.length > 0;
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
      {marked && (
        <span
          className={cn(
            "inline-flex flex-none items-center gap-1",
            !compact && "absolute -top-3 right-2",
          )}
        >
          {poison > 0 && (
            <span
              aria-label={`${poison} poison`}
              className="inline-flex flex-none items-center gap-1 rounded-full border border-mana-g bg-surface px-2 font-mono text-xs/6 font-semibold text-mana-g tabular-nums"
            >
              <Skull className="size-3.5" aria-hidden="true" />
              {poison}
            </span>
          )}
          {commanderDamage.map((c) => (
            <CommanderDamageMark key={c.id} damage={c} lethal={lethal} />
          ))}
        </span>
      )}
    </div>
  );
}

/** One commander's damage to the plate's player: its art (a crown for a face-down one) and the
 *  count, red at `lethal`. */
function CommanderDamageMark({
  damage,
  lethal,
}: {
  damage: PlaytestCommanderDamage;
  lethal: number | null;
}): JSX.Element {
  const dead = lethal !== null && damage.damage >= lethal;
  const name = damage.name === "" ? "A face-down commander" : damage.name;
  const of = lethal === null ? "" : ` of ${lethal}`;
  return (
    <span
      data-commander-damage={damage.id}
      data-lethal={dead || undefined}
      aria-label={`${damage.damage} commander damage from ${name}${dead ? ", lethal" : ""}`}
      title={`${name}: ${damage.damage}${of} commander damage`}
      className={cn(
        "inline-flex flex-none items-center gap-1 rounded-full border bg-surface py-px pr-2 pl-px font-mono text-xs/5 font-semibold tabular-nums",
        dead ? "border-destructive text-destructive" : "border-border text-text",
      )}
    >
      {damage.cardId !== null ? (
        <span
          aria-hidden="true"
          className="size-5 flex-none overflow-hidden rounded-full border border-border"
        >
          <CardImage
            src={cardImageUrl(damage.cardId, 0, "art")}
            alt=""
            className="block h-full w-full object-cover"
          />
        </span>
      ) : (
        <Crown className="ml-1 size-3.5" aria-hidden="true" />
      )}
      {damage.damage}
    </span>
  );
}
