/**
 * What a pull would actually take — `deck_pull_plan`'s rows folded together with the reader's
 * departures from them, and the payload `deck_pull_from_collection` is handed at the press.
 *
 * The backend answers a **shortfall and its options**: one row per printing-and-finish the live
 * list is short of, each carrying every unallocated copy on the reader's desk that could fill it,
 * in a preference order it has already chosen. What it deliberately does not answer is *which*
 * copies to take, because that is the one part of the question a dialog exists to let somebody
 * change. Rust supplies facts and TS draws conclusions ([`src/CLAUDE.md`](../../CLAUDE.md)); this
 * is the conclusion, and it is the whole of it.
 *
 * ## The default is a full pull, and the reader's state is only what departs from it
 *
 * {@link PullChoice} holds a set of rows switched **off** and a map of rows given a **different
 * first source** — nothing else, and emphatically not a per-row quantity or a copy of the plan
 * with edits applied to it. Everything a dialog draws is derived by {@link planPull} from the
 * rows and those two collections, so a re-read that drops a row, adds one, or moves a copy out
 * from under a candidate cannot leave the screen describing a plan that no longer exists: the
 * choices are keys and ids, and one that names nothing is ignored rather than honoured. A held
 * copy of the plan would have had to be reconciled by hand at every refetch, which is the shape
 * of bug that shows up as a dialog offering to take a card somebody else's window already took.
 *
 * ## Taking too little is a normal answer
 *
 * A row's candidates can total **less** than its `short` — the reader owns two of the four Bolts
 * their deck lists and has never owned the other two. That is reported ({@link PlannedRow.unfilled})
 * rather than hidden, and everything offered is still taken: filling three of four holes is worth
 * doing, and a plan that refused the row whole would leave the reader to work out why a card they
 * can see in their binder was not on offer.
 *
 * ## The order the candidates arrive in is the answer, not a suggestion
 *
 * `deck_pull::PullCandidate`'s own note carries the ranking — the root, then `Recently removed`,
 * then the reader's own folders, oldest row first inside a tie — and it ranks by *how little of
 * the reader's filing a pull disturbs*. Nothing here re-sorts, and a sort added here would be a
 * second opinion about a question already settled in the place that can see the folder tree.
 * {@link PullChoice.preferred} is how a reader overrides it, one row at a time, by naming the
 * entry to draw from **first** — which moves one candidate and leaves the rest of the backend's
 * order alone.
 */
import type { DeckPullCandidate, DeckPullPick, DeckPullRow } from "@/lib/ipc";

/** A row's identity — its printing and finish, the grain the backend folds at. */
export type PullKey = string;

/**
 * The key a row is switched off and given a source by.
 *
 * **The finish is part of it because the backend folds at `(card_id, finish)`.** A deck holding
 * `1 × Sol Ring (foil)` beside `3 × Sol Ring` holds two rows on `deck_cards`' own grain, and a
 * pull matches a candidate's finish exactly — so two rows of one printing in two finishes are two
 * independent shortfalls, filled from two different piles of cardboard, and a key naming only the
 * printing would switch both off with one press and pool their choices.
 *
 * `|` separates them, which is the same shape `theorySlot` spells and for the same reason it is
 * safe: a Scryfall id is a UUID, a finish is one of two words, so neither half can contain the
 * character and no two pairs can spell one key. `null` — the regular copy — is the empty string,
 * which no finish is, so it cannot collide with `"foil"` or `"etched"` either.
 *
 * **It is not the same string as `theorySlot`'s and must not be relied on to be.** That one
 * mirrors `deck_theory.rs`'s `group_key` and is pinned to the wire by tests on both sides;
 * nothing spells this one but this file, so it is free to change and is checked only against
 * itself.
 *
 * Takes the two fields it reads rather than a whole {@link DeckPullRow}, so a caller holding only
 * a printing and a finish can ask — a row satisfies it unchanged.
 */
export function pullKey(row: Pick<DeckPullRow, "cardId" | "finish">): PullKey {
  return `${row.cardId}|${row.finish ?? ""}`;
}

/** The reader's departures from the default. Tiny on purpose: everything else is derived. */
export interface PullChoice {
  /**
   * Rows the reader has unticked. **Absence is on**, so a plan that has just gained a row draws
   * it ticked, which is the same answer the dialog opened with.
   */
  readonly off: ReadonlySet<PullKey>;
  /**
   * Rows given a source to draw from first — key → `collection_entries` id.
   *
   * An id no candidate of that row carries is **ignored**, not repaired, so a re-read that folded
   * the chosen copy away leaves the row on the backend's own order rather than empty or thrown.
   */
  readonly preferred: ReadonlyMap<PullKey, number>;
}

