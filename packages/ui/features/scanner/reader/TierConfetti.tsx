/**
 * Confetti over the camera picture as a card lands, by the price tier its sound plays at — more
 * pieces and more colours the higher the tier, and for the jackpot rain from the top, a gold flash
 * and a glow round the edge. What the pieces are and where each one is lives in `confetti.ts`;
 * this file only draws it.
 *
 * **It renders into the camera box**, like `AddedToast`: one `absolute inset-0` canvas the size of
 * the picture, so the confetti is only ever over the picture. The page places it before the popup
 * in DOM order, so the burst leaves from behind the card.
 *
 * **A `<canvas>`, not elements**: three hundred moving pieces as DOM nodes would be three hundred
 * elements restyled every frame over a live camera picture; on a canvas they are one bitmap, and
 * nothing is written into the page's styles at all. It is drawn on `requestAnimationFrame` and
 * stops as soon as the last piece is gone.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";
import type { PriceTier } from "../sounds/scanSounds";
import {
  CONFETTI_TOKEN,
  DESIGN_HEIGHT,
  confettiEnd,
  confettiPieces,
  confettiRatio,
  confettiSeed,
  flashAt,
  flashSquare,
  glowAt,
  pieceAt,
  type ConfettiBox,
  type ConfettiColor,
  type ConfettiPiece,
  type Rect,
} from "./confetti";

/** One landing's confetti: which landing, and at which tier. */
export interface ConfettiBurst {
  /** Changes on every landing — `LandedCard.stamp` — and throws a new burst. */
  stamp: string;
  tier: PriceTier;
}

export interface TierConfettiProps {
  /** The landing to throw confetti for, or `null` for none. */
  burst: ConfettiBurst | null;
  /** How far above the picture's foot the burst leaves from — behind the Added popup. */
  originBottom?: number;
}

/** The flash's reach from the origin, in pixels of a 600 px tall picture. */
const FLASH_RADIUS = 320;
/** How far in from the edge the glow reaches, in pixels of a 600 px tall picture. */
const GLOW_DEPTH = 44;

/**
 * **Decorative and `aria-hidden`**: the HUD's live region (`ScanHud`'s `Scanner status`) says what
 * landed; the confetti says only how much it was worth, which the popup's price already says in
 * words.
 * `pointer-events-none`, so nothing under it stops answering a press.
 *
 * Plays once per new `stamp`; a new stamp while a burst is in the air starts the new one, at its
 * own tier, in place of the old. **Nothing at all under reduced motion** — no canvas is rendered;
 * the popup and the sound still say the card landed.
 */
export function TierConfetti({ burst, originBottom = 64 }: TierConfettiProps) {
  const reduced = useReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Latched rather than dependencies: the tier and the origin are read when a stamp arrives, so a
  // caller passing a fresh object each render does not restart the burst — only a new landing does.
  const latest = useRef({ burst, originBottom });
  useLayoutEffect(() => {
    latest.current = { burst, originBottom };
  });

  // What stops the burst in the air, if one is. Kept here rather than returned as the stamp
  // effect's cleanup, because **a `null` burst throws nothing and stops nothing**: the page puts
  // the popup away after its two-second hold, and a jackpot is still raining then.
  const running = useRef<(() => void) | undefined>(undefined);
  const stamp = burst?.stamp ?? null;
  useEffect(() => {
    const canvas = canvasRef.current;
    const current = latest.current;
    if (stamp === null || current.burst === null || canvas === null) return;
    running.current?.();
    running.current = play(canvas, current.burst.tier, stamp, current.originBottom);
  }, [stamp]);
  useEffect(() => () => running.current?.(), []);

  if (reduced === true) return null;
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full"
    />
  );
}

/**
 * Throws one burst on `canvas` and returns what stops it, or nothing when there is nothing to draw
 * on — a box with no size (jsdom lays nothing out), a canvas with no 2D context (jsdom has none),
 * or a palette whose tokens did not resolve.
 *
 * **Measured at the burst, not observed**: the canvas's bitmap is set to its box's CSS size times
 * {@link confettiRatio} as each burst starts — the device pixel ratio, so the pieces are sharp on a
 * 200 % display, **capped at a 1080p picture's pixels** (`MAX_CONFETTI_PIXELS`, issue #1724), so the
 * pack opener's whole-window picture is not an 8-megapixel bitmap redrawn every frame. A burst
 * lasts 5.2 seconds at most — the jackpot's last raindrop, dropped 1.9 s in and falling for 3.3 s
 * (`RAIN`) — and the box does not change size while a reader is scanning.
 *
 * **And the bitmap is let go the moment the burst is over** — its last frame, or the stop — by
 * sizing it back to 0×0. A cleared canvas is still a layer the size of its bitmap, and the browser
 * composites it over the camera picture on every frame for as long as it stays that size: before
 * issue #1724 the pack opener carried a full-window transparent bitmap from the first landing on,
 * and its frame rate never came back between bursts.
 */
