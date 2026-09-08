import { Crown } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { cn } from "@/lib/utils";

/**
 * What a count tag is filled with when nothing colours it: the colourless deep, `--color-pie-c`.
 *
 * A filled mark has to be *some* colour, and grey is the one that says nothing — which is what a
 * count on an unlabelled deck card has to say. If the neutral fill were gold, gold would stop
 * being something a **label** means.
 *
 * This used to be `UNLABELLED_COLOR` in `features/decks/labelColors.ts`, where it answered a
 * question about labels. It answers a question about this mark, so it stays with the mark even
 * though the one caller left is `QuantityTag`: the fill is what says "no label", and a module
 * about label colours is the wrong place for the absence of one.
 */
export const NEUTRAL_COUNT_PAINT = {
  css: "var(--color-pie-c)",
  fg: "var(--color-accent-fg)",
} as const;

/**
 * The slanted right edge, and the whole of what keeps this from reading as a button: a printed
 * card has no rectangles in that corner, and a square chip laid on the art looks like something
 * to press.
 *
 * The 10px cut scales with the tag, because it is a proportion of the shape rather than a hairline:
 * held at 10px on a tag drawn half size the slant is most of the banner, and on one drawn double it
 * is a nick in the corner. `--mark-scale` is the card's own factor — see `lib/cardZoom.ts`.
 */
export const COUNT_TAG_SLANT =
  "polygon(0 0, 100% 0, calc(100% - 10px*var(--mark-scale,1)) 100%, 0 100%)";

/**
 * The same cut for a mark in a **right-hand** corner — the bite moves to the bottom-**left**.
 *
 * Not a preference: {@link COUNT_TAG_SLANT} takes its bite out of the corner *diagonally opposite*
 * the one it is pinned to, which is what makes the shape read as a banner tucked into that corner.
 * Reused unmirrored on the right, the bite lands against the card's own edge and leaves a notch
 * there — photographed 2026-08-20 against the built stylesheet, and the mirrored pair read as
 * bookends of the marks strip where the unmirrored one read as a mistake.
 *
 * ## It is a **reflection**, and until issue #182 it was a rotation
 *
 * Both transforms move the bite off the right edge, which is why the wrong one survived a
 * photograph: rotate the polygon 180° and the bite lands top-left, reflect it across the vertical
 * axis and it lands bottom-left, and either way the card's own right edge is left straight. Only
 * the reflection is a mirror. A rotation flips the **taper** as well as the side — so the tag at
 * the left of the marks strip was widest along its top edge while the mark at the right of it was
 * widest along its bottom, two banners leaning opposite ways. That is what was reported: "bigger
 * towards the bottom, whereas the quantity badge is bigger towards the top".
 *
 * The rule it is an instance of: **a mark's geometry is oriented to the corner it is pinned to,
 * and only the orientation changes** — never the taper, and never which corner the bite is taken
 * out of *relative to* that pin. The deck stack's gold ribbon stated the same rule about its own
 * forked tail until 2026-09-08, when the game changer folded into {@link CountTag.crowned} and
 * that ribbon went; this pair is where the rule is drawn now.
 */
export const COUNT_TAG_SLANT_MIRRORED =
  "polygon(0 0, 100% 0, 100% 100%, calc(10px*var(--mark-scale,1)) 100%)";

/**
 * Everything the two boxes below share — the height, the face and the type, without either
 * padding.
 *
 * 22px, 12px and both paddings are the tag's geometry **at 100% zoom**. It is drawn on a card
 * face in the deck's stack view, which the reader can zoom from 0.5× to 2×, so every one of them
 * is multiplied by the card's own `--mark-scale` (`lib/cardZoom.ts`) — a tag that held still was
 * a sticker on a doubled card and a banner on a halved one. The `, 1` fallback is what any future
 * surface outside a zoomable card gets, unchanged.
 */
const COUNT_TAG_FACE = cn(
  "flex h-[calc(22px*var(--mark-scale,1))] shrink-0 items-center",
  "font-mono text-[calc(0.75rem*var(--mark-scale,1))] leading-none tabular-nums",
);

