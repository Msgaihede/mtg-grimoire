/**
 * One toast per press for the card menu's filing writes — however many cards the press filed.
 *
 * **Why this exists at all.** `buildCardMenu` turns a press on a picked set into one call of a dep
 * per card (`Add 4 cards to → Collection` calls `addToCollection` four times, synchronously, in
 * the row's `onSelect`), and the deps are the write's only observer — the menu has closed. A
 * receipt per call would be four toasts for one press, which is the owner's rule broken
 * (2026-10-12: one action, one toast) and, past `TOAST_CAP`, a column of toasts pushing each other
 * off the corner. So each call hands its write here under a key naming the press's destination,
 * and every call made **in the same tick** under the same key is one batch: the menu's loop runs
 * to the end before a microtask can, so a batch is exactly one press.
 *
 * **The receipt waits for every write in the batch** and then says once what landed, folding a
 * partial refusal into that one sentence — `deckAddReceipt`'s shape for the deck picker, reached
 * from the other two cabinets.
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

/**
 * A batcher: hand it each write of a press under a key, and it reports the whole press once.
 *
 * `words` is read off the **first** call of a batch — every call under one key names the same
 * destination, which is what the key is.
 */
export function filingBatcher(): (
  key: string,
  name: string | undefined,
  work: Promise<unknown>,
  words: FilingWords,
) => void {
  const open = new Map<
    string,
    { names: (string | undefined)[]; work: Promise<unknown>[]; words: FilingWords }
  >();
  return (key, name, work, words) => {
    let batch = open.get(key);
    if (batch === undefined) {
      const fresh = { names: [] as (string | undefined)[], work: [] as Promise<unknown>[], words };
      batch = fresh;
      open.set(key, fresh);
      // Closed at the end of the tick the press ran in — after the menu's loop, before any
      // answer can have come back.
      queueMicrotask(() => {
        open.delete(key);
        void Promise.allSettled(fresh.work).then((results) => {
          let refusal: unknown = undefined;
          let landed = 0;
          for (const result of results) {
            if (result.status === "fulfilled") landed += 1;
            else if (refusal === undefined) refusal = result.reason ?? "refused";
          }
          sayFiling({ names: fresh.names, landed, refusal }, fresh.words);
        });
      });
    }
    batch.names.push(name);
    batch.work.push(work);
  };
}
