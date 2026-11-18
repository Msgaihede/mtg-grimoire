/**
 * One toast per press for the card menu's filing writes — however many cards the press filed.
 *
 * **A press is one write now, so it is one answer.** `Add N cards to → Collection / Wishlist` over
 * a picked set used to call a dep once per card, and this module folded those N writes back into
 * one toast with a microtask batcher keyed by destination (the owner's rule, 2026-10-12: one
 * action, one toast). The N writes were the real cost — N transactions, N activity rows and N
 * refresh rounds, which froze the window for seconds over a few hundred cards — so the menu hands
 * the whole set to one batch dep instead (`addManyToCollection`, `addManyToWishlist`), whose single
 * answer reports the press: {@link reportBulkFiling}. A single card's write — a one-card press, the
 * card modal's buttons, `Move to` on one row — answers through {@link reportFiling}.
 *
 * **Both say it through {@link sayFiling}**, so a set and one card read the same three ways: all
 * landed, some landed (`Added 47 of 50 cards to …` with the first refusal under it —
 * `deckAddReceipt`'s shape for the deck picker, reached from the other two cabinets), none landed.
 */
import { plural } from "@/lib/counts";
import { ipcError } from "@/lib/ipc";
import { notify } from "@/lib/notifications";

/** How one press's writes ended. */
export interface FilingOutcome {
  /** The cards the press named, in the order it named them — a name may be absent. */
  names: readonly (string | undefined)[];
  /** How many of them landed. */
  landed: number;
  /** The first refusal, or `undefined` when every write landed. */
  refusal: unknown;
}

/** The words a receipt is built from — `Added` / `add`, and where the cards went. */
export interface FilingWords {
  /** Past tense, capitalised: `Added`, `Moved`. */
  done: string;
  /** The bare verb for the refusal: `add`, `move`. */
  verb: string;
  /** `your collection`, `“Binder”` — already quoted where it is a name. */
  where: string;
}

/**
 * Say how one press went: a success when everything landed, a warning naming the count when some
 * did, an error when none did. The card is named when the press was about exactly one card whose
 * name is known; otherwise it is a count, because a list of fifty names is not a sentence.
 */
export function sayFiling(outcome: FilingOutcome, words: FilingWords): void {
  const { names, landed, refusal } = outcome;
  const total = names.length;
  const one = total === 1 && names[0] !== undefined ? `“${names[0]}”` : null;
  if (refusal === undefined) {
    notify.success(`${words.done} ${one ?? plural(landed, "card")} to ${words.where}`);
    return;
  }
  const body = ipcError(refusal);
  if (landed === 0) {
    notify.error(`Couldn't ${words.verb} ${one ?? plural(total, "card")} to ${words.where}`, {
      body,
    });
    return;
  }
  notify.warning(`${words.done} ${landed} of ${plural(total, "card")} to ${words.where}`, {
    body,
  });
}

/** One single write's answer, said — the card by name where the press knew it. */
export function reportFiling(
  name: string | undefined,
  work: Promise<unknown>,
  words: FilingWords,
): void {
  void work.then(
    () => sayFiling({ names: [name], landed: 1, refusal: undefined }, words),
    (error: unknown) => sayFiling({ names: [name], landed: 0, refusal: error ?? "refused" }, words),
  );
}

/**
 * A batch write's answer, said once for the whole press. `refused` is the backend's own list (by
 * index, in the single add's words), so **the first refusal is the first card refused in the
 * order the press named them**; a rejected call is a write that landed nothing and is the error
 * arm with the backend's sentence.
 */
export function reportBulkFiling(
  names: readonly (string | undefined)[],
  work: Promise<{ refused: readonly { reason: string }[] }>,
  words: FilingWords,
): void {
  void work.then(
    ({ refused }) =>
      sayFiling(
        { names, landed: names.length - refused.length, refusal: refused[0]?.reason },
        words,
      ),
    (error: unknown) => sayFiling({ names, landed: 0, refusal: error ?? "refused" }, words),
  );
}
