/**
 * What each of a deck's two lists is called in a sentence.
 *
 * The reader's own words for the two tabs, lowercased into prose — `DeckEditor`'s tabs read
 * `Theory | Actual`, and a confirmation that said `"live"` in code font would be naming a
 * database value rather than the thing on screen. **`live` is exactly that value**: the stored
 * variant, the column, the IPC argument, all unchanged since the tab was reworded — so this
 * function is the join between the two, and answering `live list` here (issue #357) was the one
 * place the old word still reached a sentence a reader reads.
 *
 * **A module for three callers, which is the threshold `ClearDeck` wrote down and then met.**
 * It lived twice as a module-private copy — `ClearCategory`'s and `ClearDeck`'s, two sentences
 * one press apart, cheap to keep in step — and `auditText.ts`'s whole-list clear line was the
 * third. Three is where "cheap to keep in step" stops being true: the history dialog is not one
 * press from either confirmation, so a reword that reached the two questions and not the log
 * would be invisible until somebody read their own history back.
 *
 * **Not to be merged with `variantName` in `features/transfer/import/destinations/DeckPreview.tsx`**,
 * which answers `Actual` and `Theory`. That one names the *tabs a reader picks between* in the
 * import destination picker; this one names the *lists a sentence talks about*. They take the
 * same argument and answer different questions, and collapsing them would make one of the two
 * surfaces read wrongly to save three lines.
 */
import type { DeckVariant } from "@/lib/ipc";

/** `actual list` / `theory list` — **without an article**, so a caller writes the `the` its own
 *  sentence needs (`the actual list`, `from the theory list`). */
export function listName(variant: DeckVariant): string {
  return variant === "theory" ? "theory list" : "actual list";
}
