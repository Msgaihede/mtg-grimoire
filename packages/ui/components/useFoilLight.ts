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
  /** Where its light is now, to tell which idle card is furthest behind. */
  aim: { x: number; y: number };
}

/**
 * **At most this many cards the pointer is not on are relit a frame** — the farthest behind first,
 * the rest over the frames after, pointer moving or not. The owner's report on 2026-11-16: "a
 * whole deck of surge foils was really laggy", a hundred-odd cards. The deck's stacks are not
 * virtualised and put each card under nine others, so relighting one card repaints all ten; every
 * card relit on every move cost 57–66 ms a frame for 120 surge foils (headless Edge on the GPU).
 * Each idle card relit costs about 1.5 ms in the shipped window (a 120-foil deck swept by the
 * pointer, debug build, 2026-11-16): 7 ms a frame with the foils hidden, 12.4–12.9 at a budget of
 * three, 13.7–14.7 at four, 15.8–18.5 at six. Four keeps a 60 Hz frame. An idle card's light
 * moves a fifth of the card across the whole window, so a few frames' lag on one is not seen.
 */
export const FOIL_IDLE_BUDGET = 4;

/** Every foil drawn right now. One window-wide listener lights them all. */
const foils = new Set<Foil>();
/**
 * Where the pointer last was, in client pixels, and what it was over — `null` while it is
 * outside the window. The target says which card it is on: the one whose frame holds it.
 */
let pointer: { x: number; y: number; target: EventTarget | null } | null = null;
/** The reduced-motion query, asked live at each move (see {@link useFoilLight}). */
let reduce: MediaQueryList | null = null;
/** The frame a light pass is waiting for, or 0. */
let queued = 0;

function restLight(foil: Pick<Foil, "card" | "ripple">) {
  const aim = foilAim(null, foil.card);
  return { aim, vars: foilLight(aim, foil.card, foil.ripple ? "rest" : null) };
}

function put(foil: Foil, vars: Record<string, string>, aim: { x: number; y: number }): void {
  for (const [name, value] of Object.entries(vars)) {
    if (foil.written[name] === value) continue;
    foil.overlay.style.setProperty(name, value);
    foil.written[name] = value;
  }
  foil.aim = aim;
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

function schedule(): void {
  if (queued !== 0) return;
  queued = window.requestAnimationFrame(() => {
    queued = 0;
    light();
  });
}

/**
 * One light pass. **Every box is read before any light is written**, so a pass costs one layout
 * however many foils there are. The card the pointer is on is written at once; of the rest, those
 * whose light changed, at most {@link FOIL_IDLE_BUDGET}, furthest behind first, and another frame
 * is asked for while any are left.
 */
function light(): void {
  const at = pointer;
  if (at === null) return;
  const view = { width: window.innerWidth, height: window.innerHeight };
  const target = at.target instanceof Node ? at.target : null;
  const seen = [...foils].map((foil) => ({
    foil,
    box: foil.frame.getBoundingClientRect(),
    onCard: target !== null && foil.frame.contains(target),
  }));
  type Due = { foil: Foil; vars: Record<string, string>; aim: { x: number; y: number } };
  const now: Due[] = [];
  const idle: (Due & { behind: number })[] = [];
  for (const { foil, box, onCard } of seen) {
    if (!onScreen(box)) continue;
    const given = foilPointer(at, box, view, onCard);
    const aim = foilAim(given, foil.card);
    const ripple = foil.ripple ? (given.hover > 0 ? "live" : "rest") : null;
    const vars = foilLight(aim, foil.card, ripple);
    if (Object.entries(vars).every(([name, value]) => foil.written[name] === value)) continue;
    if (given.hover > 0) now.push({ foil, vars, aim });
    else {
      const behind = Math.max(Math.abs(aim.x - foil.aim.x), Math.abs(aim.y - foil.aim.y));
      idle.push({ foil, vars, aim, behind });
    }
  }
  idle.sort((a, b) => b.behind - a.behind);
  for (const due of [...now, ...idle.slice(0, FOIL_IDLE_BUDGET)]) put(due.foil, due.vars, due.aim);
  if (idle.length > FOIL_IDLE_BUDGET) schedule();
}

function rest(): void {
  pointer = null;
  if (queued !== 0) window.cancelAnimationFrame(queued);
  queued = 0;
  for (const foil of foils) {
    const { aim, vars } = restLight(foil);
    put(foil, vars, aim);
  }
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

/** The cards moved under a still pointer — a scroll, or the window resized. */
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
 * **Moves a foil's light as the pointer moves, anywhere in the window** — without following it.
 * Where the light sits is `foilAim`'s (`lib/foilEffect.ts`): every card drifts a little with the
 * pointer's place in the window, and the card the pointer is on moves across itself. The owner's
 * calls on the design canvas for issue #1689: following the pointer "ends up looking like a
 * torch", so "super reduced light motion" for every card and more for the hovered one, each card
 * at its own angle, and no smoothing in time.
 *
 * **One listener on the window for every foil on screen**, not one per card: a module-level set of
 * the foils drawn, a `pointermove` that asks for **one light pass a frame** (`light`), and a
 * captured `scroll` and a `resize` that ask for one when the cards move under a still pointer. The
 * card the pointer is on is the one whose frame holds the event's target — the topmost card under
 * it, which in the deck's stacks is one of nine whose boxes hold the pointer. A card mounted while
 * the pointer is in the window — a virtualised wall scrolling one in — is lit on the next frame.
 * The pointer leaving the window puts every light back to rest. The light is written straight
 * onto each overlay as the `--foil-*` properties `foilLight` names, only those that changed, with
 * no React state: a pointer crossing the window re-renders nothing.
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
    const { aim, vars } = restLight({ card, ripple });
    const foil: Foil = { overlay: target, frame, card, ripple, written: { ...vars }, aim };
    if (foils.size === 0) listen();
    foils.add(foil);
    if (pointer !== null && !reduce?.matches) schedule();
    return () => {
      foils.delete(foil);
      if (foils.size === 0) unlisten();
    };
  }, [overlay, effect, card]);
}
