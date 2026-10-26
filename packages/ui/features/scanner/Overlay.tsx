import { useEffect, useLayoutEffect, useRef, type JSX, type RefObject } from "react";
import { cornerMarks } from "./scanCorners";
import type { ScannerVerdict } from "./types";

/** The marks' colour: the app's gold, read off the document — the popup's and the bar's. */
const MARK_TOKEN = "--color-accent";
/** The marks' width on screen, in CSS pixels, whatever the camera's resolution or the crop. */
const MARK_WIDTH = 2;
/** The corner the scanner treats as top-left, so a 180° flip is visible live — the Developer
 *  switch's alone, a debugging aid and no part of the reader's picture. */
const ORIENTATION = "#e05ad0";

/**
 * The box over the video — the one part of the scanner that has to keep up with the camera.
 *
 * **The scanner answers around nine times a second and the camera runs at thirty to sixty, so
 * the overlay redraws on `requestAnimationFrame` and reads the verdict from a ref.** Drawing on
 * a React render instead would tie the box to the scanner's rate and make every answer a
 * commit; reading through a ref means the parent's re-render costs one assignment and the
 * canvas keeps painting at the display's rate either way. Nothing here ever calls `setState`.
 *
 * **The quad is in the coordinates of the frame that was *sent*, not the video's**, which is
 * smaller by the pump's downscale — hence `sx`/`sy` off `verdict.frame`. Scaling here rather
 * than in the crate keeps the wire payload independent of how big the preview happens to be.
 *
 * **What it draws is four gold corners** (the scanner redesign, 2026-10-25), an L standing just
 * outside each corner of the card — never the whole quad, which was a green debug trace over the
 * picture. Their shape is `scanCorners.ts`'s, and tested there: jsdom's canvas has no 2D context,
 * so every line below is a no-op in a test, and the live pass is what proves the stroke.
 */
export function Overlay({
  videoRef,
  verdict,
  orientation = false,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  verdict: ScannerVerdict | null;
  /** Mark the corner the scanner reads as top-left — the Developer switch's debugging aid. */
  orientation?: boolean;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const verdictRef = useRef(verdict);
  const orientationRef = useRef(orientation);
  // A layout effect, not an assignment during render: the ref has to be current before the next
  // animation frame reads it, and `useEffect` alone is not guaranteed to run before that.
  useLayoutEffect(() => {
    verdictRef.current = verdict;
    orientationRef.current = orientation;
  });

  useEffect(() => {
    let raf = 0;
    // Read once: the token does not change while the picture is up, and `getComputedStyle` sixty
    // times a second would be a style recalculation a frame. Empty under jsdom, which loads no
    // stylesheet — and which has no context to draw with either.
    const gold = getComputedStyle(document.documentElement).getPropertyValue(MARK_TOKEN).trim();

    function draw() {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (canvas === null || video === null) return;

      // Sized to the video's own pixels rather than to the element's CSS box: these two
      // attributes are also the canvas's *intrinsic* size, which is what `object-cover` on
      // the element crops — so one coordinate system serves every layout and lands on the
      // picture exactly where the video's own crop put it.
      // Assigning either dimension clears the canvas, so only do it when it actually changed.
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
      // The size before the context: a stream with no picture yet is a 0×0 canvas with nothing to
      // draw on, and asking it for a context sixty times a second buys nothing — and under jsdom,
      // which has no canvas, prints a "Not implemented" line a frame for as long as the view is
      // mounted. Every suite that merely walks through the Scanner would wear that.
      if (canvas.width === 0 || canvas.height === 0) return;
      const ctx = canvas.getContext("2d");
      if (ctx === null) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const v = verdictRef.current;
      if (v === null || v.frame.w === 0 || v.frame.h === 0) return;
      const sx = canvas.width / v.frame.w;
      const sy = canvas.height / v.frame.h;

      // **The stroke is set in CSS pixels, then turned into the canvas's.** The canvas is sized to
      // the video and drawn into its box by `object-cover` — scaled by the larger of the two
      // ratios, the picture's overflow cropped — so a width fixed in canvas pixels came out 1.5px
      // on a phone on its side and nearly 4px upright, where the crop is deepest. Dividing by that
      // scale draws `MARK_WIDTH` on screen at every shape (2px, the owner's call, 2026-10-26).
      const scale = Math.max(
        canvas.clientWidth / canvas.width,
        canvas.clientHeight / canvas.height,
      );
      const stroke = MARK_WIDTH / (scale > 0 ? scale : 1);

      if (v.quad !== null) {
        const quad = v.quad.map(([x, y]) => [x * sx, y * sy] as const);
        if (gold !== "") {
          ctx.lineWidth = stroke;
          ctx.strokeStyle = gold;
          // Square at the bend and at the arms' ends — no rounding anywhere.
          ctx.lineJoin = "miter";
          ctx.lineCap = "butt";
          for (const mark of cornerMarks(quad)) {
            ctx.beginPath();
            ctx.moveTo(mark.start[0], mark.start[1]);
            ctx.lineTo(mark.corner[0], mark.corner[1]);
            ctx.lineTo(mark.end[0], mark.end[1]);
            ctx.stroke();
          }
        }
        const first = quad[0];
        if (orientationRef.current && first !== undefined) {
          ctx.fillStyle = ORIENTATION;
          ctx.beginPath();
          ctx.arc(first[0], first[1], stroke * 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [videoRef]);

  return (
    // Decorative: the headline and the panels beside the video say everything a screen reader
    // needs, and corners drawn around a card have no description an `alt` could usefully carry.
    //
    // **`object-cover` matches the `<video>` under it, and the corners are wrong without it.** A
    // `<canvas>` is a replaced element whose intrinsic size is its `width`/`height` *attributes*
    // — the video's own pixels, assigned in `draw()` — so `object-fit` crops it exactly as the
    // video is cropped, both about the centre. Left at the default `fill`, the 1920×1080 bitmap is
    // stretched to the element's box while the picture inside that box is not, and the corners land
    // off the card by however far the box's shape is from 16:9. **The two classes are one
    // decision**: change the video's fit or position and this one moves with it, or the marks
    // drift off the card with no error anywhere.
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 h-full w-full object-cover"
    />
  );
}
