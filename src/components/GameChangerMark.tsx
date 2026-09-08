import type { SVGProps } from "react";
import { Crown } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { cn } from "@/lib/utils";

/** The fact, in as few words as a screen reader can be asked to hear it. */
export const GAME_CHANGER_LABEL = "Game changer";

/** The same fact with room to explain itself, for a pointer that has stopped over the glyph. */
export const GAME_CHANGER_HINT = "Game changer — one of the cards the Commander bracket counts";

/**
 * A game changer, as a crown standing on its own.
 *
 * **This is the search side's mark, and since 2026-09-08 it is only that.** Two surfaces draw it:
 * `components/CardArt`'s `FoilOverlay` chip — the search wall's tiles, the collection's, the
 * wishlist's and the three docked search columns, all of which are `features/search/CardGrid`
 * over that frame — and `features/search/SearchPage`'s printings **rows**, where it sits beside
 * the finish glyph in the cell that identifies the row. Both are places where the app is showing
 * a reader *cards*, one of which happens to be a game changer.
 *
 * ## The deck used to be on this rule and is not any more
 *
 * This block spent most of its life stating a rule called **one fact, three drawings** — a
 * spelled-out gold ribbon on the deck's stacked card, two gold letters in the deck's table and
 * text rows, and this crown wherever a card was drawn as a face too small for a sentence — with
 * the closing line *"a difference of room, never of meaning"*. The rule was sound and the deck
 * has stopped needing it.
 *
 * The deck's four views now print the crown **on the quantity**. Its two card-face views fold it
 * into `features/decks/CardMarks`' `QuantityTag` — the crown before the number, inside the tag
 * the reader is already reading — and its two row views draw a gold crown in the quantity column
 * beside the number. So the deck spends no room on the fact at all: it annotates a mark it was
 * already drawing on every card, and `GameChangerBanner` and `GameChangerBadge` are both gone.
 *
 * **What that retired was a real bug and not just a redundancy.** The ribbon was 130px at
 * `cardZoom` 1.1, and the deck's Grid tile is 165px — measured in the shipped window 2026-09-08
 * (debug build, 1920×1080, a real Commander deck): a tag, a ribbon and the plan's tick came to
 * 163px of marks in a `overflow-hidden` strip, 11px past the edge, clipping the tick by nearly
 * half at every stop of the zoom ladder. That is why `DeckCardFace` briefly carried a required
 * `gameChanger: "banner" | "crown"` prop putting its two card-face views on different arms of the
 * old rule. The crowned tag is about 42px, narrower than either arm was, so the prop is gone and
 * the two views draw one card again.
 *
 * ## Gold here, and the tag's own colour there — which is the same rule, not an exception
 *
 * This glyph is `text-pie-gold`, and the deck's row views draw their crown in that same gold.
 * **A crown printed on `QuantityTag` takes the tag's foreground instead**, so it is white on a
 * blue label, dark on a gold one, and the neutral foreground on an unlabelled card.
 *
 * That is not two colours for one fact. Gold is what an *unfilled* mark laid over somebody's
 * artwork has to carry, because nothing else there says which fact it is. A filled tag already
 * carries a colour, and that colour already means something — it is the card's **label** — so a
 * gold crown printed on a blue tag would be a second colour inside one object, saying nothing the
 * shape was not already saying. The fact is the crown; gold is how the crown is found when it is
 * floating on art.
 *
 * The colour that must stay separate is the other one: a game changer is a *fact about a powerful
 * card*, never a problem with the deck, and the destructive colour belongs to `RuleBreakMark`,
 * which is the mark that does say something is wrong. The spec is explicit that the two must
 * never be confusable, and a crown drawn in red would have thrown that away on the first wall it
 * appeared on.
 *
 * ## Two strings because there are two readers
 *
 * `aria-label` is the accessible name and stays to the point — a screen reader announcing "crown"
 * beside a card would be describing the icon rather than the card, and announcing the whole
 * sentence beside forty of them would be worse than either. The tooltip is what a pointer gets on
 * hover, where there is room to say *which* rules count it — bound `describes: false`, since
 * {@link GAME_CHANGER_LABEL} already names the glyph and a wired `aria-describedby` would repeat
 * it. The same split `FinishMark` makes, for the same reason.
 *
 * ## The mark names itself; it does not hide itself
 *
 * A caller that draws it inside a button whose name is **computed from its contents** is the
 * caller that must hide it. `FoilOverlay` is that caller and wraps this in `aria-hidden` — a wall
 * of tiles must not become forty buttons called "Rhystic Study Game changer" — and `CardGrid`
 * puts the words back as an `sr-only` clause on the tile's own name instead.
 *
 * `SearchPage`'s printings row is the other caller and needs no such wrapper, which is worth
 * saying so that nobody adds one by resemblance: a table cell's text is really read, so the glyph
 * stands there under its own name.
 *
 * ## The 12px is a size at 100% zoom
 *
 * Every surface that draws this draws a card the reader can zoom, so the glyph reads the card's
 * own `--mark-scale` (`lib/cardZoom.ts`) rather than holding still while the art doubles — the
 * crown was two pixels of gold on a 340px card. The `, 1` fallback keeps it exactly where it is
 * anywhere the variable is not set, which is what `SearchPage`'s rows get.
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
