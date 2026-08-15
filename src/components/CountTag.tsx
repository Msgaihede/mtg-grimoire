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
 */
const SLANT = "polygon(0 0, 100% 0, calc(100% - 10px) 100%, 0 100%)";

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
      style={{ backgroundColor: paint.css, color: paint.fg, clipPath: SLANT }}
      className={cn(
        "flex h-[22px] shrink-0 items-center pr-3 pl-1.5",
        "font-mono text-xs leading-none tabular-nums",
        className,
      )}
    >
      {count}
    </span>
  );
}
