import type { FolderEdge } from "@/lib/folderDrag";
import { LAYER } from "@/lib/layers";
import { cn } from "@/lib/utils";

/**
 * How a test finds the line, and which end of the folder it found it on.
 *
 * It has no role, no name and no text — it is decoration for a gesture only a pointer can make,
 * and narrating it to a screen reader would announce a line to a reader who cannot be dragging
 * anything. An attribute is therefore the only handle it has, the shape `DropIndicator`'s
 * `DROP_LINE_ATTR`, `StackView`'s `STACK_ATTR` and `cardControl`'s `DECK_GROUP_ATTR` all use for
 * the same reason.
 *
 * **It carries the edge as its value where `DROP_LINE_ATTR` carries an empty string**, because
 * this line has two positions and that one has one. Which end the line is on *is* the fact under
 * test — a mark on the wrong side of a folder is a promise to file it in the wrong place — and it
 * is spelled nowhere else a test can reach: the side is a Tailwind class, and jsdom applies no
 * stylesheet, so a class assertion is a check on the source text rather than on the drawing.
 */
export const FOLDER_DROP_LINE_ATTR = "data-folder-drop-line";

/**
 * The line that says where a dragged folder is about to land: 2px of `--color-accent` along the
 * leading or trailing edge of the folder it will land beside.
 *
 * **This is an insertion point, and `DropIndicator.tsx`'s argument for not drawing one inverts
 * here.** That file marks a *target* rather than a position, and says why in full: `deck_cards`
 * has no order column, the backend answers a deck in category `sortOrder` then by name, and
 * `deck_add_card` folds a repeat into the row already there — so a line between two rows would
 * promise a position the data model cannot keep. Every clause of that is a fact about *decks*.
 * A folder row has `sortOrder` of its own (`lib/folderTree.ts`'s `FolderLike` requires it, and
 * all three cabinets answer it), so "between these two" is a position the cabinet can hold and
 * reopen. The line is honest here for exactly the reason it was dishonest there, and
 * `DropIndicator` keeps its target mark unchanged — the two are not in disagreement, they are
 * about two different data models.
 *
 * **The third landing has no line, on purpose.** `inside` is not a position between two folders,
 * it is a folder taking the drag, and the app already has one mark for that: `DROP_RING` in
 * `lib/dropMarks.ts`, which every folder-shaped target in the window wears. Drawing a second
 * vocabulary for it here would make one meaning wear two marks. So this component's answer to
 * `inside` — and to `null`, the pointer being nowhere this folder would take — is to render
 * nothing, and taking the whole {@link FolderEdge} rather than only its two positional words is
 * what keeps the three call sites from each writing the same ternary around it.
 *
 * **Hand-rolled**, for `DropIndicator`'s reason, which nothing about folders changes: the app's
 * palette owns this colour and the direction doc reserves it — gold is interactive emphasis, and
 * a drop target lighting up is exactly that — while `-react-drop-indicator` brings a dependency,
 * a portal and a runtime `<style>` element the shipped CSP (`style-src 'self'`) would refuse.
 *
 * **On the edge, inside the box, rather than centred over the gap between two folders.** Half a
 * line hanging outside the border box is half a line a scroller clips: the marks a drop target
 * draws *outside* itself are what `DROP_MARK_ROOM` exists to buy room for, and this one does not
 * need to spend it. The cost is that the gesture's two spellings meet rather than overlap — the
 * line for "after this folder" and the line for "before the next" are two different 2px bands —
 * which is invisible, since only one of them is ever drawn.
 *
 * No animation, deliberately: `DropIndicator`'s reasoning, that an affordance which fades in
 * during a drag is one still arriving when the reader has already let go. Nothing here moves, so
 * there is nothing for `prefers-reduced-motion` to switch off.
 *
 * `aria-hidden`, and `pointer-events-none` so it can never become the thing under the pointer: a
 * native drag hit-tests with `elementFromPoint`, and a decoration that answers it is a decoration
 * that decides where the folder goes.
 *
 * The folder it is drawn in must be `relative`; it is `absolute` against that box.
 */
export function FolderDropLine({
  edge,
  axis,
}: {
  /** Straight from `useFolderDropTarget`'s `edge` — `inside` and `null` draw nothing. */
  edge: FolderEdge | null;
  /** The axis the folders are laid out along: "vertical" for the sidebar tree, "horizontal" for
   *  a card grid. It decides whether `before` means the top edge or the leading side. */
  axis: "vertical" | "horizontal";
}) {
  if (edge !== "before" && edge !== "after") return null;
  const before = edge === "before";
  return (
    <span
      {...{ [FOLDER_DROP_LINE_ATTR]: edge }}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute bg-accent",
        LAYER.raised,
        axis === "vertical"
          ? cn("inset-x-0 h-0.5", before ? "top-0" : "bottom-0")
          : cn("inset-y-0 w-0.5", before ? "left-0" : "right-0"),
      )}
    />
  );
}
