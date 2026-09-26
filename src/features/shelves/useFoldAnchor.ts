/**
 * **Keep the carried heading under the pointer while the wall folds around it** — spec §3.9's
 * other half. `useFoldOnFolderDrag` folds every shelf to its heading the moment a folder heading is
 * picked up, which shortens the wall above the heading by however many rows of cards it held; left
 * alone, the heading the reader is holding would jump up the screen out from under their hand, and
 * jump back down again on the drop. Task 3 answers *whether* to fold and says in words that keeping
 * the page anchored is the page's job; this is that job.
 *
 * **Which heading, and where the pointer is, are both read off the pointer rather than the drag.**
 * A capture-phase `pointerdown` on `window` records the heading the press landed in
 * (`SHELF_HEADING_ATTR`, whose value is the shelf id — the attribute's own doc names this use) and
 * `pointermove` keeps the pointer's `clientY`. A press anywhere else forgets the heading, so a card
 * drag never moves the page. Passive listeners: nothing here may change what the gesture does.
 *
 * **On every change of `folding`, in a layout effect** — the fold and the unfold alike, before the
 * browser paints the frame that moved the heading — the heading's centre is put back at the
 * pointer's `y` by scrolling its scroller by the difference. The scroller is `AppShell`'s `main`,
 * which is what scrolls a growing wall, with the document as the fallback. A heading the virtualiser
 * has not drawn is left alone: there is nothing to measure, and the drag carries on.
 *
 * **The table does not fold, so the page hands this `false` there** — `VirtualTable` keys its rows
 * by position, and folding under a carried heading would remount it and end the drag.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { SHELF_HEADING_ATTR } from "@/features/shelves/ShelfHeading";

export function useFoldAnchor(folding: boolean): void {
  const pointer = useRef<{ y: number; heading: string | null }>({ y: 0, heading: null });

  useEffect(() => {
    const down = (e: PointerEvent | MouseEvent) => {
      const heading =
        e.target instanceof Element ? e.target.closest(`[${SHELF_HEADING_ATTR}]`) : null;
      pointer.current = { y: e.clientY, heading: heading?.getAttribute(SHELF_HEADING_ATTR) ?? null };
    };
    const move = (e: PointerEvent | MouseEvent) => {
      pointer.current = { ...pointer.current, y: e.clientY };
    };
    window.addEventListener("pointerdown", down, { capture: true, passive: true });
    window.addEventListener("pointermove", move, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointerdown", down, { capture: true });
      window.removeEventListener("pointermove", move, { capture: true });
    };
  }, []);

  const was = useRef(folding);
  useLayoutEffect(() => {
    if (was.current === folding) return;
    was.current = folding;
    const { y, heading } = pointer.current;
    if (heading === null) return;
    // A shelf id — digits, or `-1` for a folder still being named — so it needs no escaping inside
    // the quoted attribute value.
    const element = document.querySelector<HTMLElement>(`[${SHELF_HEADING_ATTR}="${heading}"]`);
    if (element === null) return;
    const scroller = element.closest("main") ?? document.scrollingElement;
    if (!(scroller instanceof HTMLElement)) return;
    const box = element.getBoundingClientRect();
    scroller.scrollTop += box.top + box.height / 2 - y;
  }, [folding]);
}
