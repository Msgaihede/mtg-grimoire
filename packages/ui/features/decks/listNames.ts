/**
 * What the list a sentence is about is called — a deck's two, and since issue #401 the one a
 * **virtual** deck keeps instead.
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

/** What {@link listName} answers about, beyond the variant. */
export interface ListNameOptions {
  /**
   * Is this a **virtual** deck — the third kind, one the reader tracks without owning the
   * cardboard (issue #401)? `deckKind.ts`'s `deckKind(deck) === "virtual"`.
   *
   * Absent and `false` both mean a deck with the Theory/Actual vocabulary in play, which is
   * every deck that predates schema v40 and every regular one since, so no existing caller had
   * to change to keep saying what it said.
   */
  virtual?: boolean;
}

/**
 * `actual list` / `theory list` / `deck` — **without an article**, so a caller writes the `the`
 * its own sentence needs (`the actual list`, `from the theory list`, `Clear the deck`).
 *
 * **A virtual deck answers `deck`, and the argument is that it has nothing to be told apart
 * from.** The Theory/Actual vocabulary exists because a deck with a plan keeps two lists and a
 * sentence about emptying one has to say which; a virtual deck keeps exactly one, draws no
 * variant tabs, and its reader never meets the word *Actual* anywhere in the app. So
 * `Clear the actual list?` would name a list against a distinction that is not on their screen —
 * and would name it in the deck editor's own vocabulary for a *plan*, which is the one thing a
 * virtual deck is not.
 *
 * **`variant` is ignored under `{ virtual: true }` rather than asserted about.** A virtual deck's
 * rows are `live` by construction — the kind keeps no plan, and `deckKind.ts`'s table has no row
 * where both flags are set — so the only variant a caller can honestly pass here is `live`, and
 * checking that would be this module holding an opinion about a fact `deckKind.ts` already owns.
 * The reading that follows is the useful one: a caller that has the deck's kind in hand may pass
 * whichever variant it happens to be holding and still get the right sentence.
 *
 * **One word rather than `virtual list` or `card list`.** The sentences this feeds are
 * `Clear the ${listName(…)}?`, `The N cards in it leave the ${listName(…)}`, `Clear
 * ${listName(…)}…` and the history's `Emptied the ${listName(…)}` — and *the deck* is what a
 * reader with one list calls the thing those sentences are about. A coined noun would be this
 * app teaching a word for a distinction it has just taken away. It is also what
 * `auditText.ts`'s `clearedFrom` already falls back to for a variant it does not recognise, so
 * the two answers agree by wording rather than by accident.
 */
export function listName(variant: DeckVariant, opts?: ListNameOptions): string {
  if (opts?.virtual === true) return "deck";
  return variant === "theory" ? "theory list" : "actual list";
}
