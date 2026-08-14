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
 * header says it is. A **derived** group — "Mana value 3", a heading and nothing more — carries
 * `kind: null` and therefore flows. That is the whole of what grouping by mana value or type
 * changes here: the buckets flow, and the rail is drawn whenever a `side` group still arrives —
 * which one does the moment the reader has switched the Sideboard **off**, since `buildGroups`
 * appends an inactive category as itself, `kind` and all. The mode is not a thing this function
 * can see, and must not become one.
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
