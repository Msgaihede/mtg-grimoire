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
 * `splitRail` is the one thing here that reads a deck at all, and it reads exactly two words of
 * it — the pile's `kind` and its switch. Everything else stays ignorant of what a group is.
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
 * for the Sideboard, because the Sideboard is no longer the only thing in it — it holds the two
 * beside-the-deck kinds and, under them, every pile the reader has switched off.
 */
export const RAIL_ATTR = "data-deck-rail";

/**
 * How wide the flowing half may grow while a rail is drawn beside it — the whole columns it can
 * actually use, and never the ragged remainder past the last of them.
 *
 * **What it removes is the gap a reader sees between the deck and the Sideboard.** The flowing box
 * is `flex-1`, so it takes every pixel the rail leaves; it then lays *whole* columns from its left
 * edge and keeps what is left over — anything from nothing to very nearly a whole column — as dead
 * space **inside itself**, past its last column and in front of the rail. Measured on the reader's
 * own screenshot: a 1606px flowing box at 224px columns uses 1424 and holds 182px of nothing, so
 * the Sideboard stood **198px** from the deck where every other pair of piles is 16 apart. It moves
 * with the column width, so every zoom step changed it — which is why it read as a zoom bug.
 *
 * Two terms, and the smaller of them wins:
 *
 * - **`round(down, 100% - <column>, <column> + <gap>)`** is CSS's own floor, and it is what lets
 *   this stay a rule about **whole columns while nothing here measures the desk**. `100%` is the
 *   box the flowing half is a flex item of, the column subtracted from it is the rail's own width
 *   (the rail is exactly one column wide in both views, by construction), and rounding the rest
 *   down to a whole number of column pitches arrives at the same count `auto-fill` is about to.
 *   Less the one trailing gutter a pitch carries, that is the width of those columns.
 * - **`<columns> × (<column> + <gap>) - <gap>`** is the deck's own answer, and it is the half that
 *   matters on a desk with room for more columns than the deck has to put in them. A freshly
 *   created deck flows two piles; without this term the first term would hand it seven columns of
 *   box and hang the rail a screen away from the two that are drawn.
 *
 * The lengths are **strings rather than numbers** because the two views state a column in different
 * units — `StackView` in pixels derived from the zoom, `TextView` in the `rem` its own constant is
 * written in — and every operation here is arithmetic CSS does for itself, in whatever unit it is
 * handed. That is also why this returns an expression rather than a length: the desk's width is
 * only known to the browser, and the whole point is that it stays that way.
 *
 * `Math.max(1, …)` because a `max-width` that resolves negative is clamped to zero while the
 * flowing box keeps a `min-width` of one column, and a ceiling that disagrees with the floor beside
 * it is a rule that reads two ways. **An empty flow is reachable now and was not before**
 * (2026-08-17): `splitRail`'s switch test rails every pile that counts toward nothing, so a reader
 * who switches off every pile in the deck empties the flowing half — one empty column beside a rail
 * holding the lot, which is the honest picture of that deck rather than a state to guard against.
 */
export function flowMaxWidth(column: string, gap: string, columns: number): string {
  const pitch = `${column} + ${gap}`;
  return [
    `min(calc(${Math.max(1, columns)} * (${pitch}) - ${gap}),`,
    `calc(round(down, 100% - ${column}, ${pitch}) - ${gap}))`,
  ].join(" ");
}

