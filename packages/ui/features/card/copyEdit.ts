/**
 * The words and the one guard the card modal's **Edit** mode needs about a collection row —
 * issue #564, and the reason each is here rather than at its call site.
 *
 * Two surfaces write a copy's printing — the modal's own printings list and `AllPrintingsDialog`
 * opened from it — so the guard below is written once and both refuse in the same sentence.
 */
import { CONDITIONS, CONDITION_LABEL, type Condition } from "@/lib/conditions";
import { FINISH_LABEL, finishLabel, isFinish, parseFinishes, type Finish } from "@/lib/finish";
import type { CollectionRow } from "@/lib/ipc";

/** What a row filed at the root is called — `EditCopy`'s word for the same drawer. */
const ROOT_LABEL = "Collection";

/**
 * One copy as the `Edit` picker lists it: how many, what grade, what finish — and, as the
 * option's dim second fact, the drawer it is filed in.
 *
 * **The folder is the fact that tells two rows apart most often**, which is why it is there at
 * all: two Near Mint regular copies of one printing are one row unless they sit in two folders
 * (the folder is the eleventh term of the collection's grain), so a picker naming only grade and
 * finish would draw two identical lines.
 */
export function copyOption(row: CollectionRow): { label: string; hint: string } {
  const condition = (CONDITIONS as readonly string[]).includes(row.condition)
    ? CONDITION_LABEL[row.condition as Condition]
    : row.condition;
  return {
    label: `${row.quantity}× ${condition} · ${finishLabel(row.finish)}`,
    hint: row.folderName ?? ROOT_LABEL,
  };
}

/** The copy's finish as the `Finish` vocabulary, or `null` for a word this build cannot name. */
export function copyFinish(row: CollectionRow): Finish | null {
  return isFinish(row.finish) ? row.finish : null;
}

/**
 * Why a copy cannot move onto a printing, or `null` when it can.
 *
 * **The printing has to have been made in the copy's finish.** A foil copy moved onto a printing
 * Scryfall lists as nonfoil only would be a row describing cardboard that does not exist, and
 * nothing downstream would say so — the price would read as an em dash and the tile would draw a
 * sheen on a card that never had one. The reader's way through is the order the modal already
 * offers: set the copy as regular, then change its printing.
 *
 * **An unknown `finishes` column is not a refusal.** A printing whose finishes Scryfall has not
 * told us is one this app knows nothing about, and refusing it would make that absence a rule.
 */
export function finishRefusal(
  finish: Finish,
  printing: { setCode: string; collectorNumber: string; finishes: string | null },
): string | null {
  const offered = parseFinishes(printing.finishes);
  if (offered.length === 0 || offered.includes(finish)) return null;
  return `${printing.setCode.toUpperCase()} ${printing.collectorNumber} has no ${FINISH_LABEL[
    finish
  ].toLowerCase()} version — change this copy's finish first.`;
}
