import { type RefObject, useEffect } from "react";
import { FOIL_REST, foilLight, foilLightFrom } from "@/lib/foilEffect";

/** One foil on screen: the overlay its light is written on, and the frame it is measured by. */
interface Foil {
  overlay: HTMLElement;
  frame: HTMLElement;
}

/** Every foil drawn right now. One window-wide listener lights them all. */
const foils = new Set<Foil>();
/** Where the pointer last was, in client pixels — `null` while it is outside the window. */
let pointer: { x: number; y: number } | null = null;
/** The reduced-motion query, asked live at each move (see {@link useFoilLight}). */
let reduce: MediaQueryList | null = null;

function put(foil: Foil, vars: Record<string, string>): void {
  for (const [name, value] of Object.entries(vars)) foil.overlay.style.setProperty(name, value);
}

/** Whether a box is on screen at all — a light written on a card out of view is wasted work. */
function onScreen(box: DOMRect): boolean {
  return (
    box.width > 0 &&
    box.height > 0 &&
    box.bottom > 0 &&
    box.right > 0 &&
    box.top < window.innerHeight &&
    box.left < window.innerWidth
  );
}

/**
 * Lights `which` from the pointer. **Every box is read before any light is written**, so a move
 * costs one layout however many foils are on screen, rather than one forced layout per card.
 */
function light(which: Iterable<Foil>): void {
  const at = pointer;
  if (at === null) return;
  const view = { width: window.innerWidth, height: window.innerHeight };
  const boxes = [...which].map((foil) => [foil, foil.frame.getBoundingClientRect()] as const);
  for (const [foil, box] of boxes) {
    if (onScreen(box)) put(foil, foilLightFrom(at, box, view));
  }
}

function rest(): void {
  pointer = null;
  for (const foil of foils) put(foil, foilLight(FOIL_REST.x, FOIL_REST.y));
}

function onMove(event: PointerEvent): void {
  // A finger has no hover: a light that jumped to wherever a scroll began would be noise.
  if (event.pointerType === "touch") return;
  if (reduce?.matches) {
    if (pointer !== null) rest();
    return;
  }
  pointer = { x: event.clientX, y: event.clientY };
  light(foils);
}

/** The cards moved under a still pointer — a scroll, or the window resized. */
function onShift(): void {
  if (pointer !== null && !reduce?.matches) light(foils);
}

/** `relatedTarget` is `null` exactly when the pointer has left the window altogether. */
function onOut(event: PointerEvent): void {
  if (event.relatedTarget === null) rest();
}

function listen(): void {
  reduce =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
  window.addEventListener("pointermove", onMove, { passive: true });
  window.addEventListener("pointerout", onOut, { passive: true });
  // Capture, because a wall scrolls its own box and a scroll does not bubble to the window.
  window.addEventListener("scroll", onShift, { passive: true, capture: true });
  window.addEventListener("resize", onShift, { passive: true });
}

function unlisten(): void {
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerout", onOut);
  window.removeEventListener("scroll", onShift, { capture: true });
  window.removeEventListener("resize", onShift);
  pointer = null;
}

/**
 * **Moves a foil's light with the pointer, wherever it is in the window** — the owner's call on
 * 2026-11-15 ("the foils should react to the cursor moving anywhere in the window, not just when
 * hovering the card"). Where on the card the light sits is `foilLightFrom`'s: the pointer's offset
 * from the card's centre, eased across the window, so a card far from the pointer still turns its
 * light toward it.
 *
 * **One listener on the window for every foil on screen**, not one per card: a module-level set of
 * the foils drawn, a `pointermove` that lights them all (each box read before any light is written)
 * and a captured `scroll` and a `resize` that relight them when the cards move under a still
 * pointer. A card mounted while the pointer is in the window — a virtualised wall scrolling one in
 * — is lit at once. The pointer leaving the window puts every light back to rest. The light is
 * written straight onto each overlay as the `--foil-*` properties `foilLight` names, with no React
 * state: a pointer crossing the window re-renders nothing.
 *
 * The overlay is measured by its **parent** — the frame the card is drawn in, `CardArt`'s span,
 * `CardModalArt`'s art box or the deck's card face, whichever drew it.
 *
 * **It is the light that moves and never the card** — no tilt, the owner's call ("no tilt, but
 * keep the motion follows cursor").
 *
 * Two readers get the resting light only:
 * - **A finger.** A touch has no hover; a phone's wall rests like a still photograph of each foil.
 * - **A reader who asked the OS for less motion** (WCAG 2.3.3). Read through a live
 *   `MediaQueryList` at each move rather than `useReducedMotion()`, which reads the query once and
 *   never notices a change under a running app (`App.tsx` has the story).
 *
 * `active` is false for a card with no foil drawing, which registers nothing at all.
 */
export function useFoilLight(overlay: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const target = overlay.current;
    const frame = target?.parentElement;
    if (!active || !target || !frame) return;
    const foil: Foil = { overlay: target, frame };
    if (foils.size === 0) listen();
    foils.add(foil);
    if (pointer !== null && !reduce?.matches) light([foil]);
    return () => {
      foils.delete(foil);
      if (foils.size === 0) unlisten();
    };
  }, [overlay, active]);
}
