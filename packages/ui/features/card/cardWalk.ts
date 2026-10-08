/**
 * A **card list** as a walk — one stop per drawn tile — and the one way any surface publishes one.
 *
 * `deckWalk.ts` does this for the deck editor's desk, where a stop is a row of an open deck and
 * carries the five-part address a press inside the printings modal writes to. This file is the
 * other half: the three surfaces whose rows are *not* deck rows — the search results, the
 * collection and the wishlist — where a stop is a printing and nothing more, because there is no
 * row for a press to write to and the modal says so by opening the card pane instead.
 *
 * Both build the same {@link CardWalkStop}, and that is the whole reason the modal needs no
 * branch for "which kind of list am I over": it finds its place, draws two chevrons and steps.
 * The one place the kinds are told apart is the step itself, which re-anchors the card pane to a
 * deck row or opens a card plainly — see `AllPrintingsDialog`.
 *
 * ## Why the pages publish at all, rather than the modal reading a list
 *
 * `AllPrintingsDialog` renders at `App` level, a sibling of the shell and outside every view, so
 * no React context reaches it — and the order it would have to walk is not recomputable on its
 * side either. A page's rows are a query narrowed by a filter bar and sorted by a header the
 * reader clicked, all of it `useState` inside that page. Only the surface drawing the list knows
 * the order the reader is actually looking at, so the surface publishes and the modal reads,
 * exactly as `paneDeckContext` already carries the one row a card was opened from.
 *
 * **`ActiveView` is what makes a single store field safe**: exactly one of the five views is
 * mounted at a time, so these three and the deck editor can never publish over one another.
 */
import { useEffect } from "react";
import { useAppStore, type CardWalk, type CardWalkStop } from "@/lib/store";

/**
 * What one row of a card list has to be able to say to be a stop on a walk through printings.
 *
 * Three fields, and two of them are nullable because the rows they come from are: a search result
 * and a collection entry both read `oracle_id` off a LEFT JOIN, and a wish carries no `cardId` at
 * all until it is pinned to a printing. {@link listWalkStops} is what turns those nulls into an
 * absence from the walk rather than into a stop that cannot answer.
 */
export interface WalkRow {
  /** The printing: what the pane opens on and what the wall rings. `null` where the row names no
   *  cardboard — an any-printing wish. */
  cardId: string | null;
  /** The oracle card whose printings the modal would list. `null` is an orphan whose printing has
   *  left the corpus. */
  oracleId: string | null;
  /** What the modal captions itself with. Never null: every one of these rows carries a name of
   *  its own, or a `SET number` fallback its own surface already draws. */
  name: string;
}

/**
 * A drawn list of cards as the walk through it.
 *
 * **The order is the surface's, verbatim** — this maps and never sorts. The reader asked for
 * "the next card", and the next card is the next tile on the wall or the next row of the table,
 * whatever the filter bar and the sorted header have made that.
 *
 * **Two rows are dropped, and each for a reason the modal could not survive.**
 *
 * * *No oracle id* — an orphan, whose printing has left the card database. There are no printings
 *   to show for one, so it is not a stop on a walk *through printings*: stepping onto it would
 *   open a modal with nothing in it and no way to say why. `deckWalkStops` drops the same row for
 *   the same reason, and the card menu greys `View all printings` on it for a third.
 * * *No card id* — an any-printing wish, which names a card but no cardboard. It has nothing for
 *   the pane behind the scrim to open and nothing for the wall to ring, and the wishlist already
 *   offers it no card menu at all, so it could never have been a walk's first stop either.
 *
 * **Deduplicated by printing, and the *first* drawing of one wins.** A collection holds one
 * printing as a foil entry and a played nonfoil entry — two rows of the table, one tile of the
 * wall — and the printings modal answers both with the same wall and the same ring. A stop for
 * each would be a press that moved nothing on screen, which reads as a dead key rather than as
 * the end of a list. This is *not* the deck's rule, and the difference is the point: there a
 * press **writes** to the row that was stepped onto, so one card filed in two piles is genuinely
 * two stops with two addresses. Here a press writes nothing, so two rows naming one printing are
 * one question.
 *
 * Two *different* printings of one card stay two stops. The wall does not change between them —
 * it is the same oracle card — but the ring does, and so does the card selected on the page
 * behind the scrim, which is what the reader is stepping through.
 */
export function listWalkStops<T>(rows: readonly T[], rowOf: (row: T) => WalkRow): CardWalkStop[] {
  const stops: CardWalkStop[] = [];
  const seen = new Set<string>();
  // A plain loop rather than a `map` and two `filter`s, for `deckWalkStops`' own reason: each
  // pass is another place for the rule about which rows survive to be stated, and the second one
  // is the one that gets edited without the first.
  for (const row of rows) {
    const { cardId, oracleId, name } = rowOf(row);
    if (cardId === null || oracleId === null) continue;
    if (seen.has(cardId)) continue;
    seen.add(cardId);
    stops.push({ cardId, oracleId, name, deck: null });
  }
  return stops;
}

/** The walk a surface with no list publishes on its way out. Module scope so that a teardown
 *  allocates nothing; the store collapses it to its own single empty walk anyway. */
const NO_WALK: CardWalk = { label: "", stops: [] };

/**
 * Publish this surface's walk for as long as it is on screen, and clear it on the way out.
 *
 * `label` names the list in the reader's words — `your collection`, `these search results` — and
 * is read straight into the chevrons' accessible names. `stops` **must be memoised by the
 * caller**: an array rebuilt on every render publishes an identical walk under a new identity,
 * and zustand compares a subscriber's slice with `Object.is`, so every unrelated re-render of the
 * page — a hover, a mutation settling, a keystroke in a filter box — would re-render the modal.
 *
 * **The clear is a separate, mount-only effect rather than the first one's cleanup**, and that is
 * load-bearing. A cleanup on the publishing effect runs on *every change* of the walk, so each
 * keystroke in a filter box would write an empty walk and then the real one — two writes, and a
 * frame in which a modal open over this list has nowhere to step to. Here the walk is cleared
 * exactly once, when the surface goes: a walk left behind would step a modal opened somewhere
 * else through a list nobody is looking at.
 */
export function usePublishCardWalk(label: string, stops: CardWalkStop[]): void {
  // The write, and deliberately not a read: a publisher that also selected the walk would
  // re-render itself on its own writes.
  const setCardWalk = useAppStore((s) => s.setCardWalk);

  useEffect(() => {
    setCardWalk({ label, stops });
  }, [label, stops, setCardWalk]);

  useEffect(() => () => setCardWalk(NO_WALK), [setCardWalk]);
}
