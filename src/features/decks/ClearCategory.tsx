/**
 * Empty a pile, and say exactly how much of the deck that is.
 *
 * The confirmation behind a category heading's **Clear stack…**, and it exists for the reason
 * `DeleteCategory`'s does: `CategoryMenuDeps` carries no clear mutation at all, so the menu
 * structurally cannot reach the write without passing through here. A menu opens by accident.
 *
 * ## Why it is not `DeleteCategory` with different words
 *
 * That dialog asks a question with two answers — the cards move, or they go with the pile — and
 * its whole shape is the picker that chooses between them. A clear has one answer: the pile
 * stays and its cards go. There is nowhere for them to be moved *to* that would not be a
 * different gesture (`Move to`, on each card), so a picker here would offer a choice this
 * command cannot make. What is left is a count, a sentence and two buttons.
 *
 * ## The two numbers, and why the smaller one is the subject
 *
 * A delete cascades: `deck_cards.category_id` is `ON DELETE CASCADE`, so it reaches the live
 * list and the theory list alike, which is why that dialog quotes `cardCountAllVariants` and
 * says so out loud. **A clear is variant-scoped**, like every other card command — so this one
 * quotes `cardCount`, the list on screen, and mentions the other list precisely to say that it
 * is *not* being touched. Getting these two the wrong way round in either dialog understates or
 * overstates a destructive press, which is the one direction a confirmation must never be wrong
 * in.
 *
 * A theory-enabled deck is the only place the two differ, so the second sentence appears only
 * when there is something in the other list to reassure the reader about — `> 0` is exactly that
 * condition, and a deck with one list would otherwise read a sentence about a list it has not
 * got.
 */
import { plural } from "@/lib/counts";
import type { DeckCategory, DeckVariant } from "@/lib/ipc";
import { CONFIRM_CANCEL, CONFIRM_DESTRUCTIVE, useConfirmFocus } from "./metaRows";

/** What each list is called in a sentence. The reader's own words for the two tabs, lowercased
 *  into prose — `DeckEditor`'s tabs read `Theory | Live`. */
function listName(variant: DeckVariant): string {
  return variant === "theory" ? "theory list" : "live list";
}

export function ClearCategory({
  category,
  variant,
  pending,
  onCancel,
  onCleared,
}: {
  category: DeckCategory;
  /** Which list is being emptied — the one the editor is open on. Named in the sentence, because
   *  "its cards" over a deck with two lists is the ambiguity this dialog exists to close. */
  variant: DeckVariant;
  /** The write is the host's, so whether it is in flight is too. */
  pending: boolean;
  onCancel: () => void;
  /** Run the write. The host closes on success — a refusal leaves this open with its sentence
   *  drawn above, exactly as the delete confirmation does. */
  onCleared: () => void;
}) {
  // The caret moves into the question, as it does for every other layer in this app. **The
  // question's own box and not a button in it**: the reader has not decided yet, and a stray
  // Enter must not decide for them — `DeleteCategory` makes the same choice for the same reason,
  // and here the default answer would be the destructive one. The mechanism is the hook's; this
  // is why this site wants it.
  const confirm = useConfirmFocus(`Clear ${category.name}`);

  const here = category.cardCount;
  /** Copies in the list the reader is **not** looking at, and the whole of what the second
   *  sentence is for. A clear cannot reach them; saying so is what makes the first sentence
   *  safe to read quickly. */
  const elsewhere = category.cardCountAllVariants - here;

  return (
    <div {...confirm}>
      <p className="text-xs">Clear “{category.name}”?</p>

      {/* The sentence carries the outcome, not the button — `DeleteCategory`'s rule, and the
          reason holds here too: this is the line a reader's eye is on while they decide. */}
      <p className="mt-1.5 text-[0.6875rem] leading-relaxed text-destructive">
        The {plural(here, "card")} in it leave the {listName(variant)} and the pile stays. This
        cannot be undone.
      </p>
      {elsewhere > 0 && (
        <p className="mt-1 text-[0.6875rem] leading-relaxed text-dim">
          The {plural(elsewhere, "card")} filed here in the other list are untouched.
        </p>
      )}

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={onCleared}
          className={CONFIRM_DESTRUCTIVE}
        >
          Remove {plural(here, "card")}
        </button>
        <button type="button" onClick={onCancel} className={CONFIRM_CANCEL}>
          Keep them
        </button>
      </div>
    </div>
  );
}