/**
 * The box the slant is cut out of — the height, the two paddings and the face, without the
 * number.
 *
 * Exported so that a mark carrying a **glyph** instead of a count is the same object rather than
 * a copy of one: `TheoryMatchMark` in `features/decks/CardMarks.tsx` is drawn in the corner
 * opposite {@link CountTag} on the same card, and two hand-kept-in-step geometries in one corner
 * pair is the drift this repo has already paid for once. It is deliberately *not* a `glyph` prop
 * on {@link CountTag}: that component's whole contract is "a number, alone, never `×N`", and a
 * second content mode inside it would be a branch through the one thing it promises.
 *
 * **{@link CountTag.crowned} is not that prop and does not weaken the refusal**, which is worth
 * saying here because it is the sentence a reader will come to this block holding. A `glyph` prop
 * is a way of making this box say something that is *not* a count; the crown is drawn beside the
 * number rather than instead of it, so a crowned tag still says a number and nothing else. The
 * paddings are untouched by it either way — see that prop's own doc for the arithmetic.
 *
 * `pr` is larger than `pl` because the slant eats the right edge — the two paddings are what
 * centre the content inside the visible trapezium rather than inside the box. A mark cut with
 * {@link COUNT_TAG_SLANT_MIRRORED} therefore needs them the other way round, and that is
 * {@link COUNT_TAG_BOX_MIRRORED} rather than this.
 */
export const COUNT_TAG_BOX = cn(
  COUNT_TAG_FACE,
  "pr-[calc(0.75rem*var(--mark-scale,1))] pl-[calc(0.375rem*var(--mark-scale,1))]",
);

/**
 * The box for a mark cut with {@link COUNT_TAG_SLANT_MIRRORED} — the larger padding on the
 * **left**, and **as wide as {@link COUNT_TAG_BOX} holding one digit**, so the two read as
 * bookends in size as well as in shape.
 *
 * **Issue #158 moved the larger one to the left.** The theory tick in a stacked card's right-hand
 * corner wore {@link COUNT_TAG_BOX} unchanged, and a reader reported the glyph as left-aligned
 * inside its own banner. It was: the paddings above centre content in a trapezium whose bite is
 * out of the **right** edge, and the mirrored slant takes its bite out of the **left** one. At
 * 100% zoom that puts the mark's visible mid-height centre 5.5px to the *right* of where the
 * content sits — a quarter of a 22px box, which is why a glyph nobody measures still looked wrong.
 *
 * **Issue #182 shrank the pair from `12/6` to `6/1`.** The mark this box draws sits in a stacked
 * card's top-right corner, laid over the printed **mana cost** — the one thing a reader reads out
 * of that corner — and at 30px it covered most of a three-pip one. 19px covers rather less, and
 * the 11px came out of padding alone: the height, the face and the slant are untouched, so the
 * mark is still {@link COUNT_TAG_BOX}'s shape reflected.
 *
 * **Issue #212 put some of it back, and settled the width with a floor rather than with
 * paddings.** 19px against the tag's ~25 was reported as too tight *and* as visibly the smaller
 * of the two bookends, which is one complaint with two halves — and paddings alone can only ever
 * answer the first, because the mark's content is a glyph on one card and a signed number
 * (`+2`, `-8`) on the next, so any pair of paddings picked for the tick makes the number's box a
 * different width again. So the padding is `8/3` and the **width** is stated outright:
 * `min-w` is `1ch` — the mono face's own digit advance at whatever size this is drawn — plus
 * `1.125rem`, which is exactly {@link COUNT_TAG_BOX}'s two paddings. That is the count tag's
 * width holding a single digit, by construction rather than by a measured number that would rot
 * the day the face changed.
 *
 * ## Both issues are instances of one line of arithmetic, so here it is
 *
 * At the box's mid-height the slant has eaten `10px / 2` off the left edge, so the visible
 * trapezium spans `[5px, W]` and its centre is at `(W + 5) / 2`; the content's centre is at
 * `pl + c / 2`. Substitute `W = pl + c + pr` and the content width `c` cancels: the two centres
 * coincide exactly when **`pl − pr = 5px`**, whatever either padding is and whatever is inside.
 * `12/6` satisfied it to within the half pixel that was measured (the numbers came off Tailwind's
 * scale); `6/1` satisfied it exactly, and `8/3` does too.
 *
 * **`justify-center` is what keeps that true once a `min-width` is involved**, and it is the one
 * class here that is not obviously load-bearing. The derivation above substitutes
 * `W = pl + c + pr`, which stops holding the moment the floor makes the box wider than its
 * contents: the surplus lands entirely to the **right** of the content under a flex container's
 * default `flex-start`. Centred, the content sits at `pl + (W − pl − pr) / 2` and the difference
 * of the paddings is again the whole of it.
 *
 * **It is worth 0.8px on the tick at 1× and it is kept anyway**, measured over the built
 * stylesheet on 2026-08-26 — the surplus the floor adds is small because `8/3` was chosen with
 * the floor in mind. What it buys is that the arithmetic above stays a *derivation* rather than a
 * coincidence of today's numbers: the surplus is `W − pl − c − pr`, it grows with the zoom, and
 * anything that changes the content or either padding changes it again.
 *
 * The right-hand padding is still the small one because a stroked tick brings its own bearing:
 * lucide's `Check` is drawn `4 → 20` in a 24 viewBox, so 2px per side at the 12px this is worn
 * at. A digit has no such room to give back, which is why {@link COUNT_TAG_BOX} keeps its `6/12`
 * — and why a two-character `-8` is what actually sets this box's width, at a hair over the floor
 * rather than under it.
 *
 * A second constant rather than a `mirrored` flag on the first, because the pairing is the point:
 * a slant and the paddings that centre content inside it are **one shape** described in two
 * declarations, and the two now sit where a caller picking either can see it has to pick both.
 */
