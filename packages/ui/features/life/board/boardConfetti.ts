/**
 * The roulette's confetti: **the scanner's, as the scanner throws it** — its second price tier's
 * burst (`features/scanner/reader/confetti.ts`: 58 pieces, gold, cream and white, chips with a few
 * streamers, out for a third of their life and falling for the rest). The pieces and where each
 * one is come from that module untouched; the only thing that is this board's own is where the
 * burst happens. It leaves from the middle of the winner's panel, and "up" is the way that player
 * faces, so it flies out across the table towards them.
 *
 * **At the scanner's own scale.** The burst is thrown into a box exactly `DESIGN_HEIGHT` tall, so
 * its lengths are the design's pixels unscaled (the design canvas drew it that way), with the
 * origin at 0,0 — the panel's centre and the player's turn are put on the canvas's transform.
 */
import {
  CONFETTI_TOKEN,
  DESIGN_HEIGHT,
  confettiEnd,
  confettiPieces,
  confettiSeed,
  pieceAt,
  type ConfettiColor,
} from "@/features/scanner/reader/confetti";

/** Throws one burst on `canvas` from (`cx`, `cy`), aimed `rot` degrees round from straight up;
 *  returns what stops it, or nothing when there is nothing to draw on (jsdom). */
export function throwConfetti(
  canvas: HTMLCanvasElement,
  cx: number,
  cy: number,
  rot: number,
  stamp: string,
): (() => void) | undefined {
  const { width, height } = canvas.getBoundingClientRect();
  // The size before the context: jsdom lays nothing out and prints a line for every context asked.
  if (width === 0 || height === 0) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;

  const style = getComputedStyle(document.documentElement);
  const paint = {} as Record<ConfettiColor, string>;
  for (const name of Object.keys(CONFETTI_TOKEN) as ConfettiColor[]) {
    paint[name] = style.getPropertyValue(CONFETTI_TOKEN[name]).trim() || "#fff";
  }

  const pieces = confettiPieces(
    "tier2",
    { width: DESIGN_HEIGHT, height: DESIGN_HEIGHT, originX: 0, originY: 0 },
    confettiSeed(stamp),
  );
  const end = confettiEnd("tier2", pieces);
  const turned = (rot * Math.PI) / 180;

  let raf = 0;
  let start: number | null = null;
  const frame = (now: number) => {
    start ??= now;
    const ms = now - start;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (ms > end || !canvas.isConnected) return;
    for (const piece of pieces) {
      const pose = pieceAt(piece, ms);
      if (pose === null) continue;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.translate(cx, cy);
      ctx.rotate(turned);
      ctx.translate(pose.x, pose.y);
      ctx.rotate(pose.rotation);
      ctx.scale(1, pose.scaleY);
      ctx.globalAlpha = pose.opacity;
      ctx.fillStyle = paint[piece.color];
      ctx.fillRect(-piece.width / 2, -piece.length / 2, piece.width, piece.length);
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };
}
