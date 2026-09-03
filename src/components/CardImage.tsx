import { useEffect, useRef, useState, type ImgHTMLAttributes } from "react";
import { IMAGE_STALL_LIMIT, imageStallDeadlineMs } from "@/lib/images";

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
 * **The second rule it carries: the picture never starts a drag of itself.** An `<img>` is
 * draggable by default and the browser picks the *nearest* draggable ancestor as a drag's
 * source, so a frame inside a draggable tile steals the gesture and the tile's own drag never
 * begins. `draggable={false}` is written before the spread, so it is a default a caller can
 * still override and not a rule imposed on one. Nothing is lost: an `mtgimg:` URL means
 * nothing outside this window.
 *
 * **Here rather than at the seven call sites, because it went missing at two of them.**
 * `CardArt` and `CardStack` each passed it by hand with a copy of that paragraph; `DeckTile`'s
 * cover and `CardDetailPane`'s printing rows never did — so a deck tile could be dragged by
 * its name and not by its picture, which is what a reader reports as "drag and drop is
 * broken". A rule every caller has to remember is a rule some caller forgets, and the failure
 * is invisible: a dead drag looks exactly like a drag the reader aimed badly.
 *
 * **The third rule, and the one that makes a wall of cards finish drawing: a request that is
 * never answered is asked again.** `useImageRetry` heals a picture the protocol *refused* — a
 * 502 or a 503 reaches the frame as an `error` event and it comes back on a backoff. What
 * neither it nor any caller can heal is a request that is answered by nothing at all: no
 * `load`, no `error`, no console line, and an `<img>` that will sit empty for the rest of the
 * session. On Windows that state is one dropped message away — every `mtgimg:` response is
 * handed to the UI thread with `PostMessageW` (`wry`'s `webview2::dispatch_handler`), and a
 * post that does not arrive leaves the request's deferral uncompleted forever. The reader sees
 * two black cards in a wall where the other thirty-four drew, which is exactly the report this
 * was written for; it was measured that the picture in one of them had been on disk, current,
 * for ten days, so nothing had failed and nothing had been slow.
 *
 * **Here rather than in `useImageRetry`, for this file's own recurring reason.** Two of the
 * frames that draw a card — `CardDetailPane`'s printing rows and `TheoryDiffDialog`'s — use
 * this component with no retry hook at all, so a watchdog in the hook would have missed them,
 * the way `draggable` went missing at two call sites above. This component is the one thing
 * every card picture in the app passes through, and it owns the `<img>` and its `key`, which
 * is the whole of what asking again requires.
 *
 * What is deliberately *not* here is anything else. No backoff (that is `useImageRetry`, whose
 * `src` this takes), no frame, no fallback, no aspect ratio — the five surfaces that draw
 * card art disagree about all of those, and agree only about these.
 */
export function CardImage({ src, alt, onError, onLoad, ...rest }: CardImageProps) {
  // How many times this picture has been asked for again after saying nothing. Reset during
  // render when the card changes, which is React's own answer to state derived from props and
  // the same shape `useImageRetry` uses: these frames belong to a *slot*, so a new card arrives
  // without a remount and must not inherit the last card's spent asks.
  const [stall, setStall] = useState(0);
  const [shown, setShown] = useState(src);
  if (shown !== src) {
    setShown(src);
    setStall(0);
  }

  // The URL actually asked for. The mark is a query string, and the protocol parses only the
  // path (`images::serve`), so it changes nothing but the identity of the request — which is
  // the point: it stops anything between the renderer and the handler from answering the
  // second ask out of whatever it made of the first. `&` when `useImageRetry` has already put
  // its own mark on, because a URL with two query strings in it is not a URL.
  const url = stall === 0 ? src : `${src}${src.includes("?") ? "&" : "?"}stall=${stall}`;

  const img = useRef<HTMLImageElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const deadline = setTimeout(() => {
      const el = img.current;
      if (!el) return;
      // The element is the honest answer, not a `load` we may have missed: a wall of forty
      // tiles must not re-request forty pictures it already has.
      if (el.complete && el.naturalWidth > 0) return;
      // A frame with no box is a frame nobody is looking at — a card in a closed dialog, a
      // hidden tab, and every `<img>` in jsdom, which reports `width: 0` for everything and
      // never loads an image at all. There is nothing to heal there, and arming against it
      // would put a five-second timer under every card in the test suite.
      if (el.getBoundingClientRect().width === 0) return;
      if (stall < IMAGE_STALL_LIMIT) {
        setStall(stall + 1);
        return;
      }
      // Spent. A picture still silent after this many requests is not a dropped message, so it
      // goes through the door a 502 comes through — the frame says "No image" and joins the
      // backoff rather than asking forever.
      //
      // Said to the element rather than by calling the prop, and that is the honest spelling
      // as well as the tidy one: `error` is what an `<img>` says when it has no picture, React
      // attaches this one *directly* to the element (it does not bubble, so it is not
      // delegated to the root), and going through the element means the handler below runs
      // too — one path for a failure the protocol reported and a failure it never did.
      el.dispatchEvent(new Event("error"));
    }, imageStallDeadlineMs(stall + 1));
    timer.current = deadline;
    return () => clearTimeout(deadline);
    // `url` rather than `src`: each ask gets its own deadline, and the reset above starts the
    // count over for a new card.
  }, [url, stall]);

  return (
    // `key` is not spread with the rest and cannot be: React 19 warns about a `key` inside a
    // spread props object and drops it, which would silently restore the bug this exists to
    // prevent. It is written out, once, here — on the URL rather than the `src` prop, so that
    // asking again is a new element, which is the only thing that re-issues a request.
    <img
      key={url}
      draggable={false}
      src={url}
      alt={alt}
      onLoad={(event) => {
        // Nothing left to watch for. Cleared here rather than through state so a screenful of
        // arriving pictures is not a screenful of re-renders.
        clearTimeout(timer.current);
        onLoad?.(event);
      }}
      onError={(event) => {
        // The protocol answered, and it answered "no". That is the backoff's business, not
        // this watchdog's.
        clearTimeout(timer.current);
        onError?.(event);
      }}
      ref={img}
      {...rest}
    />
  );
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
