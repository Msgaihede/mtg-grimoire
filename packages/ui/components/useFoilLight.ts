import { type RefObject, useEffect } from "react";
import { FOIL_REST, foilLight } from "@/lib/foilEffect";

/**
 * **Moves a foil's light with the pointer** over the card it is drawn on, and puts it back to
 * rest when the pointer leaves.
 *
 * The overlay is `pointer-events-none` (it sits inside the tile's button, and a full-bleed span
 * there would swallow every click), so it listens on its **parent** — the frame the card is drawn
 * in, which is `CardArt`'s span, `CardModalArt`'s art box or the deck's card face, whichever drew
 * it. The light is written straight onto the overlay as the `--foil-*` properties `foilLight`
 * names, with no React state: a pointer crossing a wall of foils re-renders nothing.
 *
 * **It is the light that moves and never the card** — no tilt, the owner's call on 2026-11-15
 * ("no tilt, but keep the motion follows cursor").
 *
 * Two readers get the resting light only:
 * - **A finger.** A touch has no hover, and a light that jumped to wherever a scroll started would
 *   be noise; a phone's wall rests like a still photograph of each foil.
 * - **A reader who asked the OS for less motion** (WCAG 2.3.3). Read through a live
 *   `MediaQueryList` at each move rather than `useReducedMotion()`, which reads the query once and
 *   never notices a change under a running app (`App.tsx` has the story).
 *
 * `active` is false for a card with no foil drawing, which attaches nothing at all.
 */
export function useFoilLight(overlay: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const target = overlay.current;
    const frame = target?.parentElement;
    if (!active || !target || !frame) return;
    const reduce =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    const put = (vars: Record<string, string>) => {
      for (const [name, value] of Object.entries(vars)) target.style.setProperty(name, value);
    };
    const rest = () => put(foilLight(FOIL_REST.x, FOIL_REST.y, false));
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch" || reduce?.matches) return;
      const box = frame.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return;
      const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
      const y = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
      put(foilLight(x, y, true));
    };
    frame.addEventListener("pointermove", move);
    frame.addEventListener("pointerleave", rest);
    return () => {
      frame.removeEventListener("pointermove", move);
      frame.removeEventListener("pointerleave", rest);
    };
  }, [overlay, active]);
}
