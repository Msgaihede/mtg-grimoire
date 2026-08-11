/**
 * A deck card drawn as a **control**: how its focus is shown, and what it is called.
 *
 * Three surfaces make a card into a button — the stack, the text columns and the grid — and
 * each had grown its own copy of both. That is the duplication `CardMarks.tsx` was created to
 * end, and the accessible name is worse than a duplicated class list: it is a *contract* that
 * `views/views.test.tsx` asserts across all three, so three copies is three chances for one
 * surface to quietly stop saying what a card is.
 */
import type { DeckCard } from "@/lib/ipc";

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
 * The offset is negative for exactly `VirtualTable`'s reason, one floor down: an outline
 * standing 2px *off* a control that fills an `overflow-hidden` box is painted entirely in the
 * clipped region and is never seen at all. A card in the stack and a tile in the grid are both
 * that shape — the button is the whole card, and the card clips its own corners — so a
 * positive offset there is not a smaller ring, it is **no focus indicator**, which is a WCAG
 * 2.4.7 failure and invisible to anyone testing with a mouse.
 *
 * `deck cards keep their focus outline inside the box that clips them` sweeps for it.
 */
export const FOCUS_INSET =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/**
 * What a deck card's control is called.
 *
 * It begins with the card's **name**, which is the visible label — WCAG 2.5.3 asks that of any
 * control whose label is drawn on it — and then says, in the order a reader would want them,
 * everything the surface shows as a mark rather than as a word.
 *
 * **This is the whole of what a keyboard reader gets, and that is why it is one function.** An
 * `aria-label` *replaces* an element's content for naming purposes, so every `sr-only` span
 * inside one of these buttons is announced to nobody: the tag chip, the `GC` badge, the
 * `RULE BREAK` mark and the red shortage figure are all decoration once the button is named,
 * and each of them is a fact somebody needs. They are said here instead, once, so no surface
 * can be the one that forgets.
 *
 * The shortage is included even on the two surfaces that have no room to draw it. A name is
 * what a reader gets *instead of* the visual scan, not a transcript of it — one name carrying
 * every fact beats three that each omit a different one.
 */
export function deckCardName(card: DeckCard, ruleBreakText: string | null): string {
  // The allocator claims no copy for an inactive category, so every card in one reads 0 owned
  // by construction — announcing a shortage there would report one the reader does not have.
  const short = card.categoryActive && card.ownedQuantity < card.quantity;
  return [
    card.name,
    card.quantity > 1 ? `${card.quantity} copies` : null,
    short ? `you own ${card.ownedQuantity} of ${card.quantity}` : null,
    card.tagName,
    card.gameChanger === true ? "game changer" : null,
    ruleBreakText === null ? null : `rule break: ${ruleBreakText}`,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
}
