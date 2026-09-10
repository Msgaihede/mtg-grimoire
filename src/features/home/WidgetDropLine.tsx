import { LAYER } from "@/lib/layers";
import { cn } from "@/lib/utils";
import type { WidgetEdge } from "./homeDrag";

/**
 * How a test finds the line, and which side of the widget it found it on.
 *
 * It has no role, no name and no text — it is decoration for a gesture only a pointer can make,
 * and narrating it to a screen reader would announce a line to a reader who cannot be dragging
 * anything. An attribute is therefore the only handle it has, the shape `FolderDropLine`'s
 * `FOLDER_DROP_LINE_ATTR`, `DropIndicator`'s `DROP_LINE_ATTR` and `StackView`'s `STACK_ATTR` all
 * use for the same reason.
 *
 * **It carries the edge as its value**, because the line has two positions and which side it is
 * on *is* the fact under test — a mark on the wrong side of a widget is a promise to file it in
 * the wrong place, and it is spelled nowhere else a test can reach: the side is a Tailwind class,
 * and jsdom applies no stylesheet, so a class assertion is a check on the source text rather than
 * on the drawing.
 */
export const WIDGET_DROP_LINE_ATTR = "data-widget-drop-line";

/**
 * The line that says where a dragged widget is about to land: 2px of `--color-accent` along the
 * leading or trailing side of the card it will land beside.
 *
 * **An insertion point is honest here for `FolderDropLine`'s reason.** `DropIndicator.tsx` refuses
 * to draw one over a deck's cards and says why in full — `deck_cards` has no order column, so a
 * line between two rows would promise a position the data model cannot keep. A home layout is an
 * ordered list of widgets and nothing else, so "between these two" is the only position there is.
 *
 * **One axis, and no third landing.** `FolderDropLine` takes an `axis` because folders are drawn
 * as a vertical tree and as a card wall; widgets are only ever the wrapping flex row this page
 * lays out, so `before` is always the leading side. And there is no `inside` to render nothing
 * for, because a widget cannot contain a widget — the only argument that draws nothing is `null`,
 * which is `useWidgetDropTarget`'s answer for a pointer this card would not take a drop from.
 * Taking the whole `WidgetEdge | null` rather than only its two words is what keeps the call site
 * from writing that ternary itself.
 *
 * **Hand-rolled**, for `DropIndicator`'s reason, which nothing about widgets changes: the app's
 * palette owns this colour and the direction doc reserves it — gold is interactive emphasis, and
 * a drop target lighting up is exactly that — while a drop-indicator package brings a dependency,
 * a portal and a runtime `<style>` element the shipped CSP (`style-src 'self'`) would refuse.
 *
 * **On the edge, inside the box, rather than centred over the gap between two cards.** Half a
 * line hanging outside the border box is half a line a scroller clips, which is what
 * `DROP_MARK_ROOM` exists to buy room for and what this mark does not need to spend. The cost is
 * that the gesture's two spellings meet rather than overlap — the line for "after this widget"
 * and the line for "before the next" are two different 2px bands — which is invisible, since only
 * one of them is ever drawn.
 *
 * No animation, deliberately: an affordance that fades in during a drag is one still arriving
 * when the reader has already let go. Nothing here moves, so there is nothing for
 * `prefers-reduced-motion` to switch off.
 *
 * `aria-hidden`, and inert to the pointer so it can never become the thing under it: a decoration
 * that answers a hit-test is a decoration that decides where the widget goes.
 *
 * The card it is drawn in must be `relative`; it is `absolute` against that box.
 */
export function WidgetDropLine({ edge }: { edge: WidgetEdge | null }) {
  if (edge !== "before" && edge !== "after") return null;
  return (
    <span
      {...{ [WIDGET_DROP_LINE_ATTR]: edge }}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-y-0 w-0.5 bg-accent",
        LAYER.raised,
        edge === "before" ? "left-0" : "right-0",
      )}
    />
  );
}
