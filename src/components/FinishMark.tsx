import type { SVGProps } from "react";
import { Aperture, Gem, Sparkles } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FINISH_LABEL, type Finish } from "@/lib/finish";
import { type Treatment, treatmentTitle } from "@/lib/treatment";
import { cn } from "@/lib/utils";

/** Which glyph stands for which finish. Nonfoil is absent because it draws nothing. */
const GLYPH = { foil: Sparkles, etched: Gem } as const;

/**
 * The third glyph: **a named treatment**, whatever finish it sits on.
 *
 * `Aperture` because it has to be told from the other two at 12px, which rules out most of
 * what "special" suggests — `Sparkle` is `Sparkles` minus two points, and `Diamond` is `Gem`
 * without its facets. Iris blades are a circle and four straight chords: no fine detail to
 * lose at this size, and prismatic rather than glittery, which is the difference between
 * "shiny" and "shiny in a particular way" that this whole mark exists to draw.
 *
 * It **replaces** the finish's glyph rather than joining it, which is what keeps
 * `src/CLAUDE.md`'s corner-chip rule intact: the chip still holds at most a crown and one
 * finish mark, and a third mark wanting that corner would mean the corner is full.
 */
const TREATMENT_GLYPH = Aperture;

/**
 * A finish, where there is no room for the word.
 *
 * Replaces the letters `F` and `E` that `FINISH_MARK` used to supply. Distinct glyphs rather
 * than one with a modifier, because etched is a *third thing* and not a kind of foil —
 * flattening it into `foil: true` is the single most common way an importer loses data, and
 * an interface that draws them the same teaches exactly that mistake.
 *
 * **A third glyph joined them on 2026-08-21, and it is the same argument one level down.** A
 * Surge Foil, a Halo Foil and an ordinary foil were one `Sparkles` with one word behind it —
 * issue #160, reported off the All Printings wall where three such rows sit side by side. So
 * {@link treatments} names what a copy *is*, and where it names something the glyph and the
 * word both become the treatment's. It is not a fourth finish and must never be modelled as
 * one: `cards.finishes` holds three words across all 116 712 rows, and a treatment is an
 * annotation on one of them.
 *
 * **A solid accent tint, not a gradient.** These render at 12px, where a gradient is not
 * perceivable and costs an SVG `<defs>` whose id has to be unique per instance. The gradient
 * lives where it has area to work in, which is `CardArt`'s sheen.
 *
 * Nonfoil draws nothing at all — it is the finish a price is assumed to be, which is the rule
 * the letter table stated before this component replaced it. **Unless the copy is named**: a
 * Serialized or Poster printing is that in whatever finish you hold it, so the mark outlives
 * the finish there and 1 718 printings that could say nothing before now can.
 *
 * **The tooltip below is only shown where the caller is a hit target.** `pointer-events`
 * inherits, so a mark placed inside anything `pointer-events-none` binds a tooltip nobody can
 * ever open — `FoilOverlay`'s chip carries `pointer-events-auto` against its wrapper's `none`
 * precisely so this glyph is hoverable there. `describes: false` because the label — the
 * treatment's word, or {@link FINISH_LABEL}'s — is already this glyph's `aria-label`; the
 * tooltip is the same words for a pointer.
 *
 * **12px is its size on a card at 100% zoom, not its size.** The glyph is drawn over a card face
 * on four surfaces that the reader can zoom, and a chip that held still while the card doubled was
 * the defect this scaling exists to fix. `--mark-scale` (`lib/cardZoom.ts`) is the card's own
 * factor, inherited from the tile; the `, 1` fallback is what the card pane's finish list and every
 * other still surface gets, so those are untouched by construction.
 */
export function FinishMark({
  finish,
  treatments,
  className,
}: {
  finish: Finish;
  /**
   * What this copy is *called*, from `finishTreatments` in `@/lib/treatment` — `[]`, the
   * default, for the 95 % of printings that have no name beyond their finish.
   *
   * Non-empty replaces both halves of the mark: the glyph becomes {@link TREATMENT_GLYPH} and
   * the word becomes the treatment's, so a Surge Foil reads "Surge Foil" rather than "Foil".
   * **The whole list, joined**, because this is the mark's accessible name and its tooltip and
   * both have the room — MUL 133z is "Double Rainbow Foil · Serialized", and either half alone
   * would be a smaller answer than the reader's own card. A finish list with one column for
   * the word wants `treatmentName` instead.
   *
   * The caller decides what applies to which copy; this component only draws. That split is
   * load-bearing — a foil word is withheld from a plain copy, and 1 434 printings carrying one
   * are also sold in plain nonfoil.
   */
  treatments?: readonly Treatment[];
  className?: string;
}) {
  const tip = useTooltip();
  const named = treatmentTitle(treatments ?? []);
  // A treatment outlives the finish, so a plain copy of a Serialized or Poster printing still
  // draws — `nonfoil` returning early is the rule for a card with *nothing* to say, and that
  // is what the caller's empty list means.
  if (finish === "nonfoil" && named === null) return null;
  const Glyph = named !== null ? TREATMENT_GLYPH : GLYPH[finish as "foil" | "etched"];
  const label = named ?? FINISH_LABEL[finish];
  return (
    <Glyph
      // The word, not the shape: a screen reader saying "sparkles" beside a price would be
      // describing the icon rather than the card. The tooltip follows the label for a pointer.
      role="img"
      aria-label={label}
      // See the identical cast in `GameChangerMark`: `TooltipBinding`'s handlers are typed
      // against `HTMLElement`, and this anchor is the lucide `<svg>` glyph itself.
      {...(tip(label, { describes: false }) as SVGProps<SVGSVGElement>)}
      className={cn(
        "inline-block size-[calc(0.75rem*var(--mark-scale,1))] shrink-0 text-accent",
        className,
      )}
    />
  );
}
