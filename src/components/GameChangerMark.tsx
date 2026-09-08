import type { SVGProps } from "react";
import { Crown } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
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
 * exactly right there and far too much anywhere the card is drawn smaller: a wall tile is 170px
 * of somebody else's artwork, where a ribbon is a sticker over the picture the reader came to
 * look at. The deck's **table** and **text** views made the same call in the other direction and
 * abbreviate to `GameChangerBadge`'s gold `GC` — a row of type has no art to lay a glyph on.
 *
 * So one fact is drawn three ways, and **that is a difference of room, never of meaning**: a
 * banner where a card is 295px tall and a whole row is spare, two letters where a table cell
 * has a column, and this wherever a card is drawn as a *face* with no room for a sentence — the
 * search wall's tiles, the collection's, the wishlist's and the three docked search columns, all
 * of which are `features/search/CardGrid` over `components/CardArt`, and — since 2026-09-08 —
 * the deck's own Grid tile. A `CardArt` tile's art has three corners already spoken for (the
 * owned badge bottom-left, the printings count top-left, the finish chip top-right) and about
 * two glyphs of chip in the fourth. Letters at that size are an abbreviation of an abbreviation,
 * which nobody reads. A crown is read without being read — which is what the banner was already
 * relying on.
 *
 * ## The deck's Grid tile is on this arm for a reason about **width**, and a live pass found it
 *
 * This paragraph used to put that view here "since 2026-08-16", on the grounds that it "draws the
 * same `CardArt` frame as all three" — the crown went in `FoilOverlay`'s corner chip, beside the
 * finish glyph, exactly as it does on the search wall. **Both halves of that premise went on
 * 2026-09-08.** The tile draws `features/decks/DeckCardFace` — the stacked card, shared — with
 * `FoilOverlay mark={false}`, so there is **no chip on a deck tile at all**, and this mark stands
 * in the card's own 27px marks strip, in the place the ribbon occupies on the stack.
 *
 * So that change drew the **banner** here and the docs pass filed this view on that arm, and it
 * was the reasonable reading rather than a careless one: the tile had become the stack's card,
 * the design decision was that it adopts the stack's marks, and the stack's game-changer mark is
 * the ribbon. **The ribbon is the one mark it could not adopt, and nothing in the source or in
 * either suite could see why.** The three marks in that strip — `QuantityTag`, this fact and
 * `TheoryMatchMark` — are every one of them sized off `--mark-scale`, so none of them gets
 * narrower when the *card* does.
 *
 * Driven in the shipped window 2026-09-08 (`npm run tauri dev`, a **debug** build, 1920×1080,
 * against the real corpus, on a 101-card Commander deck at `cardZoom` 1.1): a card that is both a
 * game changer and an exact plan match put a **28px** tag, a **130px** ribbon and a **28px** tick
 * into a **163px** strip on a **165px** tile — **11px of overflow**, and the face is
 * `overflow-hidden`, so the plan's tick was clipped by nearly half. Every term scales with the
 * zoom, so the ratio is constant and it was clipped at *every* stop of the ladder; photographed
 * at 2× to confirm. Re-measured after the fix in the same session: tag at x=1 (28 wide), crown at
 * x=29 (13 wide), tick at x=136 (28 wide), **overflow 0**, with the stack still drawing the
 * ribbon.
 *
 * So the **two card-face views are on different arms of this rule for the first time**, which is
 * the rule working rather than the app disagreeing with itself — they are two widths, and *a
 * difference of room, never of meaning* is what that sentence says. It is emphatically **not** a
 * return to `CardArt`'s corner chip: the mark is in the same strip in the same place on both
 * views, and top-right is `TheoryMatchMark`'s on both. `DeckCardFace`'s required `gameChanger`
 * prop is where the choice is made and carries the same figures at the call; jsdom lays nothing
 * out, so the overflow itself is a live claim and `views.test.tsx` can only pin *which* drawing
 * each view asks for.
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
 * than either. The tooltip is what a pointer gets on hover, where there is room to say *which*
 * rules count it — bound `describes: false`, since {@link GAME_CHANGER_LABEL} already names the
 * glyph and a wired `aria-describedby` would repeat it. The same split `FinishMark` makes, for
 * the same reason.
 *
 * The mark names itself; it does not hide itself. A caller that draws it inside a button whose
 * name is **computed from its contents** is the caller that must hide it — see `FoilOverlay`,
 * which wraps this in `aria-hidden` precisely so a wall of tiles does not become forty buttons
 * called "Rhystic Study Game changer". **The deck's Grid tile is the second caller and needs no
 * such wrapper**, which is worth stating so that nobody adds one by resemblance: the crown is
 * inside that tile's button too, but the button carries an explicit `aria-label`
 * (`deckCardName`, which already says *game changer* in words), and an explicit name is not
 * computed from contents at all.
 *
 * **The 12px is a size at 100% zoom.** Every surface that draws this draws a card the reader can
 * zoom, so the glyph reads the card's own `--mark-scale` (`lib/cardZoom.ts`) rather than holding
 * still while the art doubles — the crown was two pixels of gold on a 340px card. The `, 1`
 * fallback keeps it exactly where it is anywhere the variable is not set.
 */
export function GameChangerMark({ className }: { className?: string }) {
  const tip = useTooltip();
  return (
    <Crown
      role="img"
      aria-label={GAME_CHANGER_LABEL}
      // `TooltipBinding`'s four handlers are typed against `HTMLElement`, because every other
      // anchor in the app is one; a lucide glyph is an `<svg>`, so the event objects the browser
      // actually delivers here carry an `SVGSVGElement` `currentTarget` — which has every DOM
      // method `TooltipProvider` calls on it (`getBoundingClientRect`, `isConnected`,
      // `setAttribute`, `contains`), just not under the `HTMLElement` type. The cast says only
      // that; it changes nothing about which events fire.
      {...(tip(GAME_CHANGER_HINT, { describes: false }) as SVGProps<SVGSVGElement>)}
      className={cn(
        "inline-block size-[calc(0.75rem*var(--mark-scale,1))] shrink-0 text-pie-gold",
        className,
      )}
    />
  );
}
