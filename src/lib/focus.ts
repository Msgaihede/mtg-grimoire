/**
 * The keyboard's focus mark, in the two shapes this app draws it in.
 *
 * It lived on `features/decks/cardControl.tsx` until 2026-08-16, so a dialog asking for a
 * deck's name, a table header and a stepper each pulled
 * `@atlaskit/pragmatic-drag-and-drop`, `./dnd` and `QuantityStepper` into their module graph
 * to learn how to draw an outline. `formFields.ts` already stated that rule about `CAPTION`
 * and `FIELD` without ever applying it to these two. Zero imports here, for that reason.
 *
 * This is deduplication and not unification: `FilterChips`' `FILTER_FOCUS` delegates to
 * {@link FOCUS} and keeps its own name, and its `outline-offset-[5px]` chip is a documented
 * variant rather than a copy.
 */

/**
 * Keyboard focus, in the shape the rest of the app uses: a gold outline standing off the
 * control's edge, never a ring — a ring means "state" everywhere else here.
 *
 * For a control with room around it. A control that **fills** a clipped box wants
 * {@link FOCUS_INSET} instead.
 */
export const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * The same outline, drawn **inside** the control's own edge.
 *
 * The offset is negative for `VirtualTable`'s reason: an outline standing 2px *off* a control
 * that fills an `overflow-hidden` box is painted entirely in the clipped region and is never
 * seen at all. A row stacked flush inside a scroller, a card in the deck's stack and a tile in
 * its grid are all that shape — the button is the whole card, and the card clips its own
 * corners — so a positive offset there is not a smaller ring, it is **no focus indicator**,
 * which is a WCAG 2.4.7 failure and invisible to anyone testing with a mouse.
 *
 * `deck cards keep their focus outline inside the box that clips them` sweeps for it.
 */
export const FOCUS_INSET =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";
