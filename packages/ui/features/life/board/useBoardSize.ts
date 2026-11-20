import { useCallback, useState, type RefCallback } from "react";

export interface BoardSize {
  width: number;
  height: number;
}

/**
 * The board's own size, kept current by a `ResizeObserver` — `useElementWidth`'s shape and its
 * reasons (a callback ref, so the observer starts the moment the box exists and stops with it; the
 * state set from the observer and nothing else), with the height beside the width, because every
 * seat on the board is a share of both.
 *
 * **`null` is unmeasured**, and the board draws nothing that depends on its geometry until it is
 * not: a first frame laid out for a guessed size and then for the real one is a flash of the wrong
 * table. jsdom's observer never reports (`test-setup.ts` installs a no-op), so a suite reports a
 * size itself.
 */
export function useBoardSize<T extends HTMLElement>(): [RefCallback<T>, BoardSize | null] {
  const [size, setSize] = useState<BoardSize | null>(null);
  const ref = useCallback((el: T | null) => {
    if (el === null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      // A box with no area is not a board yet (a parent still laying out, a hidden tab).
      if (width <= 0 || height <= 0) return;
      setSize((was) =>
        was !== null && was.width === width && was.height === height ? was : { width, height },
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}
