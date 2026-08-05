import { Heart } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * What the reader already has, and what they said they wanted — said on the card itself.
 *
 * A quantity is data, so it is the mono face on a plain surface: no green, no "owned" pill.
 * The heart is the sidebar's own wishlist icon, filled, so the mark on a search result and
 * the entry in the nav are visibly the same thing. Both facts carry their meaning in an
 * accessible name, because a badge that exists only as a shape is not a badge for everyone.
 *
 * Nothing at all when there is nothing to say: "you own none of these and have not wished
 * for them" is true of almost every row in a 116 k-card database, and a wall of `×0` would
 * be forty stickers saying nothing. Callers may therefore render this unconditionally — the
 * component is its own guard, and `CardGrid` draws no corner for a mark that came back null.
 */
export function OwnedBadge({
  owned,
  wishlisted = false,
  className,
}: {
  /** Copies held. Finish-blind on a search row, finish-aware nowhere this is used. */
  owned: number;
  /** Whether a wish covers this card. Absent where the surface cannot know — the collection
   *  wall shows what is owned and has no opinion about what is wanted. */
  wishlisted?: boolean;
  className?: string;
}) {
  if (owned <= 0 && !wishlisted) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums text-text",
        className,
      )}
    >
      {owned > 0 && (
        <>
          <span aria-hidden="true">×{owned}</span>
          <span className="sr-only">{owned} in your collection</span>
        </>
      )}
      {wishlisted && (
        <>
          <Heart className="size-3 shrink-0 fill-current" aria-hidden="true" />
          <span className="sr-only">On your wishlist</span>
        </>
      )}
    </span>
  );
}