export const COUNT_TAG_BOX_MIRRORED = cn(
  COUNT_TAG_FACE,
  "justify-center",
  "min-w-[calc(1ch+1.125rem*var(--mark-scale,1))]",
  "pl-[calc(0.5rem*var(--mark-scale,1))] pr-[calc(0.1875rem*var(--mark-scale,1))]",
);

/**
 * A number laid on a card, as a filled banner cut off at a slant — the deck stack's drawing of
 * "there are N of these in this pile".
 *
 * **It had two callers for a day and has one again** (2026-08-15). The search wall's printing
 * count was the second, on the argument that a mark the eye finds before it reads the card only
 * works if both surfaces draw the same object — and what that shared shape cost was the *word*:
 * a bare `132` on a search tile is a quantity of nothing in particular, and the only thing
 * saying which quantity was the surface it was on. The wall says `132 printings` in the tile's
 * own corner chip now. So the shape is the deck stack's again, where a bare number is honest
 * because the tag it is printed on says what is being counted.
 *
 * It stays in `components/` rather than moving back into `features/decks/`: the geometry here —
 * the slant, the height, the mono face — is a primitive, and a second surface that has room for
 * a number and not for a word is a reasonable thing to expect.
 *
 * **The number alone, never `×N`.** A banner in a card's corner is already saying "this many";
 * the multiplication sign is a second glyph in a 22px box spending the room the digits need.
 * `OwnedBadge` keeps its `×` — that one is a run of inline text in a caption, where the sign is
 * what tells a count from a set number.
 *
 * **One glyph shares the box since 2026-09-08, and it is a mark rather than content** — the crown
 * a game changer wears, drawn *before* the number in the tag's own foreground colour. It is the
 * `×`'s refusal answered rather than reversed: the multiplication sign is a second reading of the
 * digits and buys nothing, where the crown is a second **fact about the card** the digits are
 * printed on. {@link CountTag.crowned} carries the whole argument.
 *
 * ## It is `aria-hidden`, and that is deliberate
 *
 * `FoilOverlay`'s rule, for `FoilOverlay`'s reason. Every surface that draws this draws a card as
 * a **button with its own accessible name**, and an `aria-label` *replaces* the element's content
 * for naming — so an `sr-only` span in here would be announced to nobody, which is worse than no
 * text because it looks accessible. The tooltip is what a pointer gets; the words belong to
 * whatever names the card, so it binds `describes: false` — an `aria-hidden` mark has nothing to
 * describe.
 */
