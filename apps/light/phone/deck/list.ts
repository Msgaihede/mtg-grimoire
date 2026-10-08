import type { DeckRow, DeckVariant } from "@grimoire/ui/lib/ipc";

/**
 * Which of a deck's two lists the phone face is showing — **one rule, read by the deck page and by
 * the card sheet over it**, because the sheet's `Add to deck` adds to the list on screen and the
 * two must never disagree about which that is.
 *
 * The reader's own press wins (`picked`, page state the face holds per deck, never a place in the
 * URL); before one, the list the deck remembers (`lastVariant`) where it keeps a plan — the
 * desktop editor's own restore — and Actual where it does not. **A deck that keeps no plan reads
 * Actual whatever was pressed**, the editor's clamp: a deck whose plan was switched off must not
 * leave a page reading a list no control here can get back to.
 *
 * `null` while there is neither a press nor a row to read the memory from.
 */
export function shownList(
  row: Pick<DeckRow, "theoryEnabled" | "lastVariant"> | null,
  picked: DeckVariant | null,
): DeckVariant | null {
  if (row !== null && !row.theoryEnabled) return "live";
  if (picked !== null) return picked;
  if (row === null) return null;
  return row.lastVariant;
}
