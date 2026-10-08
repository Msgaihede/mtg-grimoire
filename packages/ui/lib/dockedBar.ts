/**
 * The geometry and the shadow of a bar docked across the top of `AppShell`'s `main` — the deck
 * editor's header bar (issues #577 and #646) and the filter quick bar on the four card walls
 * (spec 2026-09-29).
 *
 * **Both bars draw from these numbers, and that is why they are a module of their own.** The
 * filter quick bar is the deck bar's box with different contents: the same panel reaching back
 * over the shell's padding, the same height, the same clearance under it for whatever sticks
 * beneath, the same shadow. Two copies of five numbers would be two bars that agree today and
 * drift the first time either moves — so they moved out of `DeckHeaderBar.tsx` rather than being
 * copied from it, and `components/DockedBar.tsx` holds the panel that spends them.
 */

/**
 * `AppShell`'s `main` padding — its `p-5` — which the docked bar reaches back across so that it
 * meets the scroller's own top and side edges (issue #646).
 *
 * The bar's box is the editor column's, and the column sits inside that padding, so a panel
 * drawn at the column's edges leaves 20px of deck showing down each side and above it. Reaching
 * out by exactly this much puts the panel on the scroller's padding box, which is where
 * `overflow` clips — so the panel ends at the scroller's edges and its shadow cannot bleed past
 * them. The same number comes back as the panel's inline padding, which puts the first and last
 * control over the column's own edges again, directly above the header controls they stand in
 * for. **Change it with `AppShell`'s `p-5` or not at all.**
 */
export const DOCKED_BAR_SHELL_PAD_PX = 20;

/** The bar's height: 36 of control, `py-2` above and below it, and the hairline under it. */
export const DOCKED_BAR_HEIGHT_PX = 53;

/** Room left under the bar before whatever sticks beneath it, so that reads as a neighbour. */
export const DOCKED_BAR_GAP_PX = 8;

/**
 * How far down the page the undocked bar reaches, in px, **measured from the scroller's content
 * edge** — what a surface that sticks to the top of the same scroller has to start below so it is
 * not drawn under the bar.
 *
 * A sticky inset is measured from the content edge, and the bar's top is
 * {@link DOCKED_BAR_SHELL_PAD_PX} *above* that edge, flush with the scroller's own top. So its foot
 * is `53 − 20 = 33` below the content edge, and {@link DOCKED_BAR_GAP_PX} under that is **41**. It
 * was 66 while the bar floated `top-2` inside the padding — 8 + 50 + 8 — which is the 28px of deck
 * that issue #646 reported showing above it. `DeckEditor` offsets the docked search panel and the
 * table view's sticky header by this, and adds the scroller's measured padding to it for
 * `scroll-padding-top`, which is measured from the top edge instead. Only while the bar is shown —
 * a clearance held open under a bar that is not drawn is a strip of desk nobody can use.
 *
 * **The filter quick bar spends the same 41** (spec 2026-09-29): it is the `top` of a docked
 * search column or the Tags rail while that bar is down, and the scroll padding
 * `useFilterQuickBar` puts on `main` for WCAG 2.4.11. A wall's own sticky shelf bar takes
 * {@link DOCKED_BAR_HEIGHT_PX} instead, because it pins flush under the bar rather than a
 * neighbour's gap below it.
 */
export const DOCKED_BAR_CLEARANCE_PX =
  DOCKED_BAR_HEIGHT_PX - DOCKED_BAR_SHELL_PAD_PX + DOCKED_BAR_GAP_PX;

/**
 * The docked bar's shadow, cast down over the deck only. The panel spans the scroller's padding
 * box, whose `overflow` clips everything outside it, so the sides and the top of any shadow are
 * cut off at the window's own edges and what is left is what falls on the cards: a tight contact
 * shadow for the edge and a deep soft one for the lift. Black at these alphas because the desk
 * under it is this app's dark felt and card art, and Tailwind's own `shadow-lg` (0.1) does not
 * read on either. Written out whole: an interpolated arbitrary value emits no rule.
 */
export const DOCKED_SHADOW =
  "shadow-[0_1px_2px_rgb(0_0_0/0.55),0_10px_24px_-4px_rgb(0_0_0/0.75),0_24px_48px_-12px_rgb(0_0_0/0.55)]";
