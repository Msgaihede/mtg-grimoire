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
 * ## One number, since a pile stopped being shared
 *
 * Until user schema v53 a pile was the deck's and held both lists' cards, so this dialog quoted
 * `cardCount` — the list on screen — and added a sentence saying the other list's copies filed
 * here were untouched. **A pile belongs to one list now** (issue #561): the Theory tab's piles
 * are the plan's and the Actual tab's are the deck's, so `cardCount` is every copy the pile
 * holds and there is no other list for a sentence to reassure the reader about. A clear and a
 * delete now quote the same number, which is the whole of why they stopped disagreeing.
 *
 * ## Where the cards go, which is not "nowhere"
 *
 * Since schema v25 a Live row is backed by a collection row sitting in that deck's group, so
 * clearing the pile files those copies into `Recently removed` — the reader still physically
 * owns them, and a confirmation saying only "this cannot be undone" was the destructive half of
 * a sentence whose other half is reassuring. A **Theory** pile is a plan and holds no copies, so
 * it says so instead rather than promising a folder nothing will arrive in. The three are one
 * ternary because they answer the same question and a reader must never see two of them.
 *
 * **The third is a virtual deck** (2026-09-08, issue #401) — one the reader tracks without owning
 * the cardboard. Its rows are `live` rows and it has no collection group at all, so the variant
 * alone sent it down the `Recently removed` arm and named a folder nothing would ever arrive in.
 * It is a {@link ClearCategory} prop rather than a fourth reading of the variant, for the reason
 * {@link ClearDeck}'s own doc gives at length: *which list* and *does this deck own cardboard*
 * stopped being the same question the moment a virtual deck's one list was a `live` one.
 */
import { plural, verb } from "@/lib/counts";
import type { DeckCategory, DeckVariant } from "@/lib/ipc";
import { listName } from "./listNames";
import { CONFIRM_CANCEL, CONFIRM_DESTRUCTIVE, useConfirmFocus } from "./metaRows";

export function ClearCategory({
  category,
  variant,
  virtual,
  pending,
  onCancel,
  onCleared,
}: {
  category: DeckCategory;
  /** Which list is being emptied — the one the editor is open on. Named in the sentence, because
   *  "its cards" over a deck with two lists is the ambiguity this dialog exists to close. */
  variant: DeckVariant;
  /**
   * Whether this deck keeps no cardboard — `DeckRow.virtualOnly`, schema v40. See
   * {@link ClearDeck}'s prop of the same name, where the argument is written in full: a virtual
   * deck's rows are `live` rows with no collection group behind them, so the variant alone
   * offered the `Recently removed` promise to a deck with no folder for anything to arrive in.
   *
   * Required for that file's reason — a flag whose wrong default is a **sentence** cannot have
   * one.
   */
  virtual: boolean;
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

  return (
    <div {...confirm}>
      <p className="text-xs">Clear “{category.name}”?</p>

      {/* The sentence carries the outcome, not the button — `DeleteCategory`'s rule, and the
          reason holds here too: this is the line a reader's eye is on while they decide. */}
      <p className="mt-1.5 text-[0.6875rem] leading-relaxed text-destructive">
        The {plural(here, "card")} in it {verb(here, "leaves", "leave")}{" "}
        the {listName(variant, { virtual })} and the pile stays.{" "}
        {/* The three answers {@link ClearDeck} argues, in the same order and for the same
            reason — a virtual deck has no group, so the middle arm is the one the variant
            could not reach. */}
        {virtual
          ? "This deck keeps no copies, so nothing else moves."
          : variant === "live"
            ? "Any copies you own go back to Recently removed."
            : "A theory list holds no copies, so nothing else moves."}
      </p>

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