function play(
  canvas: HTMLCanvasElement,
  tier: PriceTier,
  stamp: string,
  originBottom: number,
): (() => void) | undefined {
  const { width, height } = canvas.getBoundingClientRect();
  // The size before the context: under jsdom every box is 0×0, and asking a canvas for a context
  // there prints a "Not implemented" line for every landing a suite makes.
  if (width === 0 || height === 0) return;
  const ratio = confettiRatio(width, height, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  if (ctx === null) return release(canvas);
  const colors = resolveColors();
  if (colors === null) return release(canvas);

  const box: ConfettiBox = { width, height, originX: width / 2, originY: height - originBottom };
  const pieces = confettiPieces(tier, box, confettiSeed(stamp));
  const end = confettiEnd(tier, pieces);

  let raf = 0;
  let start: number | null = null;
  const frame = (now: number) => {
    start ??= now;
    const ms = now - start;
    // The last frame lets the bitmap go: once every piece is gone, or the canvas has left the page
    // (reduced motion switched on mid-burst), the loop stops rather than drawing nothing forever.
    if (ms > end || !canvas.isConnected) {
      release(canvas);
      return;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, width, height);
    drawFrame(ctx, tier, pieces, colors, box, ratio, ms);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    release(canvas);
  };
}

/**
 * The bitmap given back: a 0×0 canvas holds nothing to clear and nothing to composite. The next
 * burst sizes it again — and its context, which a resize resets, is the same object.
 */
function release(canvas: HTMLCanvasElement): undefined {
  canvas.width = 0;
  canvas.height = 0;
  return undefined;
}

/**
 * The palette, read off the document once per burst — the tokens the rest of the app draws in, so
 * the gold here is the popup's gold. `null` when any of them is missing (jsdom loads no
 * stylesheet), which skips the burst rather than drawing it in the canvas's default black.
 */
function resolveColors(): Record<ConfettiColor, string> | null {
  const style = getComputedStyle(document.documentElement);
  const colors = {} as Record<ConfettiColor, string>;
  for (const name of Object.keys(CONFETTI_TOKEN) as ConfettiColor[]) {
    const value = style.getPropertyValue(CONFETTI_TOKEN[name]).trim();
    if (value === "") return null;
    colors[name] = value;
  }
  return colors;
}

/** One frame: the flash and the glow first, under the pieces, then every piece in the air. */
function drawFrame(
  ctx: CanvasRenderingContext2D,
  tier: PriceTier,
  pieces: readonly ConfettiPiece[],
  colors: Record<ConfettiColor, string>,
  box: ConfettiBox,
  ratio: number,
  ms: number,
): void {
  const scale = box.height / DESIGN_HEIGHT;
  const flash = flashAt(tier, ms);
  const glow = glowAt(tier, ms);

  if (flash !== null || glow !== null) {
    // **Drawn as an alpha mask, then tinted gold.** A canvas gradient blends its stops without
    // premultiplying, so a gold stop fading to `transparent` (transparent *black*) passes through
    // brown on its way out. The mask's colour is never seen — only its alpha counts — and the
    // `source-atop` fill paints the gold exactly where the mask is, at the mask's alpha.
    //
    // **Every fill covers only where its mask is** (issue #1724): the flash its own square, the
    // glow its four bands. Outside them the canvas is empty, so a `source-atop` fill there changes
    // nothing — and over the pack opener's whole-window picture, two full-canvas fills a frame
    // were most of what a jackpot cost. A tint landing twice where the two overlap is the same
    // gold at the same alpha.
    const marked: Rect[] = [];
    if (flash !== null) {
      const radius = FLASH_RADIUS * scale;
      const light = ctx.createRadialGradient(
        box.originX,
        box.originY,
        0,
        box.originX,
        box.originY,
        radius,
      );
      light.addColorStop(0, "rgba(0,0,0,0.6)");
      light.addColorStop(0.4, "rgba(0,0,0,0.22)");
      light.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalAlpha = flash;
      ctx.fillStyle = light;
      const square = flashSquare(box, radius);
      if (square !== null) {
        ctx.fillRect(...square);
        marked.push(square);
      }
    }
    if (glow !== null) {
      ctx.globalAlpha = glow;
      marked.push(...drawEdge(ctx, box.width, box.height, GLOW_DEPTH * scale));
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = colors.accent;
    for (const rect of marked) ctx.fillRect(...rect);
    ctx.globalCompositeOperation = "source-over";
  }

  for (const piece of pieces) {
    const pose = pieceAt(piece, ms);
    if (pose === null) continue;
    const cos = Math.cos(pose.rotation);
    const sin = Math.sin(pose.rotation);
    // Translate, turn and tumble in one matrix, at the device pixel ratio: the same as
    // `translate` · `rotate` · `scale(1, scaleY)` after the frame's own scale, in one call.
    ctx.setTransform(
      ratio * cos,
      ratio * sin,
      -ratio * sin * pose.scaleY,
      ratio * cos * pose.scaleY,
      ratio * pose.x,
      ratio * pose.y,
    );
    ctx.globalAlpha = pose.opacity;
    ctx.fillStyle = colors[piece.color];
    ctx.fillRect(-piece.width / 2, -piece.length / 2, piece.width, piece.length);
  }
}

/**
 * The glow's mask: each edge fading inward over `depth`, brightest where two edges meet. Answers
 * the four bands it filled, for the tint to cover and nothing more.
 */
function drawEdge(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  depth: number,
): Rect[] {
  // Each side: the gradient's line from the edge inward, then the band it fills.
  const sides: [number, number, number, number, Rect][] = [
    [0, 0, 0, depth, [0, 0, width, depth]],
    [0, height, 0, height - depth, [0, height - depth, width, depth]],
    [0, 0, depth, 0, [0, 0, depth, height]],
    [width, 0, width - depth, 0, [width - depth, 0, depth, height]],
  ];
  for (const [x0, y0, x1, y1, rect] of sides) {
    const band = ctx.createLinearGradient(x0, y0, x1, y1);
    band.addColorStop(0, "rgba(0,0,0,0.7)");
    band.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = band;
    ctx.fillRect(...rect);
  }
  return sides.map(([, , , , rect]) => rect);
}
