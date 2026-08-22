import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * Below this, the master artwork's fine detail is drawn at less than a third of a pixel.
 *
 * The number is the logo package's own (`logos/README.md`: "below about 24 px the casting
 * circle and the clasp rivets fill in"), and it is a *rendered* size rather than a design
 * intent — which is why {@link GrimoireMark} takes a pixel size and picks for the caller
 * instead of taking a variant flag. A mark dropped into a 34px title bar with the wrong
 * variant is a bug nobody can see in jsdom and nobody thinks to look for in the window.
 */
const DETAIL_FLOOR = 24;

/**
 * How much the small variant thickens every stroke it keeps.
 *
 * The artwork is drawn on a 64 unit grid, so a rendered pixel costs `size / 64` units: at
 * 20px the book's 1.7 outline is **0.53px** and every hairline under it is thinner still.
 * Dropping the fine groups (below) stops them turning to mush, but it does nothing for the
 * outline that survives — a mark whose heaviest stroke is half a pixel reads as a smudge of
 * gold rather than as a book. 1.4× puts that outline at 0.74px, which is a hairline on
 * purpose rather than by accident: the wordmark it stands beside is 13px Cinzel at 0.2em, and
 * a heavy mark next to delicate type is a lockup with two voices.
 *
 * One number because it is one decision. Tune it here and every kept stroke moves together,
 * which is what keeps the small variant a *rendering* of the master rather than a second
 * drawing that can drift from it.
 */
const SMALL_STROKE = 1.4;

export interface GrimoireMarkProps {
  /**
   * The rendered size in CSS pixels. Sets the box **and** picks the variant — see
   * {@link DETAIL_FLOOR}.
   */
  size: number;
  /** Tailwind classes. The strokes are `currentColor`, so this is where the colour comes from. */
  className?: string;
  /**
   * Give the mark this accessible name instead of hiding it.
   *
   * **Hidden is the default, which inverts `GameChangerMark`'s rule on purpose.** That glyph
   * is a fact about a card stated nowhere else on the tile, so it has to name itself. This one
   * is the app's name, and every surface it lands on already sets that name in type two
   * millimetres away — the title bar's wordmark, the first run's, the version panel's heading.
   * A mark that names itself there is the product name announced twice in a row. Naming is
   * therefore the exception, for a surface that draws the mark *instead of* the words.
   */
  label?: string;
}

/**
 * The app's own mark: a clasped grimoire with a spell diamond burning through the cover.
 *
 * **Drawn inline rather than loaded, and that is the same call `FinishMark` and
 * `GameChangerMark` already made.** An `<img>` is a second request, a decode the first paint
 * has to wait for, and a picture that cannot take a colour; this mark's strokes are
 * `currentColor`, so the colour is the caller's and one file serves every surface. All three
 * call sites happen to draw it in the accent today; the day one of them wants it dim, that is a
 * class rather than a second asset. It also keeps the artwork inside the type system — the
 * fills are `--color-surface` because that is what the logo package says they are
 * (`logos/README.md`: "gold `#D1A84B` (--color-accent), panel `#16181E` (--color-surface)"),
 * so a token that moves takes the mark with it instead of stranding a hex in a binary. The same
 * one drawing therefore gives two pictures on two grounds with no branch in here: over the title
 * bar's `bg-surface` the boards fill with the ground they sit on and the mark is pure line art,
 * while over the first run's `bg-bg` they fill one step above it and the book reads as a faint
 * raised plate.
 *
 * **There are three copies of this artwork, and each has a consumer that cannot use the other
 * two.** `logos/svg/mtg-grimoire-mark.svg` is the master and the thing to edit;
 * `public/mtg-grimoire-mark.svg` is the favicon, which `<link rel="icon">` can only load as a
 * *file* and which has no CSS context to resolve a token in; and this component is the in-app
 * drawing, which needs the tokens, the two variants and a per-instance gradient id that no
 * static file can carry. Deleting any one of them breaks something the other two cannot do. What
 * must not fork is the **geometry**, which has exactly one home — a change to the drawing starts
 * in `logos/` and is copied down from there, never the other way.
 *
 * **Two variants of one drawing, and the small one is a rendering rather than a redraw.** Both
 * come from `logos/svg/mtg-grimoire-mark.svg` on the same 64 unit grid, in the same order, with
 * the same coordinates; the small one drops the groups that fall under a third of a pixel and
 * thickens what is left by {@link SMALL_STROKE}. What it drops is exactly what the logo package
 * predicted would fill in — the dashed casting circle and its inner ring, the seven radial
 * runes, the page block and its corner cuts, the diamond's facets, the clasp's two rivets and
 * its gem. What it keeps is the silhouette anyone actually recognises at 20px: a closed book,
 * a gold diamond, a clasp reaching off the right edge, a ribbon below.
 *
 * **The gradient goes with them, and `FinishMark` wrote the reason down first**: a gradient
 * "is not perceivable [at that size] and costs an SVG `<defs>` whose id has to be unique per
 * instance". At 20px the diamond is four pixels across, which is no room at all for three
 * stops — so the small variant fills it flat and ships no `<defs>` to collide. The full one
 * has the area to work in and keeps it, with `useId` making the id unique so two marks on one
 * screen cannot resolve to each other's gradient. **Do not replace that with a constant id.**
 * Duplicate ids are legal-looking and silently wrong: the second mark paints from the first
 * one's `<defs>`, which is invisible until the day the two are drawn at different sizes.
 *
 * Hidden from assistive technology unless {@link GrimoireMarkProps.label} says otherwise.
 */
