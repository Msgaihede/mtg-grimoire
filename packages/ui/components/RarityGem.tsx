import { useTooltip } from "@/components/tooltip/useTooltip";
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
 * **The gem is 6px on a card at 100% zoom and scales with it.** Three of those call sites are card
 * faces the reader can zoom — the wall's caption, the deck tile's foot, the stack's data line —
 * where a dot that held still turned into a speck beside a doubled card; the four table cells and
 * the pane get `var(--mark-scale, 1)`'s fallback and are unchanged. The **word** takes no size of
 * its own either way: it inherits the line it is drawn in, which on a card is a line that scales
 * and in a table is one that does not.
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
  const tip = useTooltip();
  const color = rarityColor(rarity);
  const word = rarity ?? "unknown";
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-[calc(0.375rem*var(--mark-scale,1))]",
        className,
      )}
    >
      <span
        aria-hidden="true"
        // **A tooltip as well as the `sr-only` word below, because they are for two different
        // readers.** The span is what a screen reader hears; a sighted pointer user hovering a
        // 6px dot had nothing at all, and on the surfaces that draw the gem *without* the word
        // — the deck stack's data line, the art grid — the colour is the only thing said. Four
        // call sites had grown their own `title` before this component consolidated them, and
        // consolidating meant answering both questions here rather than dropping one.
        // `describes: false`: the word is already exposed to assistive tech through the sibling
        // span below (visible or `sr-only`), so a wired `aria-describedby` on this dot would say
        // it twice.
        {...tip(word.replace(/^./, (c) => c.toUpperCase()), { describes: false })}
        className="size-[calc(0.375rem*var(--mark-scale,1))] shrink-0 rounded-full"
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
