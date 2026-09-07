/**
 * What re-pointing a wishlist to its cheapest printings would actually do — `wishlist_optimize_plan`'s
 * moves folded together with the rows the reader has left ticked, and the payload
 * `wishlist_optimize_apply` is handed at the press.
 *
 * The backend answers **facts**: for each pinned wish, the printing it is on, the cheapest
 * printing of the same card at the reader's marketplace, and the difference between the two. It
 * deliberately answers nothing about *which* of those moves to make, because that is the whole
 * question the dialog exists to let somebody answer. Rust supplies facts and TS draws conclusions
 * ([`src/CLAUDE.md`](../../CLAUDE.md)); this is the conclusion, and it is all of it — every
 * number the dialog prints, the wording of its scope line and the reading of its outcome come
 * from here, so none of them can be recomputed slightly differently at a second call site.
 *
 * ## The default is not "everything"
 *
 * `pullPlan.ts` models the reader's state as *departures from a full pull*, because there every
 * row arrives ticked. Here the default is a **subset**: a wish whose current printing this
 * marketplace does not list is offered (an unlisted printing may be cheap rather than dear —
 * {@link WishOptimizeMove.savedPerCopy}) but starts **unticked**, because the app cannot say it
 * would save anything and a headline built from guesses is worse than a shorter one. So the state
 * is the ticked set itself, seeded by {@link defaultTicked}, and the dialog holds `null` until the
 * reader touches something — which is what lets a refetch under an open dialog (a marketplace
 * switch, a sync landing) re-seed rather than strand a set of ids that name nothing.
 *
 * ## Nothing here holds a copy of the plan
 *
 * Every function takes the moves it is asked about. A ticked id no move carries contributes
 * nothing rather than throwing, and a move nobody ticked is simply not in the payload — so a plan
 * that changed under the dialog cannot leave the screen describing a press that is no longer
 * available.
 */
import type {
  WishlistOptimizePlan,
  WishOptimizeApplyItem,
  WishOptimizeMove,
  WishOptimizeResult,
} from "@/lib/ipc";

/** `wishlist_entries.id` — how a move, a tick and a result all name the same wish. */
export type WishId = number;

/**
 * Nothing ticked, as a shared frozen set.
 *
 * A `new Set()` per call site is a new reference every render, which is exactly what a memo
 * downstream would key on. `NO_CHOICE` in `features/decks/pullPlan.ts` is the same constant for
 * the same reason. Nothing in this module ever writes to a set it was handed.
 */
export const NOTHING_TICKED: ReadonlySet<WishId> = Object.freeze(new Set<WishId>());

/**
 * What the dialog opens with: every move that carries a figure.
 *
 * `saved !== null` is the whole test, and it is the contract's own partition rather than a
 * heuristic — {@link WishOptimizeMove.savedPerCopy} is `null` **exactly** when the wish's current
 * printing is unpriced at this marketplace, and `saved` is `null` with it. Those rows are drawn
 * (`— → $2.00`) and left for the reader to tick deliberately, because the app has no basis for
 * claiming the swap is an improvement.
 *
 * `undefined` — the read has not answered — is the empty set rather than a throw, so a body can
 * derive its whole state before the plan lands.
 */
export function defaultTicked(plan: WishlistOptimizePlan | undefined): ReadonlySet<WishId> {
  if (plan === undefined || plan.moves.length === 0) return NOTHING_TICKED;
  const ticked = new Set<WishId>();
  for (const move of plan.moves) if (move.saved !== null) ticked.add(move.wishId);
  return ticked;
}

/** Every move in the plan, which is what one press of a select-all at `"none"` or `"some"` asks
 *  for — the unpriced rows included, because the reader is saying so by hand. */
export function everyMove(moves: readonly WishOptimizeMove[]): ReadonlySet<WishId> {
  if (moves.length === 0) return NOTHING_TICKED;
  return new Set(moves.map((move) => move.wishId));
}

/**
 * Tick or untick one wish, as a new set.
 *
 * Returns the **same reference** when the wish is already in the state asked for, so an idempotent
 * write from a controlled checkbox costs nothing — `pullPlan.ts`'s `toggleRow`, and its reason.
 */
export function toggleTicked(
  ticked: ReadonlySet<WishId>,
  wishId: WishId,
  on: boolean,
): ReadonlySet<WishId> {
  if (ticked.has(wishId) === on) return ticked;
  const next = new Set(ticked);
  if (on) next.add(wishId);
  else next.delete(wishId);
  return next;
}

