import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@grimoire/ui/lib/utils";

/** The closest a pinch draws the picture: a card's rules text at a phone's width, readable. */
export const ZOOM_MAX = 4;
/** Where a double tap takes the picture, centred on the tap. */
export const ZOOM_TAP = 2.5;
/** Two taps this close in time and place are a double tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 24;
/** A finger that moves less than this between down and up was a tap. */
const TAP_SLOP_PX = 10;

/**
 * Whole-literal classes for the snap after a double tap or a let-go — Tailwind reads source text,
 * so they are written here rather than assembled. Off while a finger is down, or the picture
 * would trail the finger by the length of the tween.
 */
const SNAP = [
  "transition-transform",
  "duration-[var(--duration-base)]",
  "ease-standard",
  "motion-reduce:transition-none",
];

interface View {
  scale: number;
  x: number;
  y: number;
}

/**
 * **A pinch zooms the picture and nothing else** — the card sheet's art, now that the page as a
 * whole no longer zooms (`touchShell.ts`). Two fingers zoom about their midpoint, one finger pans
 * a zoomed picture, a double tap zooms to {@link ZOOM_TAP} at the tap or back out, and the picture
 * stays inside its own frame: the frame clips it, and a pan stops at the picture's edges.
 *
 * **One finger on a picture at rest is the sheet's scroll**, untouched: only a second finger, or a
 * picture already zoomed, cancels the move. Touch events and a non-passive `touchmove` for that
 * reason — a pointer-events version would need `touch-action: none` on the frame, and the frame is
 * the largest thing on the sheet to start a scroll from.
 *
 * The transform is written to the element rather than rendered: a pinch is sixty writes a second,
 * and none of them is state anything else reads. A picture swapped for another (the sheet's
 * printings) is a fresh mount — key this by the card.
 */
export function PinchZoom({ children, className }: { children: ReactNode; className?: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = frame.current;
    const inner = layer.current;
    if (box === null || inner === null) return;

    let view: View = { scale: 1, x: 0, y: 0 };
    /** The gesture under way: where it started, in the frame's own coordinates. */
    let pinch: { from: View; mid: { x: number; y: number }; spread: number } | null = null;
    let pan: { from: View; at: { x: number; y: number } } | null = null;
    let tap: { x: number; y: number; moved: boolean } | null = null;
    let lastTap: { x: number; y: number; t: number } | null = null;

    const local = (t: Touch) => {
      const r = box.getBoundingClientRect();
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    const clamp = (v: View): View => {
      const scale = Math.min(ZOOM_MAX, Math.max(1, v.scale));
      const w = box.clientWidth;
      const h = box.clientHeight;
      return {
        scale,
        x: Math.min(0, Math.max(w - w * scale, v.x)),
        y: Math.min(0, Math.max(h - h * scale, v.y)),
      };
    };
    const draw = (next: View, snap: boolean) => {
      view = clamp(next);
      if (snap) inner.classList.add(...SNAP);
      else inner.classList.remove(...SNAP);
      inner.style.transform =
        view.scale === 1 ? "" : `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    };
    /** Zoom to `scale` keeping the picture's point under `at` where it is. */
    const zoomAt = (from: View, scale: number, at: { x: number; y: number }, to = at): View => {
      const cx = (at.x - from.x) / from.scale;
      const cy = (at.y - from.y) / from.scale;
      return { scale, x: to.x - cx * scale, y: to.y - cy * scale };
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const [a, b] = [local(e.touches[0]), local(e.touches[1])];
        pinch = {
          from: view,
          mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          spread: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        };
        pan = null;
        tap = null;
      } else if (e.touches.length === 1) {
        const at = local(e.touches[0]);
        tap = { ...at, moved: false };
        pan = view.scale > 1 ? { from: view, at } : null;
      }
    };
    const onMove = (e: TouchEvent) => {
      if (tap !== null && e.touches.length === 1) {
        const at = local(e.touches[0]);
        if (Math.hypot(at.x - tap.x, at.y - tap.y) > TAP_SLOP_PX) tap.moved = true;
      }
      if (pinch !== null && e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        const [a, b] = [local(e.touches[0]), local(e.touches[1])];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const scale = (pinch.from.scale * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.spread;
        draw(zoomAt(pinch.from, scale, pinch.mid, mid), false);
      } else if (pan !== null && e.touches.length === 1) {
        if (e.cancelable) e.preventDefault();
        const at = local(e.touches[0]);
        draw(
          { ...pan.from, x: pan.from.x + at.x - pan.at.x, y: pan.from.y + at.y - pan.at.y },
          false,
        );
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
      if (e.touches.length === 1) {
        // A finger left of a pinch carries on as a pan from here.
        pan = view.scale > 1 ? { from: view, at: local(e.touches[0]) } : null;
        return;
      }
      if (e.touches.length > 0) return;
      pan = null;
      const ended = tap;
      tap = null;
      if (ended === null || ended.moved) return;
      const now = e.timeStamp;
      if (
        lastTap !== null &&
        now - lastTap.t < DOUBLE_TAP_MS &&
        Math.hypot(ended.x - lastTap.x, ended.y - lastTap.y) < DOUBLE_TAP_PX
      ) {
        lastTap = null;
        if (e.cancelable) e.preventDefault();
        draw(view.scale > 1 ? { scale: 1, x: 0, y: 0 } : zoomAt(view, ZOOM_TAP, ended), true);
      } else {
        lastTap = { x: ended.x, y: ended.y, t: now };
      }
    };

    box.addEventListener("touchstart", onStart, { passive: true });
    box.addEventListener("touchmove", onMove, { passive: false });
    box.addEventListener("touchend", onEnd, { passive: false });
    box.addEventListener("touchcancel", onEnd, { passive: false });
    return () => {
      box.removeEventListener("touchstart", onStart);
      box.removeEventListener("touchmove", onMove);
      box.removeEventListener("touchend", onEnd);
      box.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  return (
    // `overflow-hidden` is the frame the zoomed picture stays inside. At rest the picture fills
    // it exactly, so nothing is clipped until a pinch has made it larger than its frame.
    <div ref={frame} className={cn("overflow-hidden", className)}>
      <div ref={layer} className="origin-top-left">
        {children}
      </div>
    </div>
  );
}
