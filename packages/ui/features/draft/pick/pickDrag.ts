/**
 * A card carried from the pack to the pool — the payload and its reader (issue #1434).
 *
 * **`features/playtesting/table/tableDrag.ts`'s arrangement, for its reasons**: the window's one
 * dnd-kit manager (`lib/dndManager.ts`), a payload marked so that no other drag in the window is
 * read as a pick, and read field by field because the library's store is untyped.
 *
 * **The payload is the whole pick, not the card under the pointer.** It is written as the drag
 * begins (`dndDraggable` reads `data` then), from the wall's choice with the carried card added —
 * so in a pick of two, dragging the second card picks it with the one already chosen. A carried
 * set short of the pick's size is refused by the pool, which then does not light up for it.
 */
const MARK = "mtg-grimoire/draft-pick";
const MARK_KEY = "dragSource";

/** What a pick drag carries: the instance ids of the cards it picks, oldest choice first. */
export interface PickDrag {
  ids: string[];
}

export function pickDragData(drag: PickDrag): Record<string, unknown> {
  return { [MARK_KEY]: MARK, ...drag };
}

export function readPickDrag(data: Record<string, unknown>): PickDrag | null {
  if (data[MARK_KEY] !== MARK) return null;
  const { ids } = data;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  if (!ids.every((id) => typeof id === "string")) return null;
  return { ids: ids as string[] };
}

/**
 * The places in the pack a drag of the card at `index` picks: that card alone in a pick of one;
 * in a pick of more, the choice with it added last — the oldest choice letting go past `need`,
 * as a click past `need` does.
 */
export function carriedPick(chosen: readonly number[], index: number, need: number): number[] {
  if (need === 1) return [index];
  return [...chosen.filter((i) => i !== index), index].slice(-need);
}