/**
 * Nothing departed from — every row on, every row on its backend order. What a dialog opens with.
 *
 * A shared `const` rather than a literal at each call site so the identity is stable: a hook
 * seeding state with this and a reset writing it back produce the same reference, and a memo over
 * the choice does not re-run for a reset that changed nothing. Nothing in this module ever writes
 * to a choice it was handed, so the shared empties are never added to.
 */
export const NO_CHOICE: PullChoice = { off: new Set(), preferred: new Map() };

/**
 * Switch one row on or off, as a new choice.
 *
 * Returns the **same reference** when the row is already in the state asked for, which is what
 * makes an idempotent write from a controlled checkbox free rather than a re-render of the whole
 * dialog.
 *
 * **Switching a row off keeps its preferred source.** The row is contributing nothing either way,
 * and a reader who unticks a line and ticks it back has not changed their mind about which binder
 * to take the card out of — dropping it would quietly reset a choice they made deliberately.
 */
export function toggleRow(choice: PullChoice, key: PullKey, on: boolean): PullChoice {
  if (choice.off.has(key) === !on) return choice;
  const off = new Set(choice.off);
  if (on) off.delete(key);
  else off.add(key);
  return { off, preferred: choice.preferred };
}

/**
 * Name the entry one row draws from first, as a new choice.
 *
 * It says nothing about whether the row is on — the dialog decides whether a source picker is
 * reachable on an unticked row, and a write here that also ticked the row would be one control
 * doing two things.
 *
 * Returns the same reference when that entry is already the preferred one, for
 * {@link toggleRow}'s reason.
 */
export function preferSource(choice: PullChoice, key: PullKey, entryId: number): PullChoice {
  if (choice.preferred.get(key) === entryId) return choice;
  const preferred = new Map(choice.preferred);
  preferred.set(key, entryId);
  return { off: choice.off, preferred };
}

/** One copy this row will take. */
export interface PullTake {
  readonly entryId: number;
  readonly quantity: number;
}

/** An off row's takes. One frozen empty array rather than one per render — a `[]` literal per row
 *  is a new reference every call, which is exactly what a memo downstream would key on. */
const NO_TAKES: readonly PullTake[] = Object.freeze([]);

/**
 * What {@link PlannedRow.source} answers for a row with nothing to point at.
 *
 * `candidates` is never empty by contract, so this is unreachable through the front door; it
 * exists because a pure function called on every render must not throw on a shape it did not
 * expect, and `0` is a rowid SQLite never issues.
 */
const NO_SOURCE = 0;

export interface PlannedRow {
  readonly row: DeckPullRow;
  readonly key: PullKey;
  readonly on: boolean;
  /** In the order they will be taken. Empty when the row is off. */
  readonly takes: readonly PullTake[];
  /** Sum of `takes`. */
  readonly taking: number;
  /**
   * Copies this row still cannot fill even taking everything offered. 0 is the good case.
   *
   * `max(0, short − taking)`, unconditionally — so a row the reader switched **off** reads its
   * whole shortfall as unfilled, which is literally true of the press as it stands and is the
   * number a dialog should not draw on a line it has just been told to ignore. On an on row the
   * two readings coincide: an on row always takes everything offered up to its shortfall, so
   * `short − taking` *is* what the candidates could not cover.
   */
  readonly unfilled: number;
  /** The entry the source picker shows as chosen — the first one taken from. */
  readonly source: number;
}

export interface PullPlan {
  readonly rows: readonly PlannedRow[];
  /** Copies the press would move. */
  readonly copies: number;
  /** Printings that would get at least one. */
  readonly cards: number;
  /** The wire payload, ready for `ipc.deckPullFromCollection`. */
  readonly picks: readonly DeckPullPick[];
}

/**
 * The plan and the choices, folded into what the press would do.
 *
 * Pure and cheap — one pass over the rows and, inside each, one over its candidates — so it is
 * safe to call in a render body and no caller is asked to memoise it. That is deliberate: the
 * alternative is a `useMemo` per consumer keyed on a choice object, and a stale dependency there
 * is a dialog whose summary line disagrees with its own checkboxes.
 *
 * **Every row comes back, on or off**, because the dialog draws the off ones unticked. What an
 * off row contributes is nothing at all: no takes, no copies, no pick, and it is not counted in
 * {@link PullPlan.cards}.
 *
 * @param rows `deck_pull_plan`'s answer, untouched — never re-sorted, here or per row.
 * @param choice The reader's departures. {@link NO_CHOICE} is the full pull.
 */
