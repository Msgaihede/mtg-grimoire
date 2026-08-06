import { useCallback, useEffect, useState } from "react";
import { imageRetryDelayMs, IMAGE_RETRY_LIMIT } from "@/lib/images";

/**
 * The schedule this hook runs on, re-exported so a caller needs one import rather than two.
 * The numbers themselves live with the rest of the image facts in `@/lib/images`, which is
 * also where they are tested.
 */
export { imageRetryDelayMs, IMAGE_RETRY_LIMIT };

/**
 * What a frame is doing about its image.
 *
 * There is no loading state: the empty frame *is* the placeholder and it is already on
 * screen, so the art simply draws into it when the bytes arrive. A shimmer over forty of
 * these would be the only animation on a page whose whole argument is that the art is the
 * loudest thing in it.
 */
type RetryState = "showing" | "waiting" | "failed";

/** What a caller needs to draw one image that may not arrive. */
export interface ImageRetry {
  /**
   * The URL to draw **now**, or `null` when there is nothing to draw — no image was asked
   * for, a retry is pending, or the retries are spent. So the call site is
   * `src ? <img src={src} onError={onError} …/> : <whatever this frame says instead>`, and
   * an `<img>` can never be left on screen holding a URL that has already failed.
   *
   * After a retry it carries a `?retry=N` marker, which is what stops anything between the
   * renderer and the protocol handler from answering the second request out of whatever it
   * made of the first. The query string is not part of the path the protocol parses, so it
   * changes nothing else.
   */
  src: string | null;
  /** The retries are spent. The frame says so and waits to be asked again — a remount. */
  failed: boolean;
  /** A retry is scheduled. The frame says *that*, which is a different thing to say. */
  retrying: boolean;
  /** Hand straight to the `<img>`'s `onError`. */
  onError: () => void;
}

/**
 * One image that may not arrive, and what to do about it — the self-healing half of the
 * rate limit, shared by every frame in the app that draws card art.
 *
 * A 429 anywhere in the image fetcher makes every uncached image fail fast with a 503 +
 * `Retry-After`, and an `<img>` that errors once stays broken for the rest of the session:
 * nothing re-requests it, so a single rate limit leaves a wall of grey rectangles that only
 * a restart can fill. So the frame comes back on its own, **twice**, on a doubling delay
 * that starts no sooner than the floor the protocol clamps its own penalty to
 * ({@link imageRetryDelayMs}) and is dithered so a screenful of them does not return in one
 * tick.
 *
 * Twice, because a lockout longer than the floor swallows the first attempt whole: at
 * `Retry-After: 60` the frame comes back at ~30 s, meets a gate that is still shut, and a
 * single-shot schedule would leave it on "No image" over a lockout that ended half a minute
 * later. One timer per frame at a time either way. After the second the frame waits to be
 * asked: scrolling it out of view and back is a remount, which is a reader saying "now".
 *
 * **Changing `src` resets everything.** The callers belong to a *slot* rather than to a
 * card — a tile in a virtualised wall, a deck's cover frame — so a new image arrives without
 * a remount, and without the reset it would inherit the previous one's failure: a frame stuck
 * on "No image" over a picture that is perfectly fetchable. The reset happens during render,
 * which is React's own answer to state derived from props; an effect would paint one frame of
 * the last image's failure over the new image's art.
 *
 * What is deliberately *not* here is what a frame says when it has nothing to draw. A card
 * tile falls back to the card's own name inside the frame; a deck cover already has its name
 * in the caption underneath and needs the frame to say what happened instead — and it has a
 * third thing to say ("No cover") that this hook cannot know about. Two `boolean`s and a URL
 * is the whole of what they share.
 */
export function useImageRetry(src: string | null): ImageRetry {
  const [state, setState] = useState<RetryState>("showing");
  const [attempt, setAttempt] = useState(0);
  const [shown, setShown] = useState(src);

  // Compared by value, not by identity: `cardImageUrl(...)` is rebuilt on every render and
  // is a new string every time, so an identity check here would reset the machine forever.
  if (shown !== src) {
    setShown(src);
    setState("showing");
    setAttempt(0);
  }

  useEffect(() => {
    if (state !== "waiting") return;
    const next = attempt + 1;
    const timer = setTimeout(() => {
      setAttempt(next);
      setState("showing");
    }, imageRetryDelayMs(next));
    return () => clearTimeout(timer);
  }, [state, attempt]);

  const onError = useCallback(() => {
    // Nothing was asked for, so nothing failed — a frame with no image at all must not
    // schedule a retry of it. Reachable: an `<img>` a caller draws for its own reasons.
    if (src === null) return;
    setState(attempt < IMAGE_RETRY_LIMIT ? "waiting" : "failed");
  }, [src, attempt]);

  // Nothing to draw while a retry is pending or spent — which is what keeps a caller from
  // leaving an `<img>` on screen holding a URL that has already failed.
  const showing = src !== null && state === "showing";

  return {
    src: showing ? (attempt === 0 ? src : `${src}?retry=${attempt}`) : null,
    failed: state === "failed",
    retrying: state === "waiting",
    onError,
  };
}
