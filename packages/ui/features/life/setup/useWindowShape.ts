import { useSyncExternalStore } from "react";

/** The window's size in CSS pixels — what the board will fill, and so what the setup draws. */
export interface WindowShape {
  wide: number;
  high: number;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/** A string, so an unchanged size is an equal snapshot and nothing re-renders for it. */
const snapshot = (): string => `${window.innerWidth}x${window.innerHeight}`;

/**
 * **The window, not the form's box**, because the setup's two questions are about the board and
 * the board fills the window on both faces of the light app (the phone face's `fixed inset-0`
 * frame, the desktop face's below the caption): which way the seats face until the reader picks
 * (`resolveSeating` at the board's width), and the shape the Layout pictures are drawn in.
 */
export function useWindowShape(): WindowShape {
  const shape = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [wide, high] = shape.split("x").map(Number);
  return { wide: wide || 1, high: high || 1 };
}