export function GrimoireMark({ size, className, label }: GrimoireMarkProps) {
  // Unique per instance, and only ever referenced by the full variant below.
  const gradientId = useId();
  const small = size < DETAIL_FLOOR;
  // Written as two plain attributes rather than a spread of a union, because a spread of
  // `{"aria-hidden"} | {role, "aria-label"}` type-checks but reads as if both shapes were
  // possible at once. React drops an `undefined` attribute, so this renders exactly one of them.
  //
  // **Falsy rather than `=== undefined`, and `label=""` is the case that decides it.** An
  // empty string is not a name, so an identity check would opt it *into* the named branch and
  // put a `role="img"` in the tree with no accessible name — a graphic a screen reader must
  // announce and has nothing to announce it as, which is worse than either branch this
  // component means to offer and a WCAG 1.1.1 failure. Falling back to hidden is the safe
  // reading of `label=""`: a caller who passed nothing meaningful gets the default.
  const hidden = !label;
  /**
   * One kept stroke, thickened for the small variant and rounded to hundredths.
   *
   * **The rounding is not cosmetic.** `1.5 * 1.4` is `2.0999999999999996` in IEEE754, so
   * without it the title bar's mark ships `stroke-width="2.0999999999999996"` into the DOM of
   * every window. It renders identically — SVG parses the full precision — but it is the same
   * trap `lib/cardZoom.ts` spells `ZOOM_STEPS` out as literals to avoid ("0.1 added seven times
   * is 0.7999999999999999"), and a drawing attribute is exactly where that noise is least
   * readable. Two decimals is finer than anything here can express: a hundredth of a unit is
   * 1/6400 of the drawn size, which at the largest size this is ever drawn at is a fiftieth of
   * a pixel.
   */
  const sw = (width: number) => (small ? Math.round(width * SMALL_STROKE * 100) / 100 : width);
  // The kept strokes. Named for what they are in the artwork rather than by number, so a change
  // here is legible as a change to the book.
  const board = sw(1.7);
  const pages = sw(1.2);
  const pagesFar = sw(1.1);
  const ribbon = sw(1.5);
  const diamond = sw(1.3);
  const clasp = sw(1.35);

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      // `shrink-0` because every surface that draws this puts it first in a flex row next to
      // type that is allowed to truncate — without it the mark is what gives way.
      className={cn("shrink-0", className)}
      role={hidden ? undefined : "img"}
      aria-label={hidden ? undefined : label}
      aria-hidden={hidden || undefined}
    >
      {!small && (
        <defs>
          {/* The spell burning through the cover: bright at the point, thinning through the
              middle, gathering again at the base. Vertical because the diamond is twice as
              tall as it is wide, so a vertical ramp is the axis with room for three stops. */}
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.95" />
            <stop offset="0.55" stopColor="currentColor" stopOpacity="0.55" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0.85" />
          </linearGradient>
        </defs>
      )}
      {/* The logo package's own centring transform, verbatim. It centres the mark on the
          **book** — the two boards, excluding the clasp and the ribbon — so the book sits dead
          centre and the clasp and ribbon reach into the margin. Changing it re-crops every
          size at once, which is why it is copied rather than recomputed. */}
      <g transform="translate(32 32) scale(0.9200) translate(-31.5 -30.5)">
        <g fill="none" stroke="currentColor" strokeLinejoin="round">
          {/* Back board and spine, behind everything. */}
          <path
            d="M49.5 6.5Q53.5 6.5 53.5 10.5V54.5A2.5 2.5 0 0 1 51 57H14"
            fill="var(--color-surface)"
            strokeWidth={board}
          />
          {/* Two page edges, the book's thickness. Round caps so they end as paper does. */}
          <g strokeLinecap="round">
            <path d="M50.3 9V53.8H12.6" strokeWidth={pages} opacity="0.7" />
            <path d="M51.9 10.2V55.4H13.3" strokeWidth={pagesFar} opacity="0.5" />
          </g>
          {/* The ribbon, hanging below the boards into the clear space. */}
          <path
            d="M25 48H30.5V61.5L27.75 58.3L25 61.5Z"
            fill="var(--color-surface)"
            strokeWidth={ribbon}
          />
          {/* Front board, over the pages. */}
          <path
            d="M12 4H47A2.5 2.5 0 0 1 49.5 6.5V52.5H9.5V6.5A2.5 2.5 0 0 1 12 4Z"
            fill="var(--color-surface)"
            strokeWidth={board}
          />
          {/* The fold where the front board meets the spine. */}
          <path d="M9.5 49V52.5L14 57H16" strokeWidth={board} strokeMiterlimit="4" />

          {!small && (
            <>
              {/* The page block inset into the cover, and the four cut corners of its frame. */}
              <rect x="13.5" y="7.5" width="32" height="41.5" strokeWidth="0.9" />
              <g strokeWidth="0.9" strokeMiterlimit="6">
                <path d="M13.5 13V11.5L17.5 7.5H19" />
                <path d="M45.5 13V11.5L41.5 7.5H40" />
                <path d="M13.5 43.5V45L17.5 49H19" />
                <path d="M45.5 43.5V45L41.5 49H40" />
              </g>
              {/* The casting circle: a dashed ring and the true circle inside it. */}
              <g opacity="0.45">
                <circle
                  cx="29.5"
                  cy="26.3"
                  r="13.5"
                  strokeWidth="0.85"
                  strokeDasharray="2.5 3"
                />
                <circle cx="29.5" cy="26.3" r="10" strokeWidth="0.75" opacity="0.7" />
              </g>
              {/* Seven runes struck around the circle. Seven rather than eight: the lower-right
                  spoke is left out, where the clasp crosses the ring. */}
              <g strokeWidth="0.85" opacity="0.7">
                <path d="M43.5 26.3H45.1" />
                <path d="M15.5 26.3H13.9" />
                <path d="M39.4 16.4L40.6 15.2" />
                <path d="M19.6 16.4L18.4 15.2" />
                <path d="M19.6 36.2L18.4 37.4" />
                <path d="M29.5 41V42.6" />
                <path d="M29.5 11.6V10" />
              </g>
            </>
          )}

          {/* The spell itself — the one thing on the mark that is filled rather than drawn. */}
          <path
            d="M29.5 12L35.9 26.3L29.5 40.6L23.1 26.3Z"
            fill={small ? "currentColor" : `url(#${gradientId})`}
            fillOpacity={small ? 0.55 : undefined}
            strokeWidth={diamond}
          />
          {!small && (
            <g strokeWidth="0.75" opacity="0.9">
              <path d="M29.5 12V40.6" />
              <path d="M23.1 26.3L29.5 27.9L35.9 26.3" />
            </g>
          )}

          {/* The clasp: plate, strap, and the bar it locks against. */}
          <g strokeWidth={clasp}>
            <path d="M38.4 40.6L42 37.9H46.4V43.3H42Z" fill="var(--color-surface)" />
            {!small && (
              <>
                <circle cx="43.4" cy="40.6" r="0.75" strokeWidth="0.75" opacity="0.85" />
                <circle cx="45.5" cy="40.6" r="0.75" strokeWidth="0.75" opacity="0.85" />
              </>
            )}
            <path d="M46.4 38.5H53.6L55.8 40.6L53.6 42.7H46.4Z" fill="var(--color-surface)" />
            {!small && (
              <path d="M50 40.6L51 39.3L52 40.6L51 41.9Z" strokeWidth="0.8" opacity="0.9" />
            )}
            <path d="M53.5 36.1V45.1" strokeWidth={board} />
          </g>
        </g>
      </g>
    </svg>
  );
}
