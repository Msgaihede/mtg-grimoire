import { Crown } from "lucide-react";
import { cn } from "@/lib/utils";

/** The fact, in as few words as a screen reader can be asked to hear it. */
export const GAME_CHANGER_LABEL = "Game changer";

/** The same fact with room to explain itself, for a pointer that has stopped over the glyph. */
export const GAME_CHANGER_HINT = "Game changer — one of the cards the Commander bracket counts";

/**
 * A game changer, where there is no room for the words.
 *
 * The deck views already draw this fact, as `GameChangerBadge`'s two gold letters over a card's
 * title bar — and they keep it. **This is a second drawing of one fact, not a second fact**: a
 * crown here and `GC` there mean exactly the same thing about exactly the same card, and the
 * difference between them is the space each has. A 224px stacked card has a title bar and room
 * for an abbreviation in a mono face; a search tile's art has three corners already spoken for
 * (the owned badge bottom-left, the printing count top-left, the finish chip top-right) and
 * about two glyphs of chip in the fourth. Letters at that size are an abbreviation of an
 * abbreviation, which nobody reads. A crown is read without being read.
 *
 * **Gold, and the same gold.** `text-pie-gold` is what `features/decks/CardMarks.tsx` tints its
 * badge with, and one colour for one fact is the point: a game changer is a *fact about a
 * powerful card*, never a problem with the deck. The destructive colour belongs to the thing
 * that is a problem — `RuleBreakMark` — and the spec is explicit that the two must never be
 * confusable. A crown drawn in red would have thrown that away on the first wall it appeared on.
 *
 * **Two strings because there are two readers.** `aria-label` is the accessible name and stays
 * to the point — a screen reader announcing "crown" beside a card would be describing the icon
 * rather than the card, and announcing the whole sentence beside forty of them would be worse
 * than either. `<title>` is what a browser shows on hover, where there is room to say *which*
 * rules count it. The same split `FinishMark` makes, for the same reason.
 *
 * The mark names itself; it does not hide itself. A caller that draws it inside a button whose
 * name is computed from its contents is the caller that must hide it — see `FoilOverlay`, which
 * wraps this in `aria-hidden` precisely so a wall of tiles does not become forty buttons called
 * "Rhystic Study Game changer".
 */
export function GameChangerMark({ className }: { className?: string }) {
  return (
    <Crown
      role="img"
      aria-label={GAME_CHANGER_LABEL}
      className={cn("inline-block size-3 shrink-0 text-pie-gold", className)}
    >
      <title>{GAME_CHANGER_HINT}</title>
    </Crown>
  );
}
