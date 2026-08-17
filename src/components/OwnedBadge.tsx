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
 *
 * **Every size here is a size at 100% zoom.** The badge's own corner is on a card face on three
 * zoomable walls, so the type, the gap and the heart all read the card's `--mark-scale`
 * (`lib/cardZoom.ts`); the deck's table view and the search table take the `, 1` fallback and are
 * unchanged. The leading is scaled beside the font size deliberately — an arbitrary `text-[…]`
 * sets the font size **only**, so a `text-xs` swapped for one without its `1rem` partner leaves the
 * line box at whatever it inherited.
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
  // The two sentences this badge makes, written once and said twice — as `sr-only` text, which
  // is how a screen reader gets them, and joined into a `title`, which is how a pointer does.
  // `×3` beside a filled heart is two glyphs of shorthand, and a reader who can see it still
  // has to be told once which count that is and whose list the heart means. One tooltip rather
  // than one per half: the halves sit 4px apart, and two would flicker between them.
  const ownedSentence = `${owned} in your collection`;
  const wishSentence = "On your wishlist";
  const hint = [owned > 0 ? ownedSentence : null, wishlisted ? wishSentence : null]
    .filter((sentence) => sentence !== null)
    .join(" · ");
  return (
    <span
      title={hint}
      className={cn(
        "inline-flex shrink-0 items-center gap-[calc(0.25rem*var(--mark-scale,1))] font-mono",
        "text-[calc(0.75rem*var(--mark-scale,1))] leading-[calc(1rem*var(--mark-scale,1))]",
        "tabular-nums text-text",
        className,
      )}
    >
      {owned > 0 && (
        <>
          <span aria-hidden="true">×{owned}</span>
          <span className="sr-only">{ownedSentence}</span>
        </>
      )}
      {wishlisted && (
        <>
            <Heart
            className="size-[calc(0.75rem*var(--mark-scale,1))] shrink-0 fill-current"
            aria-hidden="true"
          />
          <span className="sr-only">{wishSentence}</span>
        </>
      )}
    </span>
  );
}
