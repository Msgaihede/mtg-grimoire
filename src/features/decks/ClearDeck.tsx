/**
 * Empty a whole list, and name the list in the sentence that says so.
 *
 * The confirmation at the foot of Deck settings, and the second of this folder's two clears. A
 * reader who has decided a deck was a false start could until now empty it only a pile at a time,
 * or delete the deck and lose its name, its notes, its history and its place in the cabinet — so
 * what this question is about is a deck's **contents** rather than the deck.
 *
 * ## Why it is not `ClearCategory` with a wider argument
 *
 * That one empties **one pile of one list**; this one empties **every pile of one list**. That is
 * the whole of the difference in what is destroyed, and the half worth stating out loud is the
 * half they share: **neither of them ever reaches the other list**. So the sentences are
 * deliberately the same grammar with one word moved — the cards "leave the actual list" there and
 * "leave the deck" here — because a reader meeting the second question has already read the
 * first, and a confirmation that reworded itself for a wider scope would read as a different kind
 * of act. What says which scope is *where the press was*: a heading's menu asks about that
 * heading's pile, Deck settings asks about the deck.
 *
 * **The piles stay**, which is the sentence's second clause and the reason this is not Delete deck
 * under a softer name. What the reader keeps is the arrangement they built — every category, its
 * name, its order and its switch — and what goes is the cardboard filed into it.
 *
 * ## The two numbers, and which of them the button quotes
 *
 * `cardCount` is the list **on screen**, the one being emptied, and `otherCount` is the list being
 * **left alone**. Getting the two the wrong way round understates a destructive press, which is
 * the one direction a confirmation must never be wrong in: the button would offer to remove three
 * cards and take away twelve, while the reassurance promised safety to the very list it was about
 * to empty. `ClearCategory`'s doc argues the same rule from the other side of it, where the pair
 * is `cardCount` against `cardCountAllVariants` less `cardCount`. Here the host holds both totals
 * and hands them over already subtracted, so nothing in this file can *derive* the second number
 * backwards — it can only be **given** it backwards, which is what makes the test that swaps them
 * the one test in this suite that cannot be dropped.
 *
 * A deck with theory switched off has one list, so the reassurance is drawn only where there is
 * something in the other one to be reassured about — `> 0`, exactly as it is one file over,
 * because a one-list deck would otherwise read a sentence about a list it has not got.
 *
 * ## Where the cards go, which is not "nowhere"
 *
 * Since schema v25 an Actual row is backed by a collection row sitting in that deck's group, so
 * emptying the actual list files every copy the reader owns into `Recently removed` — the cardboard
 * is still theirs, and a confirmation saying only that this cannot be undone would be the
 * destructive half of a sentence whose other half is reassuring. A **Theory** list is a plan and
 * holds no copies, so it says so instead of promising a folder nothing will arrive in. The two are
 * one ternary because they answer the same question and a reader must never see both.
 */
import { type JSX } from "react";
import { plural, verb } from "@/lib/counts";
import type { DeckVariant } from "@/lib/ipc";
import { listName } from "./listNames";
import { CONFIRM_CANCEL, CONFIRM_DESTRUCTIVE, useConfirmFocus } from "./metaRows";

export function ClearDeck({
  variant,
  cardCount,
  otherCount,
  pending,
  onCancel,
  onCleared,
}: {
  /** Which list is being emptied. Named in the sentence, because "the deck" over a deck with
   *  two lists is the ambiguity this confirmation exists to close. */
  variant: DeckVariant;
  /** Copies in the list being emptied — the number the destructive button quotes. */
  cardCount: number;
  /** Copies in the list that is NOT being touched. Drawn only when > 0. */
  otherCount: number;
  /** The write is the host's, so whether it is in flight is too. */
  pending: boolean;
  onCancel: () => void;
  /** Run the write. The host closes on success; a refusal leaves this open with its sentence. */
  onCleared: () => void;
}): JSX.Element {
  // The caret moves into the question and not onto a button in it: the reader has not decided
  // yet, a stray Enter must not decide for them, and here the default answer would be the
  // destructive one over a whole list. The mechanism is the hook's; this is why this site wants
  // it. The name is the question without its mark, so it says which list without asking twice.
  const confirm = useConfirmFocus(`Clear the ${listName(variant)}`);

  return (
    <div {...confirm}>
      <p className="text-xs">Clear the {listName(variant)}?</p>

      {/* The sentence carries the outcome, not the button — the rule both of this folder's other
          destructive questions follow, and the reason holds here too: this is the line a reader's
          eye is on while they decide. */}
      <p className="mt-1.5 text-[0.6875rem] leading-relaxed text-destructive">
        The {plural(cardCount, "card")} in it {verb(cardCount, "leaves", "leave")} the deck{" "}
        and the piles stay.{" "}
        {variant === "live"
          ? "Any copies you own go back to Recently removed."
          : "A theory list holds no copies, so nothing else moves."}
      </p>
      {otherCount > 0 && (
        <p className="mt-1 text-[0.6875rem] leading-relaxed text-dim">
          The {plural(otherCount, "card")} in the other list {verb(otherCount, "is", "are")}{" "}
          untouched.
        </p>
      )}

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={onCleared}
          className={CONFIRM_DESTRUCTIVE}
        >
          Remove {plural(cardCount, "card")}
        </button>
        <button type="button" onClick={onCancel} className={CONFIRM_CANCEL}>
          Keep them
        </button>
      </div>
    </div>
  );
}
