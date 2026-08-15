/**
 * How the deck's column views arrange a deck's groups — which ones flow, and which share a column.
 *
 * **`splitRail` is shared by both column views; `packColumns` has one caller left.** `TextView`
 * still packs: a decklist line is 21px and a column of them holds thirty, so filling a column to
 * the desk's height and opening the next is what makes that view readable. `StackView` stopped on
 * 2026-08-14 — a card is 300px tall, so a column there held two or three piles, and packing to a
 * *height* left the desk's **width** unspent whenever the window was tall. Its piles are items of
 * a masonry grid now: CSS decides how many fit on a line, and each pile spans its own measured
 * height so that a wrapped one sits under the pile above it. The pack below is unchanged and still
 * correct for the view that kept it.
 *
 * The text view lays a deck out as columns read left to right, and faces the question this file
 * answers: a deck has fifteen categories and a column fits two or three of them. The answer is a
 * **greedy pack in the reader's own order** — never a re-ordering, and never a split.
 *
 * Order is the whole constraint. A balanced packer (longest-first, or a bin-packing pass)
 * fits more into fewer columns and puts the Sideboard between Ramp and Removal, which is a
 * deck list nobody can find anything in. `sortOrder` is the reader's, so it survives.
 *
 * The height is measured rather than guessed by the caller: the stack's groups have exact
 * pixel heights (`stackHeight`) and the text view's are a row count times a row pitch, so
 * this takes the measurement as a function and knows nothing about either.
 *
 * `splitRail` is the one thing here that reads a deck at all, and it reads exactly one word of
 * it. Everything else stays ignorant of what a group is.
 */
import type { CategoryKind } from "@/lib/ipc";

/**
 * `items` split into columns, each no taller than `maxHeight` — in order, and never splitting
 * one item across two columns.
 *
 * An item taller than a whole column gets a column to itself rather than being dropped: a
 * ninety-card main deck is a real pile, and one that vanished for being too big would be the
 * worst bug this file could have.
 */
export function packColumns<T>(
  items: readonly T[],
  heightOf: (item: T) => number,
  maxHeight: number,
): T[][] {
  const columns: T[][] = [];
  let current: T[] = [];
  let used = 0;

  for (const item of items) {
    const height = heightOf(item);
    // The `current.length > 0` half is what stops an over-tall item from opening an empty
    // column in front of itself and then another behind it.
    if (current.length > 0 && used + height > maxHeight) {
      columns.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += height;
  }

  if (current.length > 0) columns.push(current);
  return columns;
}

/**
 * How a test finds the rail the piles beside the deck are drawn in. An attribute rather than a
 * role, for the reason `StackView`'s `STACK_ATTR` is one: which side of the desk a group was drawn
 * on is a *layout* and says nothing to a reader who cannot see it, so there is no role to give it
 * and no accessible name to search by.
 *
 * **The rail carries this and nothing else.** It is not also a `STACK_ATTR` box: that attribute
 * means "a pile drawn in the flow", and the rail's piles are by construction the ones that never
 * reach it — the split below runs *first*. One element answering both would make every sweep that
 * counts the deck's own piles count the two played beside it. The name is unprefixed for the
 * same reason it lives here: `TextView` draws the same rail, and a `STACK_`-prefixed constant in
 * that file would be the wrong word in the right place. It is spelled for the *rail* rather than
 * for the Sideboard, because the Sideboard is no longer the only thing in it.
 */
export const RAIL_ATTR = "data-deck-rail";

/**
 * The groups that flow, and the ones that are pinned to the right.
 *
 * **The split is on `kind`, never on the heading.** The name is the user's —
 * `DECK_CATEGORY_GRAIN` is `(deck_id, name)`, so they may call any pile of their own "Sideboard"
 * or "Maybeboard" and rename the real ones to anything — and the kind is what the rules read. A
 * split on the heading would pin somebody's homebrew to the right and leave the piles the format
 * actually knows about buried in the pack, which is the failure this whole arrangement exists to
 * remove.
 *
 * **`side` and `maybe`, and the second one is there for the same three reasons as the first.**
 * Both are piles played *beside* the deck rather than in it, so a reader consults them without
 * reading down the deck itself. Both are routinely big — a maybeboard is where the cuts and the
 * candidates accumulate, so it grows rather than settling — which is precisely the pile a greedy
 * in-order pack scatters worst. And the Maybeboard is the other pile a reader looks for by
 * *position*: packed, it landed wherever the run happened to put it, which for a category seeded
 * last is the far end of a long one.
 *
 * **`commander` and `companion` still do not, and that is not an omission.** One card each, by
 * construction — railing either would spend a whole column's width on a pile that is read at a
 * glance, permanently, in every deck.
 *
 * **Nothing here sorts the rail.** The Sideboard sits above the Maybeboard because that is where
 * the reader's own `sortOrder` puts them — the seed's order — and a reader who reorders their
 * categories gets the order they chose, in the rail exactly as in the flow. Sorting by kind here
 * would be this file inventing a deck opinion, and it would silently overrule a reader who had
 * already expressed one.
 *
 * Generic on a structural `{ kind }` rather than on `CardGroup`, so this file stays what its
 * header says it is.
 *
 * **The kind is the whole test, and there is deliberately no grouping-mode check beside it** —
 * not because the other two modes cannot produce a rail, but because `kind` is already the honest
 * answer in all three.
 *
 * Under `Group by mana value` and `Group by type`, `buildGroups` buckets only the *active* cards,
 * and each bucket it invents carries `kind: null` — "Mana value 3" has no rules role, so it can
 * never be pinned. But the derived arm does not stop there: it appends every **switched-off** pile
 * as itself, `categoryGroup` and all, so a Sideboard or a Maybeboard the reader has switched off
 * arrives in those modes still carrying its own kind and this split still sends it to the rail.
 * That is the right answer — it is the same pile, it is still a drop target, and `buildGroups` was
 * already sending it to the right-hand end of the list — and reading it off `kind` is what gets it
 * right for free. It is also the *ordinary* case for the Maybeboard rather than a corner: that
 * pile is seeded switched off, so under a derived grouping it is in the rail by this route almost
 * every time.
 *
 * A mode check would be a second place to state what `CardGroup` already carries, and it would get
 * exactly that case wrong: it would flow a pile that ought to stay in the rail, in the two modes
 * where it is the only category on the desk. `groupBy` is also a deck concept, and this is the one
 * file here whose whole discipline is not knowing what a deck is. `isActive` is refused for the
 * same reason and one more: a switched-off pile is still that pile.
 *
 * Order is preserved inside both halves, and both callers depend on it: `TextView` hands `flow`
 * to `packColumns`, whose whole constraint is the reader's own order, and `StackView` maps it
 * straight into the items of a masonry grid, where placement follows document order and never
 * walks back up the page. A split that reordered would break either from outside it, where
 * nothing would be looking.
 */
export function splitRail<T extends { kind: CategoryKind | null }>(
  groups: readonly T[],
): { flow: T[]; rail: T[] } {
  const flow: T[] = [];
  const rail: T[] = [];

  for (const group of groups) {
    if (group.kind === "side" || group.kind === "maybe") rail.push(group);
    else flow.push(group);
  }

  return { flow, rail };
}
