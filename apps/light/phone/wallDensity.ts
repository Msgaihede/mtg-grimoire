import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { create } from "zustand";
import { columnsAt, columnsFor } from "./wall";

/**
 * How dense the reader has pinched the card walls: columns more (+) or fewer (−) than a wall's
 * width would draw on its own (`wall.ts`'s `columnsAt`).
 *
 * **One answer for every wall on the face** — Search, the collection, the wishlist, a cabinet's
 * shelves — because it is how big the reader likes a card drawn, not a fact about one list.
 * **An offset rather than a count**, so a phone turned on its side keeps the reader's preference
 * relative to the room it has rather than a column count sized for the other orientation.
 *
 * **Remembered across launches in `localStorage`**, the page's own: it is a way of looking, like
 * the session-held transfer choices beside it, but one a reader sets once and should not have to
 * pinch again each morning. A host that refuses the store (a private window) keeps it for the
 * session, and an unreadable value is the default.
 */
const KEY = "grimoire.phone.wallDensity";

function readOffset(): number {
  try {
    const raw = Number(window.localStorage.getItem(KEY));
    return Number.isInteger(raw) && Math.abs(raw) <= 8 ? raw : 0;
  } catch {
    return 0;
  }
}

interface WallDensity {
  offset: number;
  setOffset: (offset: number) => void;
}

export const useWallDensity = create<WallDensity>((set) => ({
  offset: readOffset(),
  setOffset: (offset) => {
    try {
      window.localStorage.setItem(KEY, String(offset));
    } catch {
      // Kept for the session.
    }
    set({ offset });
  },
}));

/**
 * How far two fingers must spread (or close) for one column's step, as a ratio of their distance
 * when the step began. A pinch that keeps going steps again from where the last step left it.
 */
export const PINCH_STEP = 1.3;

/**
 * The columns a wall `width` px wide draws, and **a pinch on `scroller` that changes them** —
 * fingers apart for bigger cards (fewer columns), together for smaller ones.
 *
 * Touch events rather than pointer events, and a non-passive `touchmove`: the wall scrolls, and
 * only a listener that may cancel the move can keep a two-finger gesture from scrolling it as well.
 * One finger is never touched: it is the wall's scroll, and a tile's press.
 */
export function useWallColumns(scroller: RefObject<HTMLElement | null>, width: number): number {
  const offset = useWallDensity((s) => s.offset);
  const columns = columnsAt(width, offset);
  // Read by the listeners, which are attached once: the step is from what is drawn now.
  const now = useRef({ width, columns });
  useLayoutEffect(() => {
    now.current = { width, columns };
  });

  useEffect(() => {
    const el = scroller.current;
    if (el === null) return;
    let from: number | null = null;
    const spread = (e: TouchEvent): number => {
      const [a, b] = [e.touches[0], e.touches[1]];
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };
    const onStart = (e: TouchEvent) => {
      from = e.touches.length === 2 ? spread(e) : null;
    };
    const onMove = (e: TouchEvent) => {
      if (from === null || e.touches.length !== 2) return;
      if (e.cancelable) e.preventDefault();
      const ratio = spread(e) / from;
      const step = ratio >= PINCH_STEP ? -1 : ratio <= 1 / PINCH_STEP ? 1 : 0;
      if (step === 0) return;
      from = spread(e);
      const { width: w, columns: c } = now.current;
      const next = columnsAt(w, c - columnsFor(w) + step);
      if (next !== c) useWallDensity.getState().setOffset(next - columnsFor(w));
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) from = null;
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [scroller]);

  return columns;
}

/**
 * Keep the reader's place when a wall's columns change under them: the scroller's offset scaled
 * by how much the wall's height moved, so the cards that were at the top of the glass are still
 * about there. Without it a pinch deep in a list jumps rows' worth — the same offset in px is a
 * different card once every row is taller.
 */
export function useKeepPlace(
  scroller: RefObject<HTMLElement | null>,
  columns: number,
  total: number,
): void {
  const before = useRef({ columns, total });
  // A layout effect, after the virtualiser has measured the new rows (call this after that
  // effect), and before paint.
  useLayoutEffect(() => {
    const was = before.current;
    before.current = { columns, total };
    const el = scroller.current;
    if (el === null || was.columns === columns || was.total <= 0) return;
    el.scrollTo({ top: (el.scrollTop * total) / was.total, behavior: "instant" });
  }, [scroller, columns, total]);
}
