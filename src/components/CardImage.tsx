import { useEffect, useRef, useState, type ImgHTMLAttributes } from "react";
import { IMAGE_STALL_LIMIT, imageStallDeadlineMs } from "@/lib/images";

/**
 * **One `IntersectionObserver` for every card picture in the window**, and a callback per frame.
 *
 * The watchdog below asks one question of the layout — is this frame on screen? — and an observer
 * is the one way to ask it that never forces a layout: its entries are computed in the browser's
 * own rendering step and delivered afterwards, with the frame's box already measured. One shared
 * observer rather than one per frame, because the All tokens wall mounts 4 357 frames at once and
 * an observer is not free; the callback map is what routes each entry to its frame.
 *
 * **Rebuilt when the global constructor changes**, which only a test does: a suite that stubs
 * `IntersectionObserver` with a controllable one gets an observer built from its stub, where a
 * cached one would still be the setup file's inert shim. **Absent entirely, nothing is watched**
 * — every frame then stays unarmed, which is the no-layout floor this gate replaced.
 */
let shared: {
  ctor: typeof IntersectionObserver;
  observer: IntersectionObserver;
  frames: Map<Element, (onScreen: boolean) => void>;
} | null = null;

function watchOnScreen(el: Element, onChange: (onScreen: boolean) => void): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {};
  if (shared === null || shared.ctor !== IntersectionObserver) {
    const frames = new Map<Element, (onScreen: boolean) => void>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        // A box as well as an intersection: a frame of no width is nobody's to look at, and an
        // observer can report a zero-area target touching the viewport as intersecting.
        frames.get(entry.target)?.(entry.isIntersecting && entry.boundingClientRect.width > 0);
      }
    });
    shared = { ctor: IntersectionObserver, observer, frames };
  }
  const { observer, frames } = shared;
  frames.set(el, onChange);
  observer.observe(el);
  return () => {
    frames.delete(el);
    observer.unobserve(el);
  };
}

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
 * looking at. `PrintingPreview` had reached the same answer independently, by keying its whole
 * `Preview` on the printing — that file was deleted with the docked card pane on 2026-09-03, and
 * this is what it was doing, for the frames that cannot remount themselves.
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
 * cover and the docked pane's printing rows never did — so a deck tile could be dragged by
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
 * **Here rather than in `useImageRetry`, for this file's own recurring reason.** Several of the
 * frames that draw a card — `CardModalArt`'s open card, `TheoryDiffDialog`'s rows and
 * `PullFromCollectionDialog`'s — use this component with no retry hook at all, so a watchdog in
 * the hook would have missed them,
 * the way `draggable` went missing at two call sites above. This component is the one thing
 * every card picture in the app passes through, and it owns the `<img>` and its `key`, which
 * is the whole of what asking again requires.
 *
 * **The fourth rule, and it is the one the third turned out not to cover: a picture that
 * arrives is still not a picture that is drawn.** The watchdog above asks again when a frame
 * has heard *nothing*, and its first question is `el.complete && el.naturalWidth > 0` —
 * whether the picture arrived. The failure readers kept reporting after it shipped answers
 * that question **yes**: the bytes are decoded and in memory, and the frame is empty anyway,
 * because `decoding="async"` let the browser present the frame first and then lost the paint.
 * So `decoding` is a default this component sets rather than a prop its callers pass; the
 * measurements are at the attribute.
 *
 * The two failures look identical to a reader and are opposites underneath — one is a picture
 * that never came, the other a picture that came and was not drawn — which is why the first
 * fix could not have caught the second, and why both live here.
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
  /** This element's answer arrived — `load` or `error` — so the watchdog stands down for it. */
  const settle = useRef<() => void>(undefined);

  /**
   * **The watchdog's clock runs only while the frame is on screen** (2026-09-28), where it ran
   * from mount.
   *
   * A clock started at mount cannot tell a request nobody answered from a request nobody made.
   * The walls draw their pictures `loading="lazy"`, so the browser does not ask for a frame below
   * the fold at all — and the watchdog read that silence as the dropped message it exists for,
   * asked twice more, and put "No image" on the frame for good. Measured in the shipped window on
   * the All tokens wall (debug build, 4 357 tiles): 40 s after it opened, **1 691** frames read
   * "No image", five of six on screen after a scroll to the middle, and none recovered in 20 s —
   * pictures that load at once when they are on screen at mount. The same pass found the other
   * cost: every tick asked `getBoundingClientRect()` of its frame, a forced layout per picture,
   * and the wall's frames ran at 100–150 ms for ten seconds after each redraw.
   *
   * So the frame is watched by the one shared observer ({@link watchOnScreen}): entering the
   * viewport arms the deadline, and leaving it disarms it — the next entry starts a full one,
   * because a picture scrolled past was never being waited for. **On screen is also when a lazy
   * picture is asked for**, so the clock now starts when the request can have started, which is
   * the one moment silence means something. Nothing here measures the layout any more: the
   * observer hands over whether the frame has a box.
   *
   * **The floor is unchanged, and it is what keeps the suite quiet**: jsdom has no observer that
   * ever reports, so no frame there arms a timer — the same answer the old `width === 0` gate gave,
   * for the same reason.
   */
  useEffect(() => {
    const el = img.current;
    if (!el) return;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const disarm = () => {
      clearTimeout(deadline);
      deadline = undefined;
    };
    settle.current = () => {
      settled = true;
      disarm();
    };
    const stop = watchOnScreen(el, (onScreen) => {
      if (!onScreen) {
        disarm();
        return;
      }
      // Armed already, or answered: an entry for a frame that is still on screen changes
      // nothing, and a frame whose picture came (or was refused) has nothing to wait for. The
      // element is the honest answer, not a `load` we may have missed: a wall of forty tiles
      // must not re-request forty pictures it already has.
      if (deadline !== undefined || settled || (el.complete && el.naturalWidth > 0)) return;
      deadline = setTimeout(() => {
        deadline = undefined;
        if (el.complete && el.naturalWidth > 0) return;
        if (stall < IMAGE_STALL_LIMIT) {
          setStall(stall + 1);
          return;
        }
        // Spent. A picture still silent after this many requests is not a dropped message, so
        // it goes through the door a 502 comes through — the frame says "No image" and joins the
        // backoff rather than asking forever.
        //
        // Said to the element rather than by calling the prop, and that is the honest spelling
        // as well as the tidy one: `error` is what an `<img>` says when it has no picture, React
        // attaches this one *directly* to the element (it does not bubble, so it is not
        // delegated to the root), and going through the element means the handler below runs
        // too — one path for a failure the protocol reported and a failure it never did.
        el.dispatchEvent(new Event("error"));
      }, imageStallDeadlineMs(stall + 1));
    });
    return () => {
      stop();
      disarm();
    };
    // `url` rather than `src`: each ask is a new element with its own watch and its own
    // deadline, and the reset above starts the count over for a new card.
  }, [url, stall]);

  return (
    // `key` is not spread with the rest and cannot be: React 19 warns about a `key` inside a
    // spread props object and drops it, which would silently restore the bug this exists to
    // prevent. It is written out, once, here — on the URL rather than the `src` prop, so that
    // asking again is a new element, which is the only thing that re-issues a request.
    <img
      key={url}
      draggable={false}
      // **The fourth rule, and the one that actually empties a wall: a picture decoded after
      // its frame was painted is never painted at all.**
      //
      // `decoding="async"` is a promise the page makes *to the browser* — "you may present
      // this frame before this image is decoded, and paint it whenever the decode lands".
      // Every call site made it, for the ordinary reason: a screenful of card art is a dozen
      // 672×936 WEBPs arriving at once and none of them should hold up the scroll. What it
      // buys in principle it does not buy here, and what it costs is a tile that stays empty
      // for the rest of the session.
      //
      // Measured in the shipped window on 2026-09-08 (debug build, 1920×1080 client, the
      // reader's own corpus and image cache), by driving real `mouseWheel` bursts down the
      // search wall and reading the **screen's own framebuffer** rather than a screenshot:
      // frames whose `<img>` reported `complete === true` and `naturalWidth === 672` were
      // drawn as flat surface colour — `sd 0`, `mean 24.09`, the exact colour of the empty
      // frame underneath — and *stayed* that way six seconds later with nothing touching the
      // page. Three runs, blanks by pass 3, 4 and 11. They come in contiguous right-hand
      // blocks that break at the same column on consecutive rows, which is a raster region
      // and not anything the app can see. With `"sync"`: **432 tile-measurements over 40
      // passes, zero**.
      //
      // **Why the watchdog above cannot help, and this is the part worth remembering.** Its
      // first guard is `el.complete && el.naturalWidth > 0` — the honest answer to "did this
      // picture arrive", and in this failure the answer is *yes*. Nothing arrived late and
      // nothing was refused; the bytes are decoded and in memory. So the silence watchdog,
      // `useImageRetry`, the console and the error log are all correct and all blind, which
      // is exactly why this outlived the fix that was supposed to be it.
      //
      // **`"sync"` rather than dropping the attribute.** Absent, the value is `auto` and the
      // choice is Chromium's heuristic — which measured clean too, over a smaller sample, and
      // is free to pick the async path again under memory pressure or for a bigger image. The
      // bug is that the deferred-presentation step loses its paint; `"sync"` is the one value
      // that removes the step rather than betting on the heuristic avoiding it.
      //
      // **It is not the trade it sounds like.** Same gesture, same build, 60 wheel bursts:
      // `sync` 47 long tasks / 2 985 ms / worst **79 ms** against `auto`'s 48 / 3 288 ms /
      // worst **128 ms**, with `TaskDuration` 12.34 s against 12.61 s. Inside the noise, and
      // certainly not slower — a WEBP this size decodes in well under a frame, and the decode
      // was always going to happen. What `async` bought was never the decode; it was the
      // right to show the frame without it.
      //
      // Before the spread, so a caller can still override it, and here rather than at the ten
      // call sites that used to pass `decoding="async"` by hand — `draggable` above is in this
      // position for the same reason, and it is the reason the two of them are: a rule every
      // caller has to remember is a rule some caller forgets, and this one forgets silently.
      decoding="sync"
      src={url}
      alt={alt}
      onLoad={(event) => {
        // Nothing left to watch for. Settled here rather than through state so a screenful of
        // arriving pictures is not a screenful of re-renders.
        settle.current?.();
        onLoad?.(event);
      }}
      onError={(event) => {
        // The protocol answered, and it answered "no". That is the backoff's business, not
        // this watchdog's — and scrolling the frame back into view must not make it so.
        settle.current?.();
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
