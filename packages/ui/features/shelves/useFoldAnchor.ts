/**
 * **Keep the carried heading under the pointer while the wall folds and unfolds around it** — spec
 * §3.9: "the page stays anchored on the dragged heading as it folds and unfolds".
 * `useFoldOnFolderDrag` folds every shelf to its heading the moment a folder heading is picked up,
 * which shortens the wall above the heading by however many rows of cards it held; left alone, the
 * heading the reader is holding would jump out from under their hand, and the page would jump again
 * on the drop.
 *
 * **This hook is the page's half, `CardGrid` is the wall's, and `shelfCarry` (`./shelfCarry`) is
 * what passes between them.** The page knows the pointer and when it folds; only the wall knows
 * where a row *is* — during a drag the heading's own element is dnd-kit's floating copy at the
 * pointer, and its row is often not even drawn — so this hook feeds `shelfCarry` and the sectioned
 * wall answers from its layout. The whole argument, and the live pass (2026-09-26) that measured
 * the page-side version failing, is on `shelfCarry`'s state.
 *
 * - **The press**: a capture-phase `pointerdown` on `window` records the heading row the press
 *   landed in (`SHELF_HEADING_ROW`) and how far into it — a press anywhere else forgets it, so a
 *   card drag never moves the page. `pointermove` and `pointerup` keep the pointer. Passive
 *   listeners: nothing here may change what the gesture does.
 * - **The fold and the unfold**: on every change of `folding`, in a layout effect — after the wall
 *   has drawn the new layout and before the browser paints it.
 * - **The ending**: Escape (capture phase, so ahead of dnd-kit's own) is a cancelled drag; a
 *   `pointerup` mid-fold is a drop. A wheel or any other key afterwards is the reader taking the
 *   page back, and nothing re-anchors after it.
 *
 * **The table does not fold, so the page hands this `false` there** — `VirtualTable` keys its rows
 * by position, and folding under a carried heading would remount it and end the drag.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { SHELF_HEADING_ROW, SHELF_ID_ATTR, shelfCarry } from "./shelfCarry";

export function useFoldAnchor(folding: boolean): void {
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const row = e.target instanceof Element ? e.target.closest(SHELF_HEADING_ROW) : null;
      const shelfId = row ? Number(row.getAttribute(SHELF_ID_ATTR)) : Number.NaN;
      shelfCarry.press(
        row && Number.isInteger(shelfId)
          ? { shelfId, rowTop: row.getBoundingClientRect().top }
          : null,
        e.clientX,
        e.clientY,
      );
    };
    const move = (e: MouseEvent) => shelfCarry.move(e.clientX, e.clientY);
    const up = (e: MouseEvent) => shelfCarry.up(e.clientX, e.clientY);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") shelfCarry.escape();
      else shelfCarry.interrupt();
    };
    const wheel = () => shelfCarry.interrupt();
    const options = { capture: true, passive: true } as const;
    window.addEventListener("pointerdown", down, options);
    window.addEventListener("pointermove", move, options);
    window.addEventListener("pointerup", up, options);
    window.addEventListener("keydown", key, options);
    window.addEventListener("wheel", wheel, options);
    return () => {
      window.removeEventListener("pointerdown", down, { capture: true });
      window.removeEventListener("pointermove", move, { capture: true });
      window.removeEventListener("pointerup", up, { capture: true });
      window.removeEventListener("keydown", key, { capture: true });
      window.removeEventListener("wheel", wheel, { capture: true });
      shelfCarry.reset();
    };
  }, []);

  const was = useRef(folding);
  useLayoutEffect(() => {
    if (was.current === folding) return;
    was.current = folding;
    shelfCarry.fold(folding);
  }, [folding]);
}
