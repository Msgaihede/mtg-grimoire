/**
 * What the `Add missing to collection` press will actually record — `deck_missing_plan`'s rows
 * folded together with the reader's departures from them, and the payload
 * `deck_missing_to_collection` is handed at the press.
 *
 * The backend answers a **shortfall**: one row per printing-and-finish the live list is short of,
 * carrying the piles that are short and whatever wishlist lines that exact cardboard would come
 * off. What it deliberately does not answer is *how many* of each the reader actually bought,
 * because that is the one part of the question a dialog exists to let somebody change. Rust
 * supplies facts and TS draws conclusions ([`src/CLAUDE.md`](../../CLAUDE.md)); this is the
 * conclusion, and it is the whole of it.
 *
 * ## The pull's departure is a source; this one's is a count
 *
 * That is the whole difference between this file and its sibling {@link ./pullPlan}. A pull
 * chooses *which* copies, because they exist and sit somewhere on the reader's desk, and the
 * only thing a reader can move is which binder is drawn from first. Nothing here exists yet —
 * the press *creates* cardboard rather than moving it — so there is no source to choose, and the
 * one thing a reader can honestly say instead is that they bought two of the four their deck
 * wants. {@link MissingChoice.copies} is that sentence and it is the only extra state there is.
 *
 * ## The default is everything, and the reader's state is only what departs from it
 *
 * {@link MissingChoice} holds a set of rows switched **off** and a map of rows given a
 * **different count** — nothing else, and emphatically not a copy of the plan with edits applied
 * to it. Everything a dialog draws is derived by {@link planAddMissing} from the rows and those
 * two collections, so a re-read that drops a row, adds one, or lowers a shortfall under the
 * reader's hand cannot leave the screen describing a press that no longer exists: the choices are
 * keys and numbers, and one that names nothing is **ignored rather than repaired**. A held copy
 * of the plan would have had to be reconciled by hand at every refetch, which is the shape of bug
 * that shows up as a footer offering to record copies the backend then refuses.
 *
 * ## The clamp is why this module is worth having
 *
 * A stored count is clamped to `[1, row.short]` **at the derivation and never at the write**.
 * The reader's own number is kept as they typed it — a shortfall that comes back up restores what
 * they asked for — while what the footer previews and what the picks carry are always inside what
 * the backend will accept. Unclamped, a count stored against a shortfall of four and re-read
 * against a shortfall of two previews a press that is refused whole with
 * `deck_pull::MORE_THAN_MISSING`, which is a refusal about a number the reader never saw change.
 *
 * ## `pullKey` is imported rather than respelled
 *
 * A {@link DeckMissingRow} satisfies `pullKey`'s `Pick<DeckPullRow, "cardId" | "finish">`
 * parameter structurally, and the grain the two backends fold at is the same `(card_id, finish)`
 * — so this is one key, not two that agree today. A second spelling of `cardId|finish` is a
 * second thing to drift, and the finish is in it for the reason stated there: a deck holding
 * `1 x Sol Ring (foil)` beside `3 x Sol Ring` is two shortfalls filled with two different pieces
 * of cardboard, and one key would switch both off with a single press and pool their counts.
 */
import type { DeckMissingPick, DeckMissingRow } from "@/lib/ipc";
import { pullKey, type PullKey } from "./pullPlan";

/** The reader's departures from the default. Tiny on purpose: everything else is derived. */
export interface MissingChoice {
  /**
   * Rows the reader has unticked. **Absence is on**, so a plan that has just gained a row draws
   * it ticked, which is the same answer the dialog opened with.
   */
  readonly off: ReadonlySet<PullKey>;
  /**
   * Rows given a count of their own — key -> copies to record. **Absence is the whole
   * shortfall**, which is what a reader who has bought everything they were short of means.
   *
   * Stored exactly as it was written, out of range included: {@link planAddMissing} clamps on
   * the way out, so a shortfall that moves under an open dialog neither loses the reader's
   * number nor previews one the backend would refuse.
   */
  readonly copies: ReadonlyMap<PullKey, number>;
}

