import { Crown } from "lucide-react";
import { cn } from "@/lib/utils";

/** The fact, in as few words as a screen reader can be asked to hear it. */
export const GAME_CHANGER_LABEL = "Game changer";

/** The same fact with room to explain itself, for a pointer that has stopped over the glyph. */
export const GAME_CHANGER_HINT = "Game changer — one of the cards the Commander bracket counts";

/**
 * A game changer, where there is no room for the words.
 *
 * **The crown is lifted from `GameChangerBanner`, and only the crown.** The deck stack stamps
 * that ribbon across a card — a gold seal, a 9px crown and `Game Changer` in Cinzel — and it is
 * exactly right there and far too much here: a wall tile is 170px of somebody else's artwork,
 * where a ribbon is a sticker over the picture the reader came to look at. The deck's **table**
 * and **text** views made the same call in the other direction and abbreviate to
 * `GameChangerBadge`'s gold `GC` — a row of type has no art to lay a glyph on.
 *
 * So one fact is drawn three ways, and **that is a difference of room, never of meaning**: a
 * banner where a card is 295px tall and a whole row is spare, two letters where a table cell
 * has a column, and this wherever a card is drawn as a *face* — the search wall's tiles, the
 * collection's, the deck editor's docked search column and, since 2026-08-16, the deck's own
 * Grid view, which draws the same `CardArt` frame as all three. A tile's art has three corners
 * already spoken for (the owned badge or the deck's copy count bottom- and top-left, the finish
 * chip top-right) and about two glyphs of chip in the fourth. Letters at that size are an
 * abbreviation of an abbreviation, which nobody reads. A crown is read without being read —
 * which is what the banner was already relying on.
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
 *
 * **The 12px is a size at 100% zoom.** Every surface that draws this draws a card the reader can
 * zoom, so the glyph reads the card's own `--mark-scale` (`lib/cardZoom.ts`) rather than holding
 * still while the art doubles — the crown was two pixels of gold on a 340px card. The `, 1`
 * fallback keeps it exactly where it is anywhere the variable is not set.
 */
export function GameChangerMark({ className }: { className?: string }) {
  return (
    <Crown
      role="img"
      aria-label={GAME_CHANGER_LABEL}
      className={cn(
        "inline-block size-[calc(0.75rem*var(--mark-scale,1))] shrink-0 text-pie-gold",
        className,
      )}
    >
      <title>{GAME_CHANGER_HINT}</title>
    </Crown>
  );
}
