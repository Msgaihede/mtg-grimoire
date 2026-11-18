import { plural } from "@/lib/counts";
import { ipcError, type DeckMissingOutcome, type DeckPullOutcome } from "@/lib/ipc";
import { notify } from "@/lib/notifications";
import type { DeckTokenView, TokenEntryRef } from "./deckTokens";

/*
 * **The deck builder's receipts** — the one spelling of "what a press did" for every deliberate
 * card write this feature makes outside the desk's own gestures (2026-10-12, the owner's rule:
 * collection, wishlist and deck edits always toast).
 *
 * The desk's high-frequency writes — the stepper, a drag, Quick Add — are **not** callers, and
 * that is the rule's own exemption rather than a gap: their change is drawn where the reader is
 * looking, and a toast per press over a deck being built would be a wall over the work. What
 * calls this is a press whose surface has closed (a context-menu row, a confirmation, a dialog)
 * or whose answer lands somewhere else (the collection, the wishlist, the other list).
 *
 * **One action is one toast** (the owner's second rule): a plural menu row or the Delete key over
 * a picked set is **one** `deck_apply` since issue #1164, answered with a refusal per card, and
 * {@link reportSettled} says it once — the count that landed, a warning naming the first refusal
 * when only some did, an error when none did. A single card's press is still its own write, and
 * {@link reportPresses} says that the same way. Never per card: `deckAddReceipt` in `cardMenu.tsx`
 * is the pattern.
 */

/** `“Sol Ring”` for one card, `3 cards` for more — the object of every receipt below. */
export function namedCards(names: readonly string[]): string {
  return names.length === 1 ? `“${names[0]}”` : plural(names.length, "card");
}

/** How one press is worded. Each takes the object phrase {@link namedCards} builds. */
export interface PressWording {
  /** The receipt — `(what) => \`Moved ${what} to “Ramp”\``. Past tense, no full stop. */
  done: (what: string) => string;
  /** The title when nothing landed — `(what) => \`Couldn't move ${what}\``. */
  failed: (what: string) => string;
}

/**
 * Wait out one press's writes and say what happened, **once**.
 *
 * `presses[i]` is the write for the card named `names[i]`. A press that answered no promise — a
 * story's bare spy, a write the surface does not hand back — is left out, and a press with none
 * at all says nothing: there is no outcome to report.
 *
 * - every write landed → `notify.success(done(…))`, naming the card or counting them;
 * - some did → `notify.warning(done("47 of 50 cards"))` with the first refusal as its body;
 * - none did → `notify.error(failed(…))` with the first refusal.
 */
export function reportPresses(
  presses: readonly unknown[],
  names: readonly string[],
  say: PressWording,
): void {
  const writes = presses.flatMap((press, i) =>
    press instanceof Promise ? [{ press, name: names[i] ?? "" }] : [],
  );
  if (writes.length === 0) return;
  reportSettled(
    Promise.allSettled(writes.map((w) => w.press)),
    writes.map((w) => w.name),
    say,
  );
}

/**
 * {@link reportPresses}' sentence over outcomes already gathered — `settled[i]` is the card named
 * `names[i]`. What a batch says through: {@link settledEdits} turns one `deck_apply`'s answer into
 * exactly the list N single writes used to settle into, so "47 of 50 cards" and its first refusal
 * read as they always did.
 */
export function reportSettled(
  settled: Promise<readonly PromiseSettledResult<unknown>[]>,
  names: readonly string[],
  say: PressWording,
): void {
  if (names.length === 0) return;
  void settled.then((results) => {
    const landed = names.filter((_, i) => results[i]?.status === "fulfilled");
    const refused = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (refused === undefined) {
      notify.success(say.done(namedCards(landed)));
    } else if (landed.length > 0) {
      notify.warning(say.done(`${landed.length} of ${plural(names.length, "card")}`), {
        body: ipcError(refused.reason),
      });
    } else {
      notify.error(say.failed(namedCards(names)), { body: ipcError(refused.reason) });
    }
  });
}

/**
 * One batch's answer as **one settled result per edit** — fulfilled where the edit landed (or
 * was an Auto refile already where it belongs), rejected with its own refusal where it was not —
 * and, when the whole call was refused (a busy database, a deck that is gone), `count` rejections
 * with that one sentence. Never rejects. What {@link reportSettled} and the editor's banner
 * (`useDeckDrops`' `lastBatch`) read, so a batch is said exactly as its N single writes were.
 */
export function settledEdits(
  outcome: Promise<{ results: readonly { refusal: string | null }[] }>,
  count: number,
): Promise<PromiseSettledResult<unknown>[]> {
  return outcome.then(
    ({ results }) =>
      results.map((r): PromiseSettledResult<unknown> =>
        r.refusal === null
          ? { status: "fulfilled", value: r }
          : { status: "rejected", reason: r.refusal },
      ),
    (reason: unknown) =>
      Array.from({ length: count }, (): PromiseRejectedResult => ({ status: "rejected", reason })),
  );
}

