import { LAYER } from "@/lib/layers";
import { cn } from "@/lib/utils";

/**
 * How a test finds the line.
 *
 * It has no role, no name and no text — it is decoration for a gesture only a pointer can
 * make, and narrating it to a screen reader would announce a line to a reader who cannot be
 * dragging anything. An attribute is therefore the only handle it has, in the same shape
 * `ZoneColumn`'s scroller already uses for the same reason.
 */
export const DROP_LINE_ATTR = "data-drop-line";

/**
 * The line that says where a dragged card is about to land: 2px of `--color-accent` across
 * the top edge of the category that will take it.
 *
 * **Why it is an edge of the column and not a gap between two rows.** The usual drop
 * indicator marks an insertion point, and `@atlaskit/pragmatic-drag-and-drop-hitbox` exists
 * to compute one. A deck list has no insertion point: `deck_cards` has no order column, the
 * backend answers a deck in category `sortOrder` then by name, and `deck_add_card` folds a
 * repeat into the row that is already there. A line drawn between two rows would promise a
 * position the data model cannot keep — so the indicator marks the *target*, which is the only
 * thing a drop here decides. That is also why the hitbox package is not installed (the plan's
 * third dependency): a closest edge nobody may act on is not worth an Apache-2.0 NOTICE line.
 *
 * **Why it is hand-rolled** rather than `-react-drop-indicator`: the app's palette owns this
 * colour and the direction doc reserves it — gold is interactive emphasis, and a drop target
 * lighting up is exactly that. Twelve lines against a dependency, a portal and a runtime
 * `<style>` the shipped CSP (`style-src 'self'`) would refuse.
 *
 * No transition, deliberately: the motion budget is 150ms on chip/nav/stepper state and
 * nothing else, and an affordance that fades in during a drag is an affordance that is still
 * arriving when the reader has already let go. Nothing here animates, so there is nothing for
 * `prefers-reduced-motion` to switch off.
 *
 * `aria-hidden`, and `pointer-events-none` so it can never become the thing under the
 * pointer: a native drag hit-tests with `elementFromPoint`, and a decoration that answers it
 * is a decoration that decides where the card goes.
 */
export function DropIndicator() {
  return (
    <span
      {...{ [DROP_LINE_ATTR]: "" }}
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-accent", LAYER.raised)}
    />
  );
}
