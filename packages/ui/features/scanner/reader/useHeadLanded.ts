import { useEffect, useEffectEvent, useRef } from "react";
import type { ScannerTrayRow } from "@/lib/ipc";
import { headLanded } from "./tray";

/**
 * Call `onLanded` after a render whose rows have a card at their head that the rows drawn before
 * did not ({@link headLanded}) — what a tray scrolls back to its top on (issue #1320).
 *
 * **Never on the first render**: a tray opened on cards it already held has had nothing land, and
 * a reader coming back to it should find it where it opens. Both faces' trays call it, so the two
 * agree on what a landing is and differ only in how they scroll.
 */
export function useHeadLanded(rows: readonly ScannerTrayRow[], onLanded: () => void) {
  const drawn = useRef(rows);
  const landed = useEffectEvent(onLanded);
  useEffect(() => {
    const before = drawn.current;
    drawn.current = rows;
    if (headLanded(before, rows)) landed();
  }, [rows]);
}