/**
 * Nothing departed from — every row on, every row at its full shortfall. What a dialog opens
 * with.
 *
 * A shared `const` rather than a literal at each call site so the identity is stable: a hook
 * seeding state with this and a reset writing it back produce the same reference, and a memo over
 * the choice does not re-run for a reset that changed nothing. Nothing in this module ever writes
 * to a choice it was handed, so the shared empties are never added to.
 */
export const NO_MISSING_CHOICE: MissingChoice = { off: new Set(), copies: new Map() };

/**
 * Switch one row on or off, as a new choice.
 *
 * Returns the **same reference** when the row is already in the state asked for, which is what
 * makes an idempotent write from a controlled checkbox free rather than a re-render of the whole
 * dialog.
 *
 * **Switching a row off keeps its count.** The row is contributing nothing either way, and a
 * reader who unticks a line and ticks it back has not changed their mind about how many copies
 * they bought — dropping it would quietly reset a number they typed deliberately.
 */
export function toggleRow(choice: MissingChoice, key: PullKey, on: boolean): MissingChoice {
  if (choice.off.has(key) === !on) return choice;
  const off = new Set(choice.off);
  if (on) off.delete(key);
  else off.add(key);
  return { off, copies: choice.copies };
}

/**
 * Name how many copies one row records, as a new choice.
 *
 * It says nothing about whether the row is on — the dialog decides whether a stepper is reachable
 * on an unticked row, and a write here that also ticked the row would be one control doing two
 * things.
 *
 * The number is stored verbatim rather than clamped, because the only thing that can be right
 * about a shortfall is the derivation reading the rows it currently has; see this module's own
 * doc. Returns the same reference when that count is already stored, for {@link toggleRow}'s
 * reason — a stepper held at the end of its range fires on every press.
 */
export function setCopies(choice: MissingChoice, key: PullKey, copies: number): MissingChoice {
  if (choice.copies.get(key) === copies) return choice;
  const next = new Map(choice.copies);
  next.set(key, copies);
  return { off: choice.off, copies: next };
}

/**
 * What one row's wishlist half would do, as a sentence the dialog can draw beside it.
 *
 * Three shapes and no fourth, because the backend acts on an **unambiguous** match only: exactly
 * one line matching is taken down, none and two-or-more are left standing. That is why no wish id
 * travels on a {@link DeckMissingPick} — the choice is made inside the write's own transaction,
 * where a line that vanished under the dialog is simply not among the matches.
 *
 * `null` is *nothing to say*, which covers both a row with no matching line and a press that was
 * never going to touch a wish at all.
 */
export type RowWish =
  | {
      readonly kind: "one";
      /** Copies this press would take off the wish — never more than the wish holds. */
      readonly clears: number;
      /** Where that line sits, or `null` at the root, which the UI words rather than the
       *  backend — `DeckQuickAddWish.folderName`'s own rule. */
      readonly folderName: string | null;
    }
  | {
      readonly kind: "ambiguous";
      /** How many lines match. Two or more; the reader is told they are left alone. */
      readonly matches: number;
    }
  | null;

export interface PlannedMissingRow {
  readonly row: DeckMissingRow;
  readonly key: PullKey;
  readonly on: boolean;
  /**
   * Copies this row would record — the reader's own count where they gave one, else the whole
   * shortfall, clamped to `[1, row.short]` either way.
   *
   * **Meaningful only when {@link on}**, and drawn regardless: an unticked row keeps its stepper
   * showing the number the reader chose, so ticking it back does not read as the app having
   * forgotten.
   */
  readonly copies: number;
  /** What this row's line would do to the wishlist. `null` when `clearWishes` is false, or when
   *  no line matches — see {@link RowWish}. */
  readonly wish: RowWish;
}