export function CountTag({
  count,
  title,
  paint = NEUTRAL_COUNT_PAINT,
  crowned = false,
  className,
}: {
  count: number;
  /** The count in plain words — the one thing a pointer user can get out of a bare number. */
  title: string;
  /** What to fill it with. Absent is {@link NEUTRAL_COUNT_PAINT}, which is the honest answer for
   *  a count that is only a count. */
  paint?: { css: string; fg: string };
  /**
   * Whether the count is **crowned** — a game changer, said as a crown drawn before the number
   * rather than as a second object beside this tag (2026-09-08). Defaults to `false`, which is
   * the tag this component has always drawn.
   *
   * ## The crown is the tag's own foreground and emphatically not gold
   *
   * It is stroked in `currentColor`, so it takes {@link paint}'s `fg`: an azure label's tag draws
   * an azure crown, an unlabelled card's grey one draws the neutral foreground. Gold belongs to
   * the crown drawn **on its own** — `components/GameChangerMark` on every wall of `CardArt`
   * tiles, and the crown the deck's two row views draw beside their quantity column — because an
   * unfilled glyph laid over somebody's artwork or a line of type has nothing but its colour
   * saying which fact it is. Here it is printed *on* a fill the reader chose, which already says
   * something (the card's **label**), so a fixed gold would be a second colour inside one object
   * — the one glyph in the strip ignoring what it stands on, and invisible on a Gold-labelled
   * card.
   *
   * ## One fact, one glyph, and the difference is no longer of room
   *
   * The rule this replaces read *one fact, three drawings — a difference of room, never of
   * meaning*: a stamped `Game Changer` ribbon where the stacked card had a spare row, two gold
   * letters (`GC`) where a table cell had a column, and a bare crown wherever a card was drawn as
   * a face with no room for a sentence. **One fact, never two meanings** is the half that
   * survives. *Room* is the half that has gone, because the ribbon and the letters have gone with
   * it: a deck draws one glyph on all four of its views now — this crown, folded into the count on
   * the two card faces and into the row views' own quantity column — so nothing about the deck's
   * game changer is a width argument any more. `GameChangerMark` is not a fourth drawing but that
   * same glyph, drawn on its own wherever there is no tag to print it on.
   *
   * ## The 14px it costs, and where each pixel goes
   *
   * An 11px crown and a 3px gap, **both scaled**: `--mark-scale` is the card's own factor
   * (`lib/cardZoom.ts`) and the reader zooms 0.5×–2×, so a mark that held still would be a sticker
   * on a doubled card and a smudge on a halved one — the same rule every number in
   * {@link COUNT_TAG_FACE} obeys, and the `, 1` fallback is what any surface outside a zoomable
   * card gets. The one scaled pixel of `mb` is optical rather than structural: `items-center`
   * centres the glyph's *box*, and mono digits sit on a baseline above the middle of theirs, so a
   * geometrically centred crown reads a hair low against them.
   *
   * **The gap rides on this flag rather than on the box, and it would be inert without it.** An
   * uncrowned tag holds one (anonymous) flex item, so a `column-gap` there draws between nothing —
   * and the reason not to write it unconditionally anyway is that this box is on every card of
   * every deck, where *inert* is a claim about today's content rather than a property of the
   * class. Off, the box is what it has always been, class for class.
   *
   * **It moves no padding and cannot.** {@link COUNT_TAG_BOX}'s `pl − pr = 5px` is a derivation
   * about the *box* — the content width `c` cancels out of it — so putting 14px more between the
   * two paddings leaves the content's centre exactly on the visible trapezium's. Nothing there
   * needs re-deriving, and the numbers are unchanged.
   *
   * ## The words are the caller's, exactly as they are for the count
   *
   * The whole tag is `aria-hidden` (see the block above), so the crown announces nothing at all: a
   * pointer gets {@link title} and a screen reader gets whatever names the card. **A caller
   * passing `true` therefore owes the fact in words somewhere** — in this `title` and in the
   * accessible name of whatever the tag is drawn inside — or the game changer is drawn for sighted
   * readers alone. `QuantityTag` in `features/decks/CardMarks.tsx` is where that is done for the
   * deck's two card-face views.
   */
  crowned?: boolean;
  /** Where the caller puts it. The corner is the surface's, never this mark's. */
  className?: string;
}) {
  const tip = useTooltip();
  return (
    <span
      aria-hidden="true"
      {...tip(title, { describes: false })}
      style={{ backgroundColor: paint.css, color: paint.fg, clipPath: COUNT_TAG_SLANT }}
      className={cn(COUNT_TAG_BOX, crowned && "gap-[calc(3px*var(--mark-scale,1))]", className)}
    >
      {crowned ? (
        <Crown
          // `strokeWidth` above lucide's 2 default, for the reason the theory tick opposite is
          // (`features/decks/CardMarks.tsx`): a crown at 11px is outline and no fill, so on card
          // art it needs the weight a filled glyph gets from its body. Not the tick's 3 — that is
          // three strokes and this is a row of spikes, which closes up if it is drawn heavier.
          // The `mb` is the optical centring the prop's doc derives; `block` takes the glyph off
          // the text baseline it would otherwise sit on, and `shrink-0` keeps it whole in a box
          // whose digits can grow.
          className={cn(
            "mb-[calc(1px*var(--mark-scale,1))] block shrink-0",
            "size-[calc(11px*var(--mark-scale,1))]",
          )}
          strokeWidth={2.75}
          aria-hidden="true"
        />
      ) : null}
      {count}
    </span>
  );
}
