import { rarityColor } from "@/lib/rarity";
import { cn } from "@/lib/utils";

/**
 * A rarity, as a 6px gem — and, for anyone who cannot see it, as a word.
 *
 * The gem alone is colour-only information, which is why every call site had grown its own
 * `sr-only` label or its own `title`. One component, one accessible name, four call sites:
 * the search table, the art grid, the card pane and the collection table.
 *
 * Never a filled badge: the direction's colour budget is spent on mana and card art, and a
 * mythic-orange pill would out-shout the art it annotates.
 */
export function RarityGem({
  rarity,
  withLabel = false,
  className,
}: {
  rarity: string | null;
  /** Print the word beside the gem, tinted. Tables do; tiles do not. */
  withLabel?: boolean;
  className?: string;
}) {
  const color = rarityColor(rarity);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      {/* The word is the accessible name whether or not it is drawn: a gem with no text is
          a colour, and a colour is not information anyone can be required to see. */}
      <span
        className={cn("truncate capitalize", withLabel ? "text-dim" : "sr-only")}
        style={withLabel && rarity ? { color } : undefined}
      >
        <span className="sr-only">Rarity: </span>
        {rarity ?? "unknown"}
      </span>
    </span>
  );
}
