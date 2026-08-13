import { hasRarityColor, rarityColor } from "@/lib/rarity";
import { cn } from "@/lib/utils";

/**
 * A rarity, as a 6px gem — and, for anyone who cannot see it, as a word.
 *
 * The gem alone is colour-only information, which is why every call site had grown its own
 * `sr-only` label or its own `title`. One component, one accessible name, four call sites:
 * the search table, the art grid, and the card pane twice — the printing it is about, and
 * every row of its printings list.
 *
 * Never a filled badge: the direction's colour budget is spent on mana and card art, and a
 * mythic-orange pill would out-shout the art it annotates.
 *
 * **The word is always there; what changes is who it reaches.** It is drawn where the surface
 * has a column for it (`withLabel`) and `sr-only` where it has not, because a colour is not
 * information anyone can be required to see — and in that second case it is *also* a `title`,
 * for the reader who can see the dot perfectly well and has no idea what it means. A tooltip
 * is what those call sites had reached for on their own before this component existed; the
 * affordance was right and the several wordings were not, which is the whole argument for
 * having one component at all.
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
  const word = rarity ?? "unknown";
  return (
    <span
      // A tooltip **only** where the word is not drawn — where this is a 6px dot and nothing
      // else, and a pointer resting on it has no other way to be told. Deliberately absent
      // when the word *is* drawn: a tooltip repeating a label an inch away is noise.
      // `Rarity:` is kept in front of it for the reason the `sr-only` span keeps it — a bare
      // "common" beside a set code and a number could be about any of them.
      //
      // The accessible name is untouched by this either way. Every node here already has text
      // content, and a `title` is the *last* fallback in name computation — so it is read by
      // a pointer and by nothing else.
      title={withLabel ? undefined : `Rarity: ${word}`}
      className={cn("inline-flex min-w-0 items-center gap-1.5", className)}
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      {/* The word is the accessible name whether or not it is drawn: a gem with no text is
          a colour, and a colour is not information anyone can be required to see. */}
      <span
        className={cn("truncate capitalize", withLabel ? "text-dim" : "sr-only")}
        // Tinted only when the rarity *has* a colour. `special` and `bonus` are real values
        // with no token, and the fallback they fall to is the hairline colour — fine under
        // 6px of dot, about 1.9:1 as a word, which is a caption nobody can read.
        style={withLabel && hasRarityColor(rarity) ? { color } : undefined}
      >
        <span className="sr-only">Rarity: </span>
        {word}
      </span>
    </span>
  );
}
