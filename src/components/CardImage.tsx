import type { ImgHTMLAttributes } from "react";

/**
 * One card image, drawn so that a frame can never show the wrong card.
 *
 * **The rule, and why it needs a component rather than a convention.** A browser keeps
 * painting an `<img>`'s last decoded frame until the new `src` decodes — that is what an
 * `<img>` is for, and on a photo gallery it is the right behaviour. It is the wrong
 * behaviour here, because every card frame in this app deliberately belongs to a *slot*
 * rather than to a card: a tile in a virtualised wall (keyed by its position, because two
 * pages either side of a sync can carry one printing twice and a duplicate React key drops
 * a card), a deck's cover, the open card in the detail pane. React therefore hands the same
 * element a different card, and the caption, the badge and the price all flip on the frame
 * the data lands while the *picture* stays on the card before it for as long as the fetch
 * takes. The reader sees the app showing one card's art under another card's name.
 *
 * So the image is keyed on its own URL. A new card is a new element, and an element that
 * has never decoded anything paints nothing — the empty frame the caller already draws
 * underneath, which is this app's placeholder everywhere else too. The art is late; it is
 * never wrong.
 *
 * The `key` is the whole component, and it has to be *inside* one: a rule that every call
 * site has to remember is a rule that four call sites will drift on, and the drift is
 * invisible — a stale frame looks exactly like a slow one until you know which card you were
 * looking at. `PrintingPreview` reached the same answer independently by keying its whole
 * `Preview` on the printing; this is that, for the frames that cannot remount themselves.
 *
 * What is deliberately *not* here is anything else. No retry (that is `useImageRetry`, whose
 * `src` this takes), no frame, no fallback, no aspect ratio — the five surfaces that draw
 * card art disagree about all of those, and agree only about this.
 */
export function CardImage({ src, alt, ...rest }: CardImageProps) {
  // `key` is not spread with the rest and cannot be: React 19 warns about a `key` inside a
  // spread props object and drops it, which would silently restore the bug this exists to
  // prevent. It is written out, once, here.
  return <img key={src} src={src} alt={alt} {...rest} />;
}

export interface CardImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> {
  /**
   * The `mtgimg://` URL for one face of one printing at one size — `cardImageUrl`, or the
   * `src` a {@link import("@/lib/useImageRetry").useImageRetry} handed back (which is that
   * URL plus a `?retry=N` marker, and a retry is a new element for the same reason a new
   * card is).
   */
  src: string;
  /**
   * The card's name, or `""` for a frame whose caption already names it. Required rather
   * than optional: `alt` is what a screen reader announces *and* what a failed load shows,
   * and "decorative" has to be a decision someone made rather than a prop someone forgot.
   */
  alt: string;
}
