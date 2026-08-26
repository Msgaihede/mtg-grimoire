import type { FolderEdge } from "./folderDrag";

/**
 * What a folder drop means as an **argument list**, and nothing else.
 *
 * The three reorder commands all take the same pair — the parent a level belongs to, and that
 * level's ids in their new order — and write `parent_id` from the first and `sort_order` from
 * each id's position in the second. Working out that pair from a drop is arithmetic over ids: it
 * has no folder rows in it, no cabinet, no React and no `ipc`. So it is here, pure, rather than
 * three times over in three pages that would each get the edge cases slightly differently.
 *
 * **Its own module rather than a third export of `folderDrag.ts`**, which owns the *gesture* —
 * the payload, the closest edge, the drop target. This is what a page does with the answer, and
 * the two have different reasons to change: a threshold moves there, a filing rule moves here.
 */

/**
 * The level a drop lands in, and that level's new order.
 *
 * `null` when the drop would change nothing, which the caller must treat as "write nothing"
 * rather than as an error: dropping a folder back exactly where it already sits is a gesture a
 * reader makes by accident every time they think better of one mid-drag, and a write for it
 * would bump `updated_at` and re-read three queries to arrive at the list already on screen.
 *
 * @param siblings ids of the destination parent's current children, in their current order.
 *   For an `inside` drop that is the **target's** children; for `before`/`after` it is the
 *   children of the target's own parent — which is the level the target sits in.
 * @param dragged the folder being moved. Removed from `siblings` first wherever it appears, so
 *   a move *within* one level is a re-insertion rather than a duplicate.
 * @param target the folder the pointer is over. Ignored for an `inside` drop, where the target
 *   is the destination itself and the dragged folder goes last.
 */
export function reorderedLevel({
  siblings,
  dragged,
  target,
  edge,
}: {
  siblings: readonly number[];
  dragged: number;
  target: number;
  edge: FolderEdge;
}): readonly number[] | null {
  // Without this a folder dropped into its own middle would be filed inside itself, which the
  // backend refuses in words (`FOLDER_CYCLE`) — but a refusal the reader sees as a red banner is
  // a worse answer than a gesture that quietly does nothing, and this is the gesture that
  // produces it most often: the pointer is *on* the folder being dragged for the first few
  // pixels of every drag.
  if (dragged === target) return null;

  const without = siblings.filter((id) => id !== dragged);

  // The dragged folder goes last, because `inside` says which *drawer* and nothing about where
  // in it — there is no second position in the gesture for the reader to have meant.
  if (edge === "inside") return [...without, dragged];

  const at = without.indexOf(target);
  // The target has left the level between the drag starting and the drop landing — another
  // surface deleted or re-filed it. Answered as "nothing to do" rather than appended at a
  // position nobody pointed at.
  if (at === -1) return null;

  const next = [
    ...without.slice(0, edge === "before" ? at : at + 1),
    dragged,
    ...without.slice(edge === "before" ? at : at + 1),
  ];
  // **A no-op is answered as one**, and it is not the same test as `dragged === target`: dropping
  // a folder on the near side of the neighbour it already precedes lands it exactly where it was.
  return sameOrder(next, siblings) ? null : next;
}

function sameOrder(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
