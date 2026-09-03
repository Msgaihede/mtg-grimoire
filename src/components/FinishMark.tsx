import type { SVGProps } from "react";
import { Aperture, Gem, Sparkles } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FINISH_LABEL, type Finish } from "@/lib/finish";
import { type Treatment, treatmentTitle } from "@/lib/treatment";
import { cn } from "@/lib/utils";

/**
 * Which glyph stands for which finish, and **the glyph is the finish and nothing else**.
 *
 * Nonfoil is absent because a plain card with nothing else to say draws nothing at all.
 *
 * **One foil icon, for every kind of foil** — issue #353. A Surge Foil, a Halo Foil, a Double
 * Rainbow and an ordinary foil are all `Sparkles`, because they are all *foil*, and a reader
 * meeting two different pictures of that one fact on two screens has been told the app cannot
 * make its mind up. What tells them apart is the **word**, which this mark already carries as
 * its accessible name and its tooltip and which the card pane's finish list and the collection
 * table print in full. That split — glyph says the finish, word says the treatment — is the
 * whole of the rule, and it is what makes the icon standardisable at all: a finish is one of
 * three, and `CARD_TREATMENTS` is a table that grows every time Scryfall names a new promo
 * type — only the finish can have a picture each.
 */
const GLYPH = { foil: Sparkles, etched: Gem } as const;

/**
 * The third glyph: **a plain card that is unusual cardboard anyway** — Serialized, Poster,
 * Glossy, Plastic.
 *
 * It is reached only where {@link GLYPH} has no answer, which is `nonfoil`, and that fence is
 * what keeps the app to one foil icon: a Surge Foil is drawn as foil, and this stands in the
 * empty slot a plain copy leaves rather than displacing a finish that is already saying
 * something. Traits are the half of `CARD_TREATMENTS` that outlives the finish — a serialized
 * card is serialized in whatever finish you hold it — so a nonfoil copy of one is the only
 * card in the app with a name and no finish to hang it on. Without this glyph those printings
 * go back to drawing nothing.
 *
 * **It used to replace the finish's glyph for every named copy, and that was issue #353.**
 * The same Surge Foil was an `Aperture` on the printings wall and a `Sparkles` in the card
 * pane's foil toggle, the deck card menu and the theory diff — one fact, two pictures, and the
 * reader had no way to know they meant the same thing. What #160 actually asked for was to
 * tell a Halo Foil from an ordinary one, and the *word* does that on every surface; the glyph
 * swap was the part that cost more than it bought.
 *
 * `Aperture` because it has to be told from the other two at 12px, which rules out most of
 * what "special" suggests — `Sparkle` is `Sparkles` minus two points, and `Diamond` is `Gem`
 * without its facets. Iris blades are a circle and four straight chords: no fine detail to
 * lose at this size, and prismatic rather than glittery, which is the difference between
 * "shiny" and "shiny in a particular way".
 *
 * At most one glyph either way, which is what keeps `src/CLAUDE.md`'s corner-chip rule intact:
 * the chip still holds at most a crown and one finish mark, and a second mark wanting that
 * corner would mean the corner is full.
 */
const TRAIT_GLYPH = Aperture;

/**
 * A finish, where there is no room for the word.
 *
 * Replaces the letters `F` and `E` that `FINISH_MARK` used to supply. Distinct glyphs rather
 * than one with a modifier, because etched is a *third thing* and not a kind of foil —
 * flattening it into `foil: true` is the single most common way an importer loses data, and
 * an interface that draws them the same teaches exactly that mistake.
 *
 * **A treatment renames the mark and never redraws it** — issue #353, which is the correction
 * to how issue #160 was first answered. {@link treatments} names what a copy *is*, and where
 * it names something the **word** becomes the treatment's while the glyph stays the finish's:
 * a Surge Foil is a `Sparkles` labelled "Surge Foil", on the printings wall and in the deck
 * table and beside the card pane's foil toggle alike. It is not a fourth finish and must never
 * be modelled as one: `cards.finishes` holds three words across all 116 712 rows, and a
 * treatment is an annotation on one of them — so it gets an annotation's say over the mark,
 * which is the name, and not the finish's, which is the picture.
 *
 * The one exception is the one that proves it: a **nonfoil** copy with a name has no finish
 * glyph to keep, so {@link TRAIT_GLYPH} fills the slot rather than leaving 1 718 unusual
 * printings unmarked.
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
   * Non-empty replaces **the word and not the glyph**: a Surge Foil reads "Surge Foil" rather
   * than "Foil", drawn as the same `Sparkles` every other foil in the app is (issue #353). On
   * a `nonfoil` copy there is no finish glyph to keep, so {@link TRAIT_GLYPH} is drawn instead.
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
  // **The glyph is the finish; the label is the name.** `nonfoil` only reaches here with a
  // name — the early return above is the plain card — so the trait glyph is exactly the case
  // where there is no finish to draw, and every foil is the one foil icon.
  const Glyph = finish === "nonfoil" ? TRAIT_GLYPH : GLYPH[finish];
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