/**
 * The groups that flow, and the ones that are pinned to the right.
 *
 * **Two tests, in this order: the pile's `kind`, then its switch.** The kinds played beside the
 * deck head the rail; every pile the reader has switched off follows underneath them; everything
 * else flows. Neither test is the heading — the name is the user's, and `DECK_CATEGORY_GRAIN` is
 * `(deck_id, name)`, so they may call any pile of their own "Sideboard" or "Maybeboard" and rename
 * the real ones to anything. A split on the heading would pin somebody's homebrew to the right and
 * leave the piles the format actually knows about buried in the pack, which is the failure this
 * whole arrangement exists to remove.
 *
 * **`side` and `maybe`, and the second one is there for the same three reasons as the first.**
 * Both are piles played *beside* the deck rather than in it, so a reader consults them without
 * reading down the deck itself. Both are routinely big — a maybeboard is where the cuts and the
 * candidates accumulate, so it grows rather than settling — which is precisely the pile a greedy
 * in-order pack scatters worst. And the Maybeboard is the other pile a reader looks for by
 * *position*: packed, it landed wherever the run happened to put it, which for a category seeded
 * last is the far end of a long one.
 *
 * **The switch is the second test, and it reverses what this doc used to say** (changed
 * 2026-08-17). `isActive` was refused here on the argument that *a switched-off pile is still that
 * pile* — true, and an argument about identity where the question is placement. `is_active = 0` is
 * the whole of what `maybe` ever meant: the pile counts toward nothing — not size, not copies, not
 * legality — and the allocator claims no copy for it. A pile that counts toward nothing is not part
 * of the deck being laid out, so it is read *beside* the deck on exactly the terms a sideboard is,
 * and leaving it in the flow spent a column of the desk on cards the reader had already said were
 * not in the deck. The old argument survives as the thing the rail **preserves**: this is a place,
 * not a deletion. The pile keeps its id, its heading, its menu and its drop target, no state
 * anywhere records that it was ever railed, and flipping the switch back on drops it into the flow
 * at its own `sortOrder` on the next render.
 *
 * **The kind is tested first, and that order is load-bearing.** The Maybeboard is seeded switched
 * off (`schema::PREDEFINED_CATEGORIES`), so a switch-first test would file it with the reader's own
 * switched-off piles and sink it below whatever they turned off last — the rail's fixed head moving
 * under them, in the ordinary case rather than a corner. Kind first keeps Sideboard and Maybeboard
 * at the top of the rail in the reader's own order, whatever their switches say.
 *
 * **`commander` and `companion` flow while they are switched on, and that is not an omission.** One
 * card each, by construction — railing either would spend a whole column's width on a pile that is
 * read at a glance, permanently, in every deck. Switched off they rail like anything else: that
 * exemption is an argument about a pile that is *in* the deck, and a switched-off command zone is
 * not one.
 *
 * **Nothing here sorts the rail, and appending is not sorting.** Each of the two runs arrives in
 * the reader's own `sortOrder` and leaves in it — the Sideboard sits above the Maybeboard because
 * that is where the seed put them, and a reader who reorders their categories gets the order they
 * chose, in the rail exactly as in the flow. What the concatenation decides is which of two runs a
 * pile is in, which is the rule above; it re-arranges nothing inside either.
 *
 * Generic on a structural `{ kind, isActive }` rather than on `CardGroup`, so this file stays what
 * its header says it is.
 *
 * **Those two words are the whole test, and there is deliberately no grouping-mode check beside
 * them** — not because the other two modes cannot produce a rail, but because they are already the
 * honest answer in all three.
 *
 * Under `Group by mana value` and `Group by type`, `buildGroups` buckets only the *active* cards,
 * and each bucket it invents carries `kind: null` and `isActive: true` — "Mana value 3" has no
 * rules role and is built from cards that count, so it can never be pinned by either test. But the
 * derived arm does not stop there: it appends every **switched-off** pile as itself, `categoryGroup`
 * and all, so those arrive in those modes carrying both words and this split rails the lot. That is
 * the right answer — they are the same piles, they are still drop targets, and `buildGroups` was
 * already sending them to the right-hand end of the list. It is also the *ordinary* case for the
 * Maybeboard rather than a corner: that pile is seeded switched off, so under a derived grouping it
 * is in the rail by the kind test almost every time.
 *
 * A mode check would be a second place to state what `CardGroup` already carries, and it would get
 * exactly that case wrong: it would flow a pile that ought to stay in the rail, in the two modes
 * where it is the only category on the desk. `groupBy` is also a deck concept, and this is the one
 * file here whose whole discipline is not knowing what a deck is.
 *
 * Order is preserved inside all three runs, and both callers depend on it: `TextView` hands `flow`
 * to `packColumns`, whose whole constraint is the reader's own order, and `StackView` maps it
 * straight into the items of a masonry grid, where placement follows document order and never
 * walks back up the page. A split that reordered would break either from outside it, where
 * nothing would be looking.
 */
export function splitRail<T extends { kind: CategoryKind | null; isActive: boolean }>(
  groups: readonly T[],
): { flow: T[]; rail: T[] } {
  const flow: T[] = [];
  // The rail's two runs, kept apart until the return so that the kind test cannot be reordered
  // under the switch test by an edit that only meant to tidy the loop. Concatenated in this
  // order and never sorted: see above for why the Maybeboard being seeded switched off is what
  // makes the order matter at all.
  const beside: T[] = [];
  const off: T[] = [];

  for (const group of groups) {
    if (group.kind === "side" || group.kind === "maybe") beside.push(group);
    else if (!group.isActive) off.push(group);
    else flow.push(group);
  }

  return { flow, rail: [...beside, ...off] };
}
