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

/* ## Who these are for, and who they are not for
 *
 * Both constants above are gated on `data-kbd` — `src/index.css` redefines Tailwind's
 * `focus-visible` variant to require it, and `src/lib/keyboardModality.ts` is what sets it. So
 * neither draws anything for a reader who is using the mouse, and neither draws anything for a
 * keystroke that moved no focus. That is the *when*.
 *
 * The *what* is a separate question, and it has a separate answer: *some elements should carry
 * no focus outline at all, in any modality.*
 *
 * **A `tabIndex={-1}` container is a landing pad, not a control.** Eleven of them exist here —
 * the dialog shell's panel, the card pane, the deck editor's root, `AnchoredPopup`,
 * `DeckBracket`, `ValidationPanel`, `MoveToFolder`, `PickCopies`, `DeckTile`'s and `DecksPage`'s
 * delete confirmations, `CollectionPage`'s. Every one exists so that focus can be *put*
 * somewhere when a layer opens or a menu closes, instead of being dropped on `<body>` where the
 * next Tab starts the tab order over. A reader can never Tab to one and can never arrow onto
 * one; nothing inside them answers to the container's own keypresses. So an outline around one
 * communicates no state — there is no "you are here" to draw, because nobody navigated here —
 * and what it looks like instead is the whole modal, or the whole editor, ringed in gold.
 * Removed 2026-09-03.
 *
 * **The line is drawn at "can the caret move *from* here", not at `tabIndex`.** A deck pile's
 * section (`deckGroupProps`) and a printings row are `tabIndex={-1}` too and they keep their
 * marks, because the caret landing on one is a fact the *next* keypress depends on. A menu row,
 * a table row, a card in a wall and a grid tile are all likewise roving targets and all keep
 * theirs; stripping those would be the WCAG 2.4.7 failure {@link FOCUS_INSET} warns about, one
 * step removed. If a container ever grows a keyboard interaction of its own, it stops being a
 * landing pad and this note stops applying to it.
 */

