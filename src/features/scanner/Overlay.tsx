import { useEffect, useLayoutEffect, useRef, type JSX, type RefObject } from "react";
import type { ScannerCorner, ScannerVerdict } from "./types";

/** The smoothed quad, once it has held still. */
const QUAD = "#5ed69a";
/** This frame's own detection, behind it. Faint red so the gap between the two reads as jitter. */
const RAW = "#e88";
/** The corner the rectifier treats as top-left, so a 180° flip is visible live. */
const CORNER = "#e05ad0";

/**
 * The box over the video — the one part of the scanner that has to keep up with the camera.
 *
 * **The detector answers around nine times a second and the camera runs at thirty to sixty, so
 * the overlay redraws on `requestAnimationFrame` and reads the verdict from a ref.** Drawing on
 * a React render instead would tie the box to the detector's rate and make every answer a
 * commit; reading through a ref means the parent's re-render costs one assignment and the
 * canvas keeps painting at the display's rate either way. Nothing here ever calls `setState`.
 *
 * **The quad is in the coordinates of the frame that was *sent*, not the video's**, which is
 * smaller by the send slider's scale — hence `sx`/`sy` off `verdict.frame`. Scaling here rather
 * than in the crate keeps the wire payload independent of how big the preview happens to be.
 *
 * No unit test: jsdom's canvas has no 2D context, so every line below is a no-op there and a
 * test could only assert that the calls were made. The live pass is what proves this one.
 */
export function Overlay({
  videoRef,
  verdict,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  verdict: ScannerVerdict | null;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const verdictRef = useRef(verdict);
  // A layout effect, not an assignment during render: the ref has to be current before the next
  // animation frame reads it, and `useEffect` alone is not guaranteed to run before that.
  useLayoutEffect(() => {
    verdictRef.current = verdict;
  });

  useEffect(() => {
    let raf = 0;

    function draw() {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (canvas === null || video === null) return;

      // Sized to the video's own pixels rather than to the element's CSS box: these two
      // attributes are also the canvas's *intrinsic* size, which is what `object-contain` on
      // the element letterboxes — so one coordinate system serves every layout and lands on
      // the picture rather than beside it.
      // Assigning either dimension clears the canvas, so only do it when it actually changed.
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
      const ctx = canvas.getContext("2d");
      if (ctx === null || canvas.width === 0 || canvas.height === 0) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const v = verdictRef.current;
      if (v === null || v.frame.w === 0 || v.frame.h === 0) return;
      const sx = canvas.width / v.frame.w;
      const sy = canvas.height / v.frame.h;

      // The widths are a fraction of the canvas rather than literal pixels, because the canvas
      // is sized to the *video* and stretched down to the element: a 3px stroke on a 1920-wide
      // canvas in a 640px box draws at one CSS pixel, and the 1px raw box at a third of one.
      // `crates/card-scanner/src/bin/live.html`'s `draw()` verbatim, the `Math.max` floors
      // included — they are what keeps the box visible on a low-resolution camera.
      const stroke = Math.max(2, canvas.width / 300);
      const hair = Math.max(1, canvas.width / 700);

      if (v.quad_raw !== null) {
        ctx.save();
        ctx.setLineDash([4, 6]);
        ctx.lineWidth = hair;
        ctx.strokeStyle = RAW;
        trace(ctx, v.quad_raw, sx, sy);
        ctx.stroke();
        ctx.restore();
      }

      if (v.quad !== null) {
        ctx.lineWidth = stroke;
        ctx.strokeStyle = QUAD;
        trace(ctx, v.quad, sx, sy);
        ctx.stroke();
        const first = v.quad[0];
        if (first !== undefined) {
          // The reference draws the dot after restoring the raw box's `save()`, so the radius is
          // off the *smoothed* width and not the hairline.
          ctx.fillStyle = CORNER;
          ctx.beginPath();
          ctx.arc(first[0] * sx, first[1] * sy, stroke * 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [videoRef]);

  return (
    // Decorative: the headline and the panels beside the video say everything a screen reader
    // needs, and a box drawn around a card has no description an `alt` could usefully carry.
    //
    // **`object-contain` matches the `<video>` under it, and the box is wrong without it.** A
    // `<canvas>` is a replaced element whose intrinsic size is its `width`/`height` *attributes*
    // — the video's own pixels, assigned in `draw()` — so `object-fit` letterboxes it exactly
    // as the video is letterboxed. Left at the default `fill`, the 1920×1080 bitmap is stretched
    // to the element's box while the picture inside that box is not: a 16:9 frame in the app's
    // 1280×800 column draws the quad 25% too tall, and further out the narrower the column gets.
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 h-full w-full object-contain"
    />
  );
}

function trace(ctx: CanvasRenderingContext2D, quad: ScannerCorner[], sx: number, sy: number): void {
  ctx.beginPath();
  quad.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * sx, y * sy) : ctx.lineTo(x * sx, y * sy)));
  ctx.closePath();
}
