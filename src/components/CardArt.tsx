import { CardImage } from "@/components/CardImage";
import { FinishMark } from "@/components/FinishMark";
import type { Finish } from "@/lib/finish";
import { CARD_ASPECT, cardImageUrl, type ImageVariant } from "@/lib/images";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";

/**
 * The holo sweep laid over a foil card's art.
 *
 * A real foil card is a diffraction grating: it throws a different hue at every angle, which
 * is exactly what a multi-stop gradient across the frame approximates. Scryfall's photography
 * has none of it — the art of a foil-only printing is byte-identical to a nonfoil one — so
 * without this the app has no way to show that 12 366 of its printings are foil.
 *
 * `overlay` blend and 12 % opacity: it *tints* the art and never covers it, which is the
 * brief's one hard requirement. A screenshot is the acceptance test — whether 12 % over a dark
 * Phyrexian artwork is still legible is not something an assertion can answer.
 */
const FOIL_SHEEN =
  "linear-gradient(115deg, #ff5f6d 0%, #ffc371 20%, #47e5bc 40%, " +
  "#3b8beb 60%, #a95fe8 80%, #ff5f6d 100%)";

/**
 * One card's art in its 5:7 frame — the picture, its retry, and what is drawn when there is
 * no picture.
 *
 * Extracted from `CardGrid`'s tile because five surfaces draw a card and each had rebuilt
 * part of this: the wall's tiles, the pane's main art, the pane's printings rows, the deck
 * editor's zone rows and `PrintingPreview`. They agreed on the aspect ratio and disagreed
 * about everything else, which is how a foil marking would otherwise have come to exist in
 * five slightly different versions.
 *
 * `CardImage` stays underneath and does the one thing it has always done — key the `<img>`
 * on its URL, so a slot handed a new card paints nothing rather than the previous card's
 * art. This component is the frame around it and the state machine beside it.
 *
 * What it deliberately does **not** own: the button, the focus ring, the caption and the
 * corner marks. Those differ per surface, and a wall's tile is a button where a deck row's
 * thumbnail is `aria-hidden` decoration.
 */