/**
 * What the select-all control is showing.
 *
 * Three states rather than two, because a checkbox that only knew "all" and "not all" would go
 * from a half-ticked list straight to empty on its first press — and the press a reader wants
 * from a half-ticked list is *the rest of them*. `"some"` is drawn as the native `indeterminate`
 * mark and presses to `"all"`.
 *
 * An empty plan is `"none"`: there is nothing ticked, which is true, and the control is not drawn
 * over an empty list anyway.
 */
export type SelectAllState = "all" | "none" | "some";

/** Everything the dialog counts, derived once so a footer total and a row's own tick can never
 *  come to disagree. */
export interface OptimizeSelection {
  /** The wire payload, ready for `ipc.wishlistOptimizeApply` — in the plan's own order. */
  readonly items: readonly WishOptimizeApplyItem[];
  /** How many wishes the press would repoint. `items.length`, named because the button says it. */
  readonly count: number;
  /**
   * What the ticked rows would save in total, over every copy.
   *
   * A ticked row carrying no figure contributes **0** rather than making the whole total `null`:
   * the sum is honest about the rows it can price, and {@link OptimizeSelection.unpriced} is what
   * keeps it from reading as the whole story.
   */
  readonly saved: number;
  /** Ticked rows whose saving is unknown, because the printing they are leaving is unpriced
   *  here. The qualification {@link OptimizeSelection.saved} needs to stay honest — the same
   *  shape as the wishlist header's own `unpriced` note. */
  readonly unpriced: number;
  readonly all: SelectAllState;
}

/** No moves and nothing ticked. Shared for {@link NOTHING_TICKED}'s reason. */
const EMPTY_SELECTION: OptimizeSelection = Object.freeze({
  items: Object.freeze([] as WishOptimizeApplyItem[]),
  count: 0,
  saved: 0,
  unpriced: 0,
  all: "none",
});

/**
 * The moves and the ticks, folded into what the press would do.
 *
 * Pure and one pass, so it is safe to call in a render body — the alternative is a `useMemo` per
 * consumer keyed on a `Set`, and a stale dependency there is a footer disagreeing with its own
 * checkboxes.
 *
 * **A ticked id that names no move is ignored**, which is what makes the ticked set survive a
 * refetch: the reader's answer about a wish that has left the plan is neither honoured nor an
 * error, it simply has nothing to apply to.
 */
export function selectionOf(
  moves: readonly WishOptimizeMove[],
  ticked: ReadonlySet<WishId>,
): OptimizeSelection {
  if (moves.length === 0) return EMPTY_SELECTION;

  const items: WishOptimizeApplyItem[] = [];
  let saved = 0;
  let unpriced = 0;

  for (const move of moves) {
    if (!ticked.has(move.wishId)) continue;
    // A fresh object rather than anything reachable from the rendered plan: `WishOptimizeApplyItem`
    // is the wire type and its fields are mutable, so sharing one with the row on screen would let
    // a caller tidying the payload reach back into what the reader is looking at. `planPull` copies
    // its picks for the same reason.
    //
    // **`fromCardId` is the guard and is never optional.** The contract's own sentence: between
    // the preview and the press a sync can land, so a wish whose `card_id` has moved on is left
    // alone and reported `stale` rather than repointed to a printing nobody saw.
    items.push({ wishId: move.wishId, fromCardId: move.from.cardId, toCardId: move.to.cardId });
    if (move.saved === null) unpriced += 1;
    else saved += move.saved;
  }

  return {
    items,
    count: items.length,
    saved,
    unpriced,
    all: items.length === 0 ? "none" : items.length === moves.length ? "all" : "some",
  };
}

/** A wish the press did not move, and why. `name` is `null` only where the summary was not given
 *  the move it belongs to, which the contract makes unreachable through the front door — one
 *  result per item sent, and every item came from a move. */
export interface OptimizeSkip {
  readonly wishId: WishId;
  readonly name: string | null;
  readonly status: "stale" | "missing";
}

