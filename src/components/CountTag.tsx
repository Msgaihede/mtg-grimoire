import { useTooltip } from "@/components/tooltip/useTooltip";
import { cn } from "@/lib/utils";

/**
 * What a count tag is filled with when nothing colours it: the colourless deep, `--color-pie-c`.
 *
 * A filled mark has to be *some* colour, and grey is the one that says nothing — which is what a
 * count on an untagged deck card has to say. If the neutral fill were gold, gold would stop being
 * something a **tag** means.
 *
 * This used to be `UNTAGGED_COLOR` in `features/decks/tagColors.ts`, where it answered a question
 * about tags. It answers a question about this mark, so it stays with the mark even though the
 * one caller left is `QuantityTag`: the fill is what says "no tag", and a module about tag
 * colours is the wrong place for the absence of one.
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
 * It is the same idea `GameChangerBanner` states for its forked tail ("the notch is cut into the
 * *right* edge, so the banner points away from the tag it emerges from"): the geometry is
 * oriented to where the mark sits, and only the orientation changes.
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
 * **left**, and both of them small, because what it holds is a *glyph* rather than a digit.
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
 * ## Both issues are instances of one line of arithmetic, so here it is
 *
 * At the box's mid-height the slant has eaten `10px / 2` off the left edge, so the visible
 * trapezium spans `[5px, W]` and its centre is at `(W + 5) / 2`; the content's centre is at
 * `pl + c / 2`. Substitute `W = pl + c + pr` and the content width `c` cancels: the two centres
 * coincide exactly when **`pl − pr = 5px`**, whatever either padding is and whatever is inside.
 * `12/6` satisfied it to within the half pixel that was measured (the numbers came off Tailwind's
 * scale); `6/1` satisfies it exactly.
 *
 * The right-hand padding gets to be a hairline because a stroked tick brings its own: lucide's
 * `Check` is drawn `4 → 20` in a 24 viewBox, so 2px of bearing per side at the 12px this is worn
 * at. A digit has no such room to give back, which is why {@link COUNT_TAG_BOX} keeps its `6/12`.
 *
 * A second constant rather than a `mirrored` flag on the first, because the pairing is the point:
 * a slant and the paddings that centre content inside it are **one shape** described in two
 * declarations, and the two now sit where a caller picking either can see it has to pick both.
 */
export const COUNT_TAG_BOX_MIRRORED = cn(
  COUNT_TAG_FACE,
  "pl-[calc(0.375rem*var(--mark-scale,1))] pr-[calc(0.0625rem*var(--mark-scale,1))]",
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
  className,
}: {
  count: number;
  /** The count in plain words — the one thing a pointer user can get out of a bare number. */
  title: string;
  /** What to fill it with. Absent is {@link NEUTRAL_COUNT_PAINT}, which is the honest answer for
   *  a count that is only a count. */
  paint?: { css: string; fg: string };
  /** Where the caller puts it. The corner is the surface's, never this mark's. */
  className?: string;
}) {
  const tip = useTooltip();
  return (
    <span
      aria-hidden="true"
      {...tip(title, { describes: false })}
      style={{ backgroundColor: paint.css, color: paint.fg, clipPath: COUNT_TAG_SLANT }}
      className={cn(COUNT_TAG_BOX, className)}
    >
      {count}
    </span>
  );
}