export function CardArt({
  cardId,
  name,
  face = 0,
  variant = "grid",
  selected = false,
  hoverZoom = false,
  finish = null,
  className,
}: {
  /**
   * The printing to draw, or `null` to draw the fallback and fetch nothing.
   *
   * `null` is for an orphan — a collection or deck row whose card has left `cards` — which
   * is a row the app still shows and still names. Fetching for it would be a request that
   * can only 404.
   */
  cardId: string | null;
  /**
   * The card's name. It is the `alt`, so it is what a screen reader announces *and* what
   * the fallback prints; "decorative" is the caller's decision to make by passing `""`.
   */
  name: string;
  /** Which physical side. `0` unless the caller is drawing a flipped card. */
  face?: number;
  /** Which stored size. `grid` is a full card frame; `art` is the 626×457 crop. */
  variant?: ImageVariant;
  /**
   * Ringed, because this is the card an open pane is about. Gold says "focus" as an outline
   * and "state" as a ring everywhere else in the app, and it hugs the art rather than
   * standing off it so a wall keeps its rhythm.
   */
  selected?: boolean;
  /**
   * Grow very slightly while the enclosing `group` is hovered. The wall's tiles want it;
   * a 40px deck-row thumbnail does not, and neither does a static pane.
   */
  hoverZoom?: boolean;
  /**
   * The finish this object *is*, drawn as a holo sheen and a corner chip. `null` — the
   * default — draws neither.
   *
   * "Is", not "could be": a printing sold in both finishes passes `null`, because the mark
   * describes the cardboard and not a choice at the checkout. `soleFinish` in `@/lib/finish`
   * is what a printing-shaped caller derives this with; a collection row passes its entry's
   * own stored finish, which is the one place the answer is known outright.
   */
  finish?: Finish | null;
  className?: string;
}) {
  // The self-healing half of the rate limit, and the reset that goes with it: this component
  // belongs to a *slot* rather than to a card, so a new search hands it a different card
  // without remounting it, and the last card's failure must not be the new card's. Both live
  // in the hook — see it for why a failed image comes back twice.
  const image = useImageRetry(cardId === null ? null : cardImageUrl(cardId, face, variant));

  return (
    <span
      className={cn(
        "relative block w-full overflow-hidden rounded-lg bg-surface",
        selected && "ring-2 ring-accent",
        className,
      )}
      style={{ aspectRatio: CARD_ASPECT }}
    >
      {image.src ? (
        <CardImage
          // The name, not "card image": this string is what a screen reader announces and
          // what shows when a fetch fails, and both readers want the card.
          alt={name}
          src={image.src}
          // No `loading="lazy"`. It was on the wall's tiles against "117 k results is 117 k
          // requests if every mounted tile fetches eagerly", and that is not what happens:
          // the virtualizer bounds the mounted tiles to the rows on screen plus two, so
          // eager is already bounded at about two dozen images. What the browser's own
          // intersection gate added on top was a second wait — and a lazy image is fetched
          // at low priority, after layout, outside the preload scanner — on exactly the two
          // dozen pictures the reader is about to look at.
          decoding="async"
          // An `<img>` is draggable by default, and the browser picks the *nearest*
          // draggable ancestor as a drag's source — so the art would start a drag of itself
          // and the tile's own drag would never begin. Off here rather than at the caller,
          // because the caller is handed the frame and cannot reach this. Nothing is lost:
          // an `mtgimg:` URL means nothing outside this window.
          draggable={false}
          onError={image.onError}
          className={cn(
            "size-full object-cover",
            hoverZoom &&
              "transition-transform duration-150 group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:group-hover:scale-100",
          )}
        />
      ) : (
        // A frame with no art is still a card. The name is what the reader came for and it
        // is known without the image, so a rate-limited screen reads as a list of cards
        // rather than a wall of broken-image icons.
        <span className="flex size-full flex-col items-center justify-center gap-1 px-2 text-center">
          <span className="line-clamp-3 text-xs">{name}</span>
          <span className="text-[0.7rem] text-dim">
            {image.retrying ? "Retrying…" : cardId === null ? "No card" : "No image"}
          </span>
        </span>
      )}

      <FoilOverlay finish={finish} />
    </span>
  );
}

/**
 * The sheen and the chip that say a card is foil, over whatever frame encloses them.
 *
 * Its own component because the card detail pane's main art is **not** a `CardArt`: it keeps
 * a flip fade, a bespoke "no image yet" panel and no retry hook, and routing it through the
 * shared frame would trade three deliberate behaviours for one shared one. What the two must
 * agree on is the marking, so that is what is shared.
 *
 * The enclosing element needs `relative` and `overflow-hidden`; `CardArt` has both.
 */
export function FoilOverlay({ finish }: { finish: Finish | null }) {
  if (!finish) return null;
  return (
    <>
      {/* `aria-hidden` because the chip beside it already says the word, and a screen reader
          does not need it twice. `pointer-events-none` because the frame is usually inside a
          button and a full-bleed overlay would swallow every click on it. */}
      <span
        data-foil-sheen
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.12] mix-blend-overlay"
        style={{ backgroundImage: FOIL_SHEEN }}
      />
      {/* The chip is what *says* foil; the sheen is what *looks* foil. Neither is asked to do
          the other's job — a sheen alone is ambiguous at a glance on dark art, and a chip
          alone says nothing about the object being a different physical thing.

          Top-right, because a tile's other two corners are spoken for: bottom-left the owned
          badge, top-left the printing count. The backing is the app's own table felt at 85 %,
          matching those two exactly. */}
      <span className="pointer-events-none absolute top-1 right-1 flex items-center rounded bg-bg/85 px-1 py-0.5">
        <FinishMark finish={finish} />
      </span>
    </>
  );
}
