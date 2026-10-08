import type { JSX } from "react";
import { Dialog } from "@/components/Dialog";
import { plural } from "@/lib/counts";
import { CONFIRM_CANCEL, CONFIRM_DESTRUCTIVE } from "./metaRows";

// Its own file since 2026-10-03, out of `DeckNotesPanel.tsx`, so the light app's phone face asks
// the same question before it deletes a deck note: the band reaches the opener plugin through the
// note cards' links, which the phone face's fence refuses, and this dialog reaches nothing.

/**
 * Delete a note, and say what goes with it.
 *
 * **The cards are the clause worth spelling.** `deck_note_cards` cascades with the note, so the
 * attachments go — and a reader who has just spent a press naming four cards has every reason
 * to think the press might reach further than the note. It does not: the cards themselves are in
 * the deck and stay there, which is the half a confirmation can say before the press rather than
 * after it.
 *
 * **A `Dialog` rather than a box unfolding under the card**, which is what it was: the band is a
 * masonry now, and a question that grew inside one card would reflow every card after it at the
 * moment the reader was reading the question. It is also what retired `useDestructiveFocus` and
 * `useConfirmFocus`: a dialog takes the caret into its own panel as it opens, so there is no
 * landing pad here to focus and no `role="group"` to put one on. **Giving the caret back is not
 * retired with them and is the host's** — `DialogProps.onDismiss`' own doc says so — which is what
 * `DeckNotesPanel`'s `closePanel` does for all three of these, and what this component
 * deliberately knows nothing about.
 *
 * The button order is the band's old one: the destructive act first and the way out beside it,
 * which is `ClearCategory`'s arrangement and every other confirmation in this folder's.
 */
export function DeleteNoteDialog({
  open,
  title,
  cardCount,
  pending,
  onDelete,
  onClose,
}: {
  open: boolean;
  /** The note's name, or `null` while the dialog is shut — see the mount pattern at the call
   *  site, and the heading below for what `null` draws. */
  title: string | null;
  cardCount: number;
  pending: boolean;
  onDelete: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <Dialog
      open={open}
      // The question *is* the heading, so there is no second paragraph asking it. `Dialog` is
      // `aria-labelledby` this, which is what a test and a screen reader address the panel by.
      //
      // **`null` is the shut state**, and the branch is what makes the prop total: the host
      // evaluates it on every render, open or not. It is never drawn — see the mount pattern at
      // the call site — so the bare verb is what a value nobody sees should read as rather than a
      // heading anybody meets. `string | null` rather than a `""` fallback for the same reason
      // one rung down: an empty string is a *name*, and the one thing this template must never be
      // able to spell is `Delete “”?`.
      title={title === null ? "Delete note" : `Delete “${title}”?`}
      closeLabel="Close"
      // Narrower than the picker's `w-[47.5rem]` and the editor's `w-[40rem]`: the widest thing in
      // it is one sentence, and a question set across 760px reads as a page rather than a prompt.
      size="w-[26rem]"
      onDismiss={onClose}
      onClose={onClose}
    >
      <div className="px-5 py-4">
        <p className="text-xs leading-relaxed text-dim">
          {cardCount === 0
            ? "This note will be deleted."
            : `This note will be deleted and unlinked from ${plural(cardCount, "card")}. The cards stay in the deck.`}
        </p>
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
        <button type="button" disabled={pending} onClick={onDelete} className={CONFIRM_DESTRUCTIVE}>
          Delete note
        </button>
        <button type="button" onClick={onClose} className={CONFIRM_CANCEL}>
          Cancel
        </button>
      </footer>
    </Dialog>
  );
}
