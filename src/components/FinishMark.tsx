import { Gem, Sparkles } from "lucide-react";
import { FINISH_LABEL, type Finish } from "@/lib/finish";
import { cn } from "@/lib/utils";

/** Which glyph stands for which finish. Nonfoil is absent because it draws nothing. */
const GLYPH = { foil: Sparkles, etched: Gem } as const;

/**
 * A finish, where there is no room for the word.
 *
 * Replaces the letters `F` and `E` that `FINISH_MARK` used to supply. Two distinct glyphs
 * rather than one with a modifier, because etched is a *third thing* and not a kind of foil —
 * flattening it into `foil: true` is the single most common way an importer loses data, and
 * an interface that draws them the same teaches exactly that mistake.
 *
 * **A solid accent tint, not a gradient.** These render at 12px, where a gradient is not
 * perceivable and costs an SVG `<defs>` whose id has to be unique per instance. The gradient
 * lives where it has area to work in, which is `CardArt`'s sheen.
 *
 * Nonfoil draws nothing at all — it is the finish a price is assumed to be, which is the rule
 * the letter table stated before this component replaced it.
 *
 * **The `<title>` below is only shown where the caller is a hit target.** It was written for a
 * pointer and, over card art, no pointer could reach it for months: `FoilOverlay`'s chip
 * inherited the overlay's `pointer-events: none`, and a tooltip is shown by the element the
 * pointer *hits*. A mark placed inside anything `pointer-events-none` is a mark with no
 * tooltip, silently.
 */
export function FinishMark({ finish, className }: { finish: Finish; className?: string }) {
  if (finish === "nonfoil") return null;
  const Glyph = GLYPH[finish];
  return (
    <Glyph
      // The word, not the shape: a screen reader saying "sparkles" beside a price would be
      // describing the icon rather than the card. `<title>` follows the label for a pointer.
      role="img"
      aria-label={FINISH_LABEL[finish]}
      className={cn("inline-block size-3 shrink-0 text-accent", className)}
    >
      <title>{FINISH_LABEL[finish]}</title>
    </Glyph>
  );
}
