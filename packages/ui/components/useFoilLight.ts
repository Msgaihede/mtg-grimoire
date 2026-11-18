import { type RefObject, useEffect } from "react";
import { type FoilCard, type FoilEffect, foilAim, foilLight, foilPointer } from "@/lib/foilEffect";

/** One foil on screen: the overlay its light is written on, and the frame it is measured by. */
interface Foil {
  overlay: HTMLElement;
  frame: HTMLElement;
  card: FoilCard;
  ripple: boolean;
  /** What is on the overlay now, so a pass writes only what changed. */
  written: Record<string, string>;
}

/** Every foil drawn right now. One window-wide listener lights them all. */
const foils = new Set<Foil>();
/** The foils whose light is off its rest — the one under the pointer, and one just left. */
const lit = new Set<Foil>();
/**
 * Where the pointer last was, in client pixels, and what it was over — `null` while it is
 * outside the window. The target says which card it is on: the one whose frame holds it.
 */
let pointer: { x: number; y: number; target: EventTarget | null } | null = null;
/** The reduced-motion query, asked live at each move (see {@link useFoilLight}). */
let reduce: MediaQueryList | null = null;
/** The frame a light pass is waiting for, or 0. */
let queued = 0;

function restLight(foil: Pick<Foil, "card" | "ripple">): Record<string, string> {
  return foilLight(foilAim(null, foil.card), foil.card, foil.ripple);
}

function put(foil: Foil, vars: Record<string, string>): void {
  for (const [name, value] of Object.entries(vars)) {
    if (foil.written[name] === value) continue;
    foil.overlay.style.setProperty(name, value);
    foil.written[name] = value;
  }
}

function schedule(): void {
  if (queued !== 0) return;
  queued = window.requestAnimationFrame(() => {
    queued = 0;
    light();
  });
}

/**
 * One light pass: the card the pointer is on is lit from where the pointer is on it, and a card
 * it has left goes back to rest. **No other card is touched** — not measured, not written — so a
 * pass costs one card's box and at most two cards' repaint however many foils are on screen.
 */
function light(): void {
  const at = pointer;
  if (at === null) return;
  const target = at.target instanceof Node ? at.target : null;
  const under = target === null ? [] : [...foils].filter((foil) => foil.frame.contains(target));
  // Every box read before any light is written.
  const measured = under.map((foil) => ({ foil, box: foil.frame.getBoundingClientRect() }));
  for (const foil of lit) {
    if (under.includes(foil)) continue;
    put(foil, restLight(foil));
    lit.delete(foil);
  }
  for (const { foil, box } of measured) {
    put(foil, foilLight(foilAim(foilPointer(at, box, true), foil.card), foil.card, foil.ripple));
    lit.add(foil);
  }
}

function rest(): void {
  pointer = null;
  if (queued !== 0) window.cancelAnimationFrame(queued);
  queued = 0;
  for (const foil of lit) put(foil, restLight(foil));
  lit.clear();
}

function onMove(event: PointerEvent): void {
  // A finger has no hover: a light that jumped to wherever a scroll began would be noise.
  if (event.pointerType === "touch") return;
  if (reduce?.matches) {
    if (pointer !== null) rest();
    return;
  }
  pointer = { x: event.clientX, y: event.clientY, target: event.target };
  schedule();
}

/** The card moved under a still pointer — a scroll, or the window resized. */
function onShift(): void {
  if (pointer !== null && !reduce?.matches) schedule();
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
  if (queued !== 0) window.cancelAnimationFrame(queued);
  queued = 0;
  pointer = null;
}

/**
 * **Moves the light of the card the pointer is on, and only that card's.** Every other foil keeps
 * its resting light — the owner's call on 2026-11-18, from readers' feedback; every card had
 * drifted a little as the pointer crossed the window. Where the light sits is `foilAim`'s
 * (`lib/foilEffect.ts`): across most of the card, mirrored, blended in from its rest over the card's
 * outer edge, and never smoothed in time. Each card rests at its own angle, so a wall of foils is
 * still not one sheen repeated.
 *
 * **One listener on the window for every foil**, not one per card: a module-level set of the foils
 * drawn, a `pointermove` that asks for **one light pass a frame** (`light`), and a captured
 * `scroll` and a `resize` that ask for one when the card moves under a still pointer. The card the
 * pointer is on is the one whose frame holds the event's target — the topmost card under it, which
 * in the deck's stacks is one of nine whose boxes hold the pointer. The pointer leaving the window
 * puts the lit card back to rest. The light is written straight onto the overlay as the `--foil-*`
 * properties `foilLight` names, only those that changed, with no React state: a pointer crossing
 * the window re-renders nothing.
 *
 * A pass touches at most two cards, which is what keeps a deck of a hundred foils smooth (the
 * owner's report on 2026-11-16, "a whole deck of surge foils was really laggy"); each foil card is
 * also its own layer (`index.css`), so relighting one does not repaint the nine it overlaps.
 *
 * The overlay is measured by its **parent** — the frame the card is drawn in, `CardArt`'s span,
 * `CardModalArt`'s art box or the deck's card face, whichever drew it.
 *
 * **It is the light that moves and never the card** — no tilt, the owner's call.
 *
 * Two readers get the resting light only:
 * - **A finger.** A touch has no hover; a phone's wall rests like a still photograph of each foil.
 * - **A reader who asked the OS for less motion** (WCAG 2.3.3). Read through a live
 *   `MediaQueryList` at each move rather than `useReducedMotion()`, which reads the query once and
 *   never notices a change under a running app (`App.tsx` has the story).
 *
 * `effect` is `null` for a card with no foil drawing, which registers nothing at all. The overlay
 * must already wear the resting light for `effect` and `card` (`FoilOverlay`'s style does).
 */
export function useFoilLight(
  overlay: RefObject<HTMLElement | null>,
  effect: FoilEffect | null,
  card: FoilCard,
): void {
  useEffect(() => {
    const target = overlay.current;
    const frame = target?.parentElement;
    if (effect === null || !target || !frame) return;
    const ripple = effect === "ripple";
    const foil: Foil = {
      overlay: target,
      frame,
      card,
      ripple,
      written: restLight({ card, ripple }),
    };
    if (foils.size === 0) listen();
    foils.add(foil);
    // Mounted under a pointer already in the window (a wall scrolling it in): light it if it is
    // the card the pointer is on.
    if (pointer !== null && !reduce?.matches) schedule();
    return () => {
      foils.delete(foil);
      lit.delete(foil);
      if (foils.size === 0) unlisten();
    };
  }, [overlay, effect, card]);
}
