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
 * it — the pile's `kind` and its switch. **Those two words answer three runs now rather than two**
 * (changed 2026-08-20): the command zones, the flow, and the rail. Everything else stays ignorant
 * of what a group is.
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
 *
 * **There are three of these marked boxes now, one per run of the split below, and no element
 * carries two.** `STACK_ATTR` is a pile drawn in the flow, this is the rail, and `COMMAND_ATTR`
 * is the column the command zones are stacked in — declared in `StackView.tsx`, because that
 * stacked column is that view's own drawing of the run, where the rail is drawn by both views and
 * is therefore named here. The exclusivity is what keeps a sweep counting one run from counting
 * another: it is the same argument the paragraph above makes about `STACK_ATTR`, now with a third
 * box to make it about. **A switched-off command zone is in _this_ box**, which is the one case
 * where a pile whose `kind` names a command zone is not in the command run at all — see the
 * `isActive` half of the first test below.
 */
export const RAIL_ATTR = "data-deck-rail";

/**
 * The groups played from a zone of their own, the ones that flow, and the ones pinned to the right.
 *
 * **Three tests, in this order: the command zone, the pile's `kind`, then its switch.** An active
 * `commander` or `companion` is its own run and leads the answer; the kinds played beside the deck
 * head the rail; every pile the reader has switched off follows underneath them; everything else
 * flows. None of the three is the heading — the name is the user's, and `DECK_CATEGORY_GRAIN` is
 * `(deck_id, name)`, so they may call any pile of their own "Sideboard", "Maybeboard" or
 * "Commander" and rename the real ones to anything. A split on the heading would pin somebody's
 * homebrew to the right and leave the piles the format actually knows about buried in the pack,
 * which is the failure this whole arrangement exists to remove.
 *
 * **`side` and `maybe`, and the second one is there for the same three reasons as the first.**
 * Both are piles played *beside* the deck rather than in it, so a reader consults them without
 * reading down the deck itself. Both are routinely big — a maybeboard is where the cuts and the
 * candidates accumulate, so it grows rather than settling — which is precisely the pile a greedy
 * in-order pack scatters worst. And the Maybeboard is the other pile a reader looks for by
 * *position*: packed, it landed wherever the run happened to put it, which for a category seeded
 * last is the far end of a long one.
 *
 * **The switch is tested after the kind, and it reverses what this doc used to say** (changed
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
 * **The kind is tested before the switch, and that order is load-bearing.** The Maybeboard is
 * seeded switched off (`schema::PREDEFINED_CATEGORIES`), so a switch-first test would file it with
 * the reader's own switched-off piles and sink it below whatever they turned off last — the rail's
 * fixed head moving under them, in the ordinary case rather than a corner. Kind first keeps
 * Sideboard and Maybeboard at the top of the rail in the reader's own order, whatever their
 * switches say.
 *
 * **`commander` and `companion` are a run of their own, and that is new** (changed 2026-08-20).
 * This paragraph used to say they flow while they are switched on, and it was wrong in a way worth
 * writing down rather than deleting. Its argument was that one card each is read at a glance, so
 * railing either would spend a whole column's width on a pile that needs none — right about the
 * width, and silent about the *place*. Flowing, a command zone sat wherever the reader's
 * `sortOrder` or a derived bucket happened to put it, so the card the other ninety-nine were
 * chosen around drifted down the desk every time the grouping changed and had to be looked for. A
 * commander is not a card in the curve; it is the card the curve was built *around*, played from a
 * zone of its own, and the same is true of a companion. So they are handed out separately and the
 * views draw them as one stacked column, commander over companion, pinned where a reader finds it
 * without reading anything. The old argument is kept rather than overruled: the two zones **share**
 * a single column between them, so the width they cost is the width one of them cost before.
 *
 * **Switched off they rail like anything else, and the `isActive &&` half of the first test is the
 * whole of what preserves that.** The exemption above is an argument about a pile that is *in* the
 * deck: `is_active = 0` means the pile counts toward nothing — not size, not copies, not legality
 * — so a switched-off command zone is not a zone the deck is being built around, and pinning it to
 * the top of the desk would give the most prominent place on screen to the one pile the reader has
 * said is not playing. It falls through to exactly the two tests every other switched-off pile
 * takes, and lands in the rail under the Sideboard and the Maybeboard.
 *
 * **Nothing here sorts the rail, and appending is not sorting.** Each of the two runs arrives in
 * the reader's own `sortOrder` and leaves in it — the Sideboard sits above the Maybeboard because
 * that is where the seed put them, and a reader who reorders their categories gets the order they
 * chose, in the rail exactly as in the flow. What the concatenation decides is which of two runs a
 * pile is in, which is the rule above; it re-arranges nothing inside either.
 *
 * **Nothing here sorts `command` either, and that is the same law from its most tempting end.**
 * The two zones leave in the order they arrived, and the order they arrive in is `buildGroups`' —
 * commander then companion, always, in all three grouping modes. Re-deriving it here, even as a
 * two-element swap that would obviously be correct, would be a second place for one rule, and the
 * second place is the one that gets edited without the first. Worse, it would mean this file
 * knowing that a commander is read before a companion, which is a fact about a *deck* — and this
 * is the one file here whose whole discipline is not knowing what a deck is.
 *
 * Generic on a structural `{ kind, isActive }` rather than on `CardGroup`, so this file stays what
 * its header says it is.
 *
 * **Those two words are the whole test, and there is deliberately no grouping-mode check beside
 * them** — not because the other two modes cannot produce a rail or a command zone, but because
 * they are already the honest answer in all three.
 *
 * Under `Group by mana value` and `Group by type`, `buildGroups` buckets only the *active* cards
 * that are not in a command zone, and each bucket it invents carries `kind: null` and
 * `isActive: true` — "Mana value 3" has no rules role and is built from cards that count, so it can
 * never be pinned by any of the three tests. But the derived arm does not stop there, and what it
 * appends is two different things. **The active command zones arrive as themselves**,
 * `categoryGroup` and all, carrying `kind: "commander"` or `kind: "companion"` and
 * `isActive: true` — because a commander bucketed into "Mana value 4" beside three ramp spells says
 * something false about the deck, and a curve drawn with it in is a curve of ninety-nine cards plus
 * one that was never a choice. Those are exactly the two words the first test reads, so the command
 * run comes out the same in all three modes with no mode check to get it. And the derived arm still
 * appends every **switched-off** pile as itself, so those arrive in those modes carrying both words
 * too and this split rails the lot. That is the right answer — they are the same piles, they are
 * still drop targets, and `buildGroups` was already sending them to the right-hand end of the list.
 * It is also the *ordinary* case for the Maybeboard rather than a corner: that pile is seeded
 * switched off, so under a derived grouping it is in the rail by the kind test almost every time.
 *
 * A mode check would be a second place to state what `CardGroup` already carries, and it would get
 * exactly that case wrong: it would flow a pile that ought to stay in the rail, in the two modes
 * where it is the only category on the desk. `groupBy` is also a deck concept, and this is the one
 * file here whose whole discipline is not knowing what a deck is.
 *
 * Order is preserved inside every run — `command`, `flow`, and both of the rail's — and every
 * caller depends on it: `TextView` hands `flow` to `packColumns`, whose whole constraint is the
 * reader's own order; `StackView` maps it straight into the items of a masonry grid, where
 * placement follows document order and never walks back up the page; and the command run is drawn
 * stacked top to bottom, so its order is the only thing on screen saying which of the two zones is
 * the commander. A split that reordered would break all three from outside them, where nothing
 * would be looking.
 */
export function splitRail<T extends { kind: CategoryKind | null; isActive: boolean }>(
  groups: readonly T[],
): { command: T[]; flow: T[]; rail: T[] } {
  const command: T[] = [];
  const flow: T[] = [];
  // The rail's two runs, kept apart until the return so that the kind test cannot be reordered
  // under the switch test by an edit that only meant to tidy the loop. Concatenated in this
  // order and never sorted: see above for why the Maybeboard being seeded switched off is what
  // makes the order matter at all.
  const beside: T[] = [];
  const off: T[] = [];

  for (const group of groups) {
    // `isActive &&` is not a tidiable redundancy: without it a command zone the reader has
    // switched off would be pinned to the top of the desk, which is the one place a pile that
    // counts toward nothing must not be. With it, such a pile falls through to the rail's two
    // tests like any other.
    if (group.isActive && (group.kind === "commander" || group.kind === "companion"))
      command.push(group);
    else if (group.kind === "side" || group.kind === "maybe") beside.push(group);
    else if (!group.isActive) off.push(group);
    else flow.push(group);
  }

  return { command, flow, rail: [...beside, ...off] };
}
