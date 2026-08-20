import type { SVGProps } from "react";
import { Gem, Sparkles } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
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
 * **The tooltip below is only shown where the caller is a hit target.** `pointer-events`
 * inherits, so a mark placed inside anything `pointer-events-none` binds a tooltip nobody can
 * ever open — `FoilOverlay`'s chip carries `pointer-events-auto` against its wrapper's `none`
 * precisely so this glyph is hoverable there. `describes: false` because {@link FINISH_LABEL}
 * is already this glyph's `aria-label`; the tooltip is the same word for a pointer.
 *
 * **12px is its size on a card at 100% zoom, not its size.** The glyph is drawn over a card face
 * on four surfaces that the reader can zoom, and a chip that held still while the card doubled was
 * the defect this scaling exists to fix. `--mark-scale` (`lib/cardZoom.ts`) is the card's own
 * factor, inherited from the tile; the `, 1` fallback is what the card pane's finish list and every
 * other still surface gets, so those are untouched by construction.
 */
export function FinishMark({ finish, className }: { finish: Finish; className?: string }) {
  const tip = useTooltip();
  if (finish === "nonfoil") return null;
  const Glyph = GLYPH[finish];
  return (
    <Glyph
      // The word, not the shape: a screen reader saying "sparkles" beside a price would be
      // describing the icon rather than the card. The tooltip follows the label for a pointer.
      role="img"
      aria-label={FINISH_LABEL[finish]}
      // See the identical cast in `GameChangerMark`: `TooltipBinding`'s handlers are typed
      // against `HTMLElement`, and this anchor is the lucide `<svg>` glyph itself.
      {...(tip(FINISH_LABEL[finish], { describes: false }) as SVGProps<SVGSVGElement>)}
      className={cn(
        "inline-block size-[calc(0.75rem*var(--mark-scale,1))] shrink-0 text-accent",
        className,
      )}
    />
  );
}
