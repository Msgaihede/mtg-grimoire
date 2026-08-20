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
 * The same cut for a mark in a **right-hand** corner — the left edge slants instead.
 *
 * Not a preference: {@link COUNT_TAG_SLANT} takes its bite out of the edge *away* from the corner
 * it is pinned to, which is what makes the shape read as a banner tucked into that corner. Reused
 * unmirrored on the right, the bite lands against the card's own edge and leaves a notch there —
 * photographed 2026-08-20 against the built stylesheet, and the mirrored pair read as bookends of
 * the marks strip where the unmirrored one read as a mistake.
 *
 * It is the same idea `GameChangerBanner` states for its forked tail ("the notch is cut into the
 * *right* edge, so the banner points away from the tag it emerges from"): the geometry is
 * oriented to where the mark sits, and only the orientation changes.
 */
export const COUNT_TAG_SLANT_MIRRORED =
  "polygon(calc(10px*var(--mark-scale,1)) 0, 100% 0, 100% 100%, 0 100%)";

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
 * centre the content inside the visible trapezium rather than inside the box.
 */
export const COUNT_TAG_BOX = cn(
  // 22px, 12px and both paddings are the tag's geometry **at 100% zoom**. It is drawn on a
  // card face in the deck's stack view, which the reader can zoom from 0.5× to 2×, so every
  // one of them is multiplied by the card's own `--mark-scale` (`lib/cardZoom.ts`) — a tag
  // that held still was a sticker on a doubled card and a banner on a halved one. The `, 1`
  // fallback is what any future surface outside a zoomable card gets, unchanged.
  "flex h-[calc(22px*var(--mark-scale,1))] shrink-0 items-center",
  "pr-[calc(0.75rem*var(--mark-scale,1))] pl-[calc(0.375rem*var(--mark-scale,1))]",
  "font-mono text-[calc(0.75rem*var(--mark-scale,1))] leading-none tabular-nums",
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
 * text because it looks accessible. The `title` is what a pointer gets; the words belong to
 * whatever names the card.
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
  return (
    <span
      aria-hidden="true"
      title={title}
      style={{ backgroundColor: paint.css, color: paint.fg, clipPath: COUNT_TAG_SLANT }}
      className={cn(COUNT_TAG_BOX, className)}
    >
      {count}
    </span>
  );
}