/**
 * The busy indicator's sentence for a batch (`lib/work.ts`) — `Moving 240 cards to “Sideboard”…`,
 * `Removing 300 cards…`. Present progressive, a count and an ellipsis: the receipt (or, for a drag,
 * the desk) that follows says the same thing in the past tense. Only batches raise it, so a count
 * is always the object — one card is a single write and never waits long enough to be drawn.
 */
export function workLabel(verb: string, count: number, where?: string): string {
  return `${verb} ${plural(count, "card")}${where === undefined ? "" : ` ${where}`}…`;
}

/** One write's refusal, as a toast — the `Couldn't …` half of a single-write receipt. */
export function notifyRefusal(title: string, error: unknown): void {
  notify.error(title, { body: ipcError(error) });
}

/** `Added 3 copies of “Sol Ring” to the collection` — a quick add's receipt, one card. */
export function quickAddReceipt(name: string, copies: number): string {
  return `Added ${plural(copies, "copy", "copies")} of “${name}” to your collection`;
}

/**
 * The deck-wide record's answer (`deck_missing_to_collection`) — a picked set's quick add, and
 * `Add missing to collection`. The wishlist half rides as the body, when there was one.
 */
export function notifyMissingAdded(outcome: DeckMissingOutcome): void {
  if (outcome.copies === 0) {
    notify.info("Nothing was added to your collection");
    return;
  }
  notify.success(
    `Added ${plural(outcome.copies, "copy", "copies")} of ${plural(outcome.cards, "card")} to your collection`,
    outcome.wishCopies > 0
      ? { body: `${plural(outcome.wishCopies, "copy", "copies")} taken off your wishlist` }
      : undefined,
  );
}

/** A pull's answer (`deck_pull_from_collection`): copies the reader owned, moved into the deck. */
export function notifyPulled(outcome: DeckPullOutcome, deckName: string): void {
  if (outcome.copies === 0) {
    notify.info("Nothing was pulled from your collection");
    return;
  }
  const into = deckName === "" ? "this deck" : `“${deckName}”`;
  notify.success(
    `Pulled ${plural(outcome.copies, "copy", "copies")} of ${plural(outcome.cards, "card")} ` +
      `into ${into}`,
  );
}

/**
 * A shopping list sent to the wishlist, **as a toast** (2026-10-12) — `TheoryDiffDialog`'s footer
 * and row presses, and the stats band's `Send missing to wishlist`, since the owner's rule that
 * every wishlist add says so.
 *
 * It was the footer's live region until issue #553 (2026-09-27): `Sent. 3 wishes updated.`,
 * beside the press, in a dialog that stayed open. Pressing it twice doubled every wish — the
 * press is `add_wish`'s fold, which **raises** a wish already there, and the reader chose to keep
 * that fold — and nothing on screen said the first press had worked except a dim line at the far
 * end of the footer. So a successful press closes the dialog, which is the plainest "done" there
 * is and leaves no second press to make from the same open. The sentence then stood on the
 * editor, in a line that cleared itself after six seconds — a bespoke toast, which this replaced,
 * so it is also in the Notifications inbox for a reader who looked away.
 *
 * **It names what was sent and where**: with the dialog gone, a bare "Sent." is about nothing a
 * reader can see. `what` is a row's card name; absent, the count the write answered. The root is
 * `the wishlist`, the destination `TheoryDiffDialog`'s `filedIn` would have named otherwise.
 *
 * **Zero is not "they were already wished for"**, which is `DeckStats`' zero arm's rule for the
 * same fold: nothing is ever skipped for being on the wishlist already, so a `0` means the rows
 * sent were no longer in the difference when the write re-read it (another window built them, or
 * they left the plan) or that every one was a printing the card database no longer holds.
 */
export function notifyWishesSent(
  { wishes, destination }: { wishes: number; destination: string | null },
  what?: string,
): void {
  if (wishes === 0) {
    notify.info("Nothing was sent to your wishlist", {
      body: "These cards are no longer missing, or aren't in your card data",
    });
    return;
  }
  const where = destination === null ? "your wishlist" : `“${destination}”`;
  notify.success(`Sent ${what ?? plural(wishes, "card")} to ${where}`);
}

/**
 * A token entry's **Remove printing**, said once it answers — the band's button and the pile's,
 * both deliberate presses on a tile that goes with them. The write answers `true`/`false` and
 * never rejects (`useDeckTokens`), so the refusal's reason is the band's own `failure` line; the
 * toast says that it failed and points nowhere else.
 */
export function withTokenRemoveReceipt(
  views: readonly DeckTokenView[],
  remove: (entry: TokenEntryRef) => Promise<boolean>,
): (entry: TokenEntryRef) => Promise<boolean> {
  return (entry) => {
    const view = views.find(
      (v) =>
        v.oracleId === entry.oracleId && v.printingId === entry.cardId && v.finish === entry.finish,
    );
    const named = view === undefined ? "the token" : `“${view.name}”`;
    return remove(entry).then((landed) => {
      if (landed) notify.success(`Removed ${named} from the deck`);
      else notify.error(`Couldn't remove ${named} from the deck`);
      return landed;
    });
  };
}
