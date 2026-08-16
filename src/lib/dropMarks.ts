/**
 * The two marks a drop target wears. Shared vocabulary, owned by no feature.
 *
 * These lived in `components/AppShell.tsx` until 2026-08-16, which made
 * `AppShell → cardMenu → FolderTree → AppShell` a real import cycle for the sake of two
 * strings. Nothing here imports anything, so nothing that wants a drop mark has to pull a
 * whole window in to get one.
 */

/**
 * What a target that can take the card you are holding looks like: 2px of gold around it,
 * standing for as long as the card is in the air.
 *
 * The app's existing vocabulary rather than a new one — gold is interactive emphasis
 * everywhere in this window, and the same ring is the keyboard's focus mark. Deliberate: a
 * drop target lighting up and a control being reachable are the same claim made to two
 * different hands. The category columns' `DropIndicator` line stays theirs; a line drawn on a nav
 * entry would promise an insertion point in a list that has none.
 *
 * Instant, with no rule of its own: a ring is a box shadow, and the entry's colour animation
 * does not cover one. That is the answer this wants anyway — an affordance that arrives
 * gradually during a drag is one still arriving when the reader has let go (`DropIndicator`'s
 * reasoning), and it is why the guard in `tokens.test.ts` has nothing to find here.
 */
export const DROP_RING = "ring-2 ring-accent";

/**
 * And which of the ringed set the card is actually over.
 *
 * A wash of the same gold rather than the sidebar's hover surface, for two reasons. `:hover`
 * does not update during a native drag — the pointer is holding something — so this has to be
 * drawn from the drop target's own `onDragEnter`; and the entry a card is dropped on is very
 * often the **active** one (the Decks entry, with its editor open, is where a panel tile goes),
 * whose surface is already `bg-bg` and whose label is gold. A second surface colour would have
 * been invisible there, and the `text-text` this used to carry took the gold label *off* the
 * active entry — emphasis subtracted at the moment it was wanted. One token, additive, and it
 * fights nothing: `tailwind-merge` replaces the surface and leaves every colour of type alone.
 */
export const DROP_OVER = "bg-accent/10";