export function planPull(rows: readonly DeckPullRow[], choice: PullChoice): PullPlan {
  const planned: PlannedRow[] = [];
  const picks: DeckPullPick[] = [];
  let copies = 0;
  let cards = 0;

  for (const row of rows) {
    const key = pullKey(row);
    const on = !choice.off.has(key);
    const takes = on ? takesFor(row, choice.preferred.get(key)) : NO_TAKES;

    let taking = 0;
    for (const take of takes) {
      taking += take.quantity;
      // A fresh object rather than the take itself: `DeckPullPick`'s fields are mutable — it is
      // the wire type — and one object shared between the row a component renders and the payload
      // handed to `invoke` would let a caller tidying the payload reach into the rendered plan.
      picks.push({ entryId: take.entryId, quantity: take.quantity });
    }

    if (taking > 0) {
      copies += taking;
      // Printings that get at least one, which is rows that take rather than rows considered — a
      // row taking nothing (switched off, or with nothing left to take from) is not a card. The
      // grain is the row's, so one printing short in two finishes counts twice: they are two
      // shortfalls filled from two piles of cardboard, which is what the key already says.
      cards += 1;
    }

    planned.push({
      row,
      key,
      on,
      takes,
      taking,
      unfilled: Math.max(0, row.short - taking),
      // The first entry actually taken from; failing that the reader's own choice even though it
      // is drawing nothing today (an off row's picker must keep showing what they picked), and
      // failing that the head of the backend's order, which is where an untouched row sits.
      source: takes[0]?.entryId ?? preferredSource(row, choice.preferred.get(key)),
    });
  }

  return { rows: planned, copies, cards, picks };
}

/** What a row with no takes shows as its source — the reader's pick where it still names a
 *  candidate, else the head of the backend's order. */
function preferredSource(row: DeckPullRow, preferred: number | undefined): number {
  if (preferred !== undefined && row.candidates.some((c) => c.entryId === preferred)) {
    return preferred;
  }
  return row.candidates[0]?.entryId ?? NO_SOURCE;
}

/**
 * Walk one row's candidates in order, taking what each can spare until the shortfall is met.
 *
 * **A take of zero is never emitted**, and both ways of reaching one are ordinary: the candidate
 * after the one that met the shortfall, and a row holding no copies. The backend refuses a batch
 * it disagrees with, and a pick asking for none of something is the sort of thing it would be
 * right to refuse over — so the guard is here rather than at the wire.
 */
function takesFor(row: DeckPullRow, preferred: number | undefined): readonly PullTake[] {
  const takes: PullTake[] = [];
  let remaining = row.short;
  for (const candidate of orderedCandidates(row.candidates, preferred)) {
    if (remaining <= 0) break;
    const quantity = Math.min(candidate.quantity, remaining);
    if (quantity <= 0) continue;
    takes.push({ entryId: candidate.entryId, quantity });
    remaining -= quantity;
  }
  return takes.length > 0 ? takes : NO_TAKES;
}

/**
 * The backend's order, with one candidate moved to the front.
 *
 * The array is returned **as it arrived** where there is nothing to move — no copy, and never a
 * sort in place: the rows belong to a query cache, and reordering one there would change a plan
 * the dialog is already drawing from underneath it.
 *
 * A preferred id no candidate carries is a **stale** choice — the copy was folded away, moved
 * into a deck, or the row was re-read after another window spent it — and the answer is the
 * default order rather than a throw or an empty row. That is the same fence
 * {@link PullChoice.preferred} states: a choice that names nothing is ignored.
 *
 * The rest are matched out by **id** rather than by identity, so a candidate list that ever
 * repeated an entry could not spend it twice — which is the one invariant the write cares about.
 */
function orderedCandidates(
  candidates: readonly DeckPullCandidate[],
  preferred: number | undefined,
): readonly DeckPullCandidate[] {
  if (preferred === undefined) return candidates;
  const first = candidates.find((c) => c.entryId === preferred);
  if (first === undefined) return candidates;
  return [first, ...candidates.filter((c) => c.entryId !== preferred)];
}