/** What one press of Apply actually did. */
export interface OptimizeOutcome {
  /** Repointed — the ordinary answer. */
  readonly changed: number;
  /**
   * Folded into a wish that was already sitting in the same folder at the same finish.
   *
   * **Counted as a success and reported separately**, because it is `wishlist_set_printing`'s
   * documented merge rule rather than a failure: the wish did
   * move to the cheaper printing, so its saving stands — what changed as well is that the reader
   * now has one row where they had two, and a summary that did not say so would leave them
   * hunting for a wish that is not missing.
   */
  readonly merged: number;
  /** The wish had moved on since the preview; nothing was written. */
  readonly stale: number;
  /** The wish is not on the list any more; nothing was written. */
  readonly missing: number;
  /**
   * The saving **actually realised** — summed over the `changed` and `merged` rows alone.
   *
   * Not the figure the footer promised, and the difference is the whole reason this is computed
   * from the results rather than carried over from the press: a `stale` or `missing` row was not
   * written, so counting its saving would report money the reader has not saved.
   */
  readonly saved: number;
  /** Moved rows whose saving was unknown — {@link OptimizeSelection.unpriced} after the fact,
   *  and the same qualification of the same figure. */
  readonly unpriced: number;
  /** Every `stale` and `missing` row, named, in the order they came back. What makes a skipped
   *  change visible instead of silent. */
  readonly skipped: readonly OptimizeSkip[];
}

/**
 * Read `wishlist_optimize_apply`'s answer back against the moves that were sent.
 *
 * **`moves` is the snapshot the press was made from, not whatever the plan query holds now.** The
 * apply invalidates `["wishlist"]`, so the plan behind an open dialog refetches and the applied
 * wishes leave it — a join against the live plan would lose every name and report nothing saved,
 * on exactly the screen whose job is to say what happened.
 *
 * Joined by `wishId` rather than by position: the results are documented to arrive one per item
 * in order, and matching on the id means a backend that ever stopped honouring that would report
 * nothing rather than report the wrong card's name.
 */
export function summariseOutcome(
  results: readonly WishOptimizeResult[],
  moves: readonly WishOptimizeMove[],
): OptimizeOutcome {
  const byId = new Map(moves.map((move) => [move.wishId, move]));
  const skipped: OptimizeSkip[] = [];
  let changed = 0;
  let merged = 0;
  let stale = 0;
  let missing = 0;
  let saved = 0;
  let unpriced = 0;

  for (const result of results) {
    const move = byId.get(result.wishId);
    switch (result.status) {
      case "changed":
      case "merged": {
        if (result.status === "changed") changed += 1;
        else merged += 1;
        // A move the snapshot does not carry contributes no figure, which is the same answer an
        // unpriced one gives: the row moved and the app cannot say what it was worth.
        if (move === undefined || move.saved === null) unpriced += 1;
        else saved += move.saved;
        break;
      }
      case "stale":
      case "missing": {
        if (result.status === "stale") stale += 1;
        else missing += 1;
        skipped.push({
          wishId: result.wishId,
          name: move?.name ?? null,
          status: result.status,
        });
        break;
      }
    }
  }

  return { changed, merged, stale, missing, saved, unpriced, skipped };
}

/** What the subtitle calls a flattened list — every drawer at once, which is the one scope with
 *  no folder to name. */
const EVERY_FOLDER = "Every folder";

/**
 * Where the sweep is looking, as the dialog's subtitle says it.
 *
 * The plan is taken over **the query the list is currently drawn from** — the folder, the Flatten
 * switch and every active filter — so the reader has to be able to read the scope off the dialog
 * without going back to the page behind the scrim. Three facts and three clauses:
 *
 * * **Flattened wins outright.** With the filing ignored there is no level to name, and the
 *   folder the reader last stood in is not what is being swept.
 * * **Otherwise it is the folder's own name**, and at the root that is whatever the page calls
 *   the root — the word is the caller's, because the page already owns it (`ROOT_LABEL`) and a
 *   second copy here is a second thing to keep in step. A folder id the page cannot name resolves
 *   to the root word at the call site, which is the same "resolve towards the root" rule
 *   `trailOf` applies to a broken trail.
 * * **The filters are said where there are any**, because they are the half of the scope with
 *   nothing on this panel to show for them: a reader looking at four rows under a heading naming
 *   their whole wishlist would otherwise read the preview as the sweep having missed something.
 */
export function optimizeScope({
  flatten,
  folder,
  filtered,
}: {
  flatten: boolean;
  /** The level the list is drawn at, already named — `folderNameOf(folderId)` on the page, which
   *  answers the root's own word for `null`. Ignored while `flatten` is on. */
  folder: string;
  /** Whether any card filter is narrowing the list. */
  filtered: boolean;
}): string {
  const where = flatten ? EVERY_FOLDER : folder;
  return filtered ? `${where}, matching your filters` : where;
}
