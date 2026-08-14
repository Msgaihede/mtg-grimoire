/**
 * How the two column views arrange a deck's groups — which ones flow, and which share a column.
 *
 * The stack and the text view both lay a deck out as columns read left to right, and both
 * face the same question: a deck has fifteen categories and a column fits two or three of
 * them. The answer is a **greedy pack in the reader's own order** — never a re-ordering, and
 * never a split.
 *
 * Order is the whole constraint. A balanced packer (longest-first, or a bin-packing pass)
 * fits more into fewer columns and puts the Sideboard between Ramp and Removal, which is a
 * deck list nobody can find anything in. `sortOrder` is the reader's, so it survives.
 *
 * The height is measured rather than guessed by the caller: the stack's groups have exact
 * pixel heights (`stackHeight`) and the text view's are a row count times a row pitch, so
 * this takes the measurement as a function and knows nothing about either.
 *
 * `splitSideboard` is the one thing here that reads a deck at all, and it reads exactly one
 * word of it. Everything else stays ignorant of what a group is.
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
 * How a test finds the rail the Sideboard is drawn in. An attribute rather than a role, for the
 * reason `STACK_COLUMN_ATTR` is one: which side of the desk a group was drawn on is a *layout*
 * and says nothing to a reader who cannot see it, so there is no role to give it and no
 * accessible name to search by.
 *
 * **The rail carries this and nothing else.** It is not also a `STACK_COLUMN_ATTR` box: that
 * attribute means "a box `packColumns` produced", and the rail is by construction the one box it
 * did not — the split above runs *before* the pack. One element answering both would make every
 * sweep that counts columns count a box the packer never made. The name is unprefixed for the
 * same reason it lives here: `TextView` draws the same rail, and a `STACK_`-prefixed constant in
 * that file would be the wrong word in the right place.
 */
export const SIDEBOARD_ATTR = "data-sideboard-rail";

/**
 * The groups that flow, and the ones that are pinned to the right.
 *
 * `kind === "side"` and nothing else: the name is the user's — `DECK_CATEGORY_GRAIN` is
 * `(deck_id, name)`, so they may call any pile of their own "Sideboard" and rename the real one
 * to anything — and the kind is what the rules read. A split on the heading would pin somebody's
 * homebrew to the right and leave the sideboard the format actually knows about buried in the
 * pack, which is the failure this whole arrangement exists to remove.
 *
 * Generic on a structural `{ kind }` rather than on `CardGroup`, so this file stays what its
 * header says it is.
 *
 * **`kind === "side"` is the whole test, and there is deliberately no grouping-mode check beside
 * it** — not because the other two modes cannot produce a rail, but because `kind` is already the
 * honest answer in all three.
 *
 * Under `Group by mana value` and `Group by type`, `buildGroups` buckets only the *active* cards,
 * and each bucket it invents carries `kind: null` — "Mana value 3" has no rules role, so it can
 * never be pinned. But the derived arm does not stop there: it appends every **switched-off** pile
 * as itself, `categoryGroup` and all, so a Sideboard the reader has switched off arrives in those
 * modes still carrying `kind: "side"` and this split still sends it to the rail. That is the right
 * answer — it is the same pile, it is still a drop target, and `buildGroups` was already sending
 * it to the right-hand end of the list — and reading it off `kind` is what gets it right for free.
 *
 * A mode check would be a second place to state what `CardGroup` already carries, and it would get
 * exactly that case wrong: it would flow a pile that ought to stay in the rail, in the two modes
 * where it is the only category on the desk. `groupBy` is also a deck concept, and this is the one
 * file here whose whole discipline is not knowing what a deck is.
 *
 * Order is preserved inside both halves. `packColumns` is handed `flow` and its whole constraint
 * is the reader's own order, so a split that reordered would break the packer's contract from
 * outside it, where nothing would be looking.
 */
export function splitSideboard<T extends { kind: CategoryKind | null }>(
  groups: readonly T[],
): { flow: T[]; sideboard: T[] } {
  const flow: T[] = [];
  const sideboard: T[] = [];

  for (const group of groups) {
    if (group.kind === "side") sideboard.push(group);
    else flow.push(group);
  }

  return { flow, sideboard };
}