export interface AddMissingPlan {
  /** Every row of the plan, on or off, in the order the backend answered. */
  readonly rows: readonly PlannedMissingRow[];
  /** The wire payload, ready for `ipc.deckMissingToCollection`. One pick per ticked row. */
  readonly picks: readonly DeckMissingPick[];
  /** Copies the press would record. */
  readonly copies: number;
  /**
   * Rows that would get at least one copy — so **printings *and* finishes**, at
   * {@link DeckMissingRow}'s own grain, and not distinct printings.
   *
   * Spelled out for `DeckPullOutcome.cards`' reason: three places count this — the crate's own
   * `wanted.len()`, the Storybook fake's handler, and this, which is what the footer previews
   * *before* the press. A grain mismatch would surface only on a deck short of one printing in
   * two finishes, as a sentence quoting a number the reader had just been shown another version
   * of.
   */
  readonly cards: number;
  /** Copies the press would take off the wishlist, summed over ticked rows with exactly one
   *  matching line. `0` whenever `clearWishes` is false. */
  readonly wishesCleared: number;
}

/**
 * The plan and the choices, folded into what the press would do.
 *
 * Pure and cheap — one pass over the rows — so it is safe to call in a render body and no
 * caller is asked to memoise it. That is deliberate: the alternative is a `useMemo` per consumer
 * keyed on a choice object, and a stale dependency there is a dialog whose footer count
 * disagrees with its own checkboxes.
 *
 * **Every row comes back, on or off**, because the dialog draws the off ones unticked. What an
 * off row contributes is nothing at all: no pick, no copies, no cleared wish, and it is not
 * counted in {@link AddMissingPlan.cards}. It still reports its own {@link PlannedMissingRow.wish}
 * — the sentence beside a row is about that row's line, and the dialog dims an unticked row
 * whole.
 *
 * @param rows `deck_missing_plan`'s answer, untouched — never re-sorted and never written to.
 * @param choice The reader's departures. {@link NO_MISSING_CHOICE} records the whole shortfall.
 * @param clearWishes The footer's one checkbox, for the whole batch — the per-row answer is
 *   already drawn beside each row, so a reader who wants one row's wish kept unticks that row.
 */
export function planAddMissing(
  rows: readonly DeckMissingRow[],
  choice: MissingChoice,
  clearWishes: boolean,
): AddMissingPlan {
  const planned: PlannedMissingRow[] = [];
  const picks: DeckMissingPick[] = [];
  let copies = 0;
  let cards = 0;
  let wishesCleared = 0;

  for (const row of rows) {
    const key = pullKey(row);
    const on = !choice.off.has(key);
    // The clamp, and the whole reason this module exists. Read, never written back: the choice
    // keeps what the reader asked for so a shortfall that comes back up restores it.
    const rowCopies = Math.min(Math.max(choice.copies.get(key) ?? row.short, 1), row.short);

    // `!clearWishes` **first**, and it collapses every row including the ambiguous ones: the
    // sentence beside a row must not describe something the press will not do, and "2 wishlist
    // lines match - left alone" over a press that was never going to touch a wish is a fact
    // about the wrong world.
    const wish: RowWish = !clearWishes
      ? null
      : row.wishes.length === 1
        ? {
            kind: "one",
            clears: Math.min(rowCopies, row.wishes[0].quantity),
            folderName: row.wishes[0].folderName,
          }
        : row.wishes.length >= 2
          ? { kind: "ambiguous", matches: row.wishes.length }
          : null;

    // A row recording nothing is not a card, and a pick asking for none of something is what
    // `collection::ZERO_ADD` refuses — so the guard is here rather than at the wire. It is
    // unreachable through the front door (the backend answers no row it is short of nothing of)
    // and a pure function called on every render must not build a payload out of contract.
    if (on && rowCopies > 0) {
      // A fresh object rather than one shared with the row a component renders:
      // `DeckMissingPick`'s fields are mutable — it is the wire type — and one object in both
      // places would let a caller tidying the payload reach into the rendered plan.
      picks.push({ cardId: row.cardId, finish: row.finish, quantity: rowCopies });
      copies += rowCopies;
      cards += 1;
      if (wish?.kind === "one") wishesCleared += wish.clears;
    }

    planned.push({ row, key, on, copies: rowCopies, wish });
  }

  return { rows: planned, picks, copies, cards, wishesCleared };
}
