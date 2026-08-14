import { cn } from "@/lib/utils";

/**
 * What a count tag is filled with when nothing colours it: the colourless deep, `--color-pie-c`.
 *
 * A filled mark has to be *some* colour, and grey is the one that says nothing — which is what a
 * count on a card in a search result has to say, and what a count on an untagged deck card has to
 * say. If the neutral fill were gold, gold would stop being something a **tag** means.
 *
 * This used to be `UNTAGGED_COLOR` in `features/decks/tagColors.ts`, where it answered a question
 * about tags. It answers a question about this mark, so it lives with the mark: a wall of search
 * tiles has no tags at all and still needs the fill.
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
 * A number laid on a card, as a filled banner cut off at a slant — the app's one drawing of
 * "there are N of these".
 *
 * Two surfaces make that statement and they are counting different things: the deck stack says
 * how many copies of a card are in a pile, and the search wall says how many printings a
 * collapsed tile stands for. Neither is a chip of app furniture over a photograph — it is a mark
 * the eye finds first and reads as a quantity before it reads the card, which only works if both
 * are the same object. Drawn here so they cannot drift into two shapes.
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
