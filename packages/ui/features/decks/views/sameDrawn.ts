import type { CardGroup } from "../grouping";

/**
 * **Whether a memoised drawing of one pile would draw the same thing twice** — the comparator
 * `React.memo` is handed by `CardStack` and by each view's per-pile component (issue #557).
 *
 * ## Why shallow equality is not enough here, and what this adds to it
 *
 * Every keystroke in the deck's filter box rebuilds `groups`: `buildGroups` runs over the
 * narrowed rows and answers a **fresh `CardGroup` per pile, each with a fresh `cards` array** —
 * including the piles the keystroke did not narrow at all. React's default comparison is
 * `Object.is` per prop, so a pile of forty creatures that "land" took nothing from would still be
 * handed a new `group` and a new `cards`, and every card in it would be drawn again for a letter
 * that changed nothing about it. That was the measured shape of the editor before the split: one
 * keystroke re-rendered every stack on the desk.
 *
 * What does **not** change across that rebuild is the cards themselves. `buildGroups` files and
 * sorts the rows it was handed and copies none of them, and the rows are `deck.cards`' own
 * objects, which only a re-read of the deck replaces. So two arrays holding the same row objects
 * in the same order are the same pile as far as anything drawn from them is concerned — and that
 * is the one widening this makes: **an array prop is compared by its elements**, and a prop named
 * `group` is compared field by field with its `cards` compared the same way. Every other prop is
 * still `Object.is`, so a callback or a lookup that is a new object is still a new prop.
 *
 * ## What it is not
 *
 * It is not a deep equality, and must not become one. A row object a re-read replaced is a new
 * row even when every field reads the same — a deck re-read is exactly when a card's price, its
 * owned count or its finish may have moved, and a comparator that walked into the row would be
 * the thing that left a stale number on screen. Identity of the rows is the contract; the arrays
 * and the group around them are only the packaging the rebuild threw away.
 */
export function sameDrawnProps(prev: object, next: object): boolean {
  return sameFields(prev, next, (key, a, b) =>
    key === "group" ? sameGroup(a as CardGroup, b as CardGroup) : sameValue(a, b),
  );
}

/**
 * One pile against its rebuild — every field `Object.is`, and the `cards` array (or any other
 * array a later field adds) by its elements. Field by field rather than naming the fields, so a
 * field `CardGroup` grows tomorrow is compared without anybody remembering this function.
 */
export function sameGroup(a: CardGroup, b: CardGroup): boolean {
  if (a === b) return true;
  return sameFields(a, b, (_key, left, right) => sameValue(left, right));
}

/** Two arrays holding the same items in the same order — `Object.is` per slot. */
export function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (!Object.is(a[index], b[index])) return false;
  }
  return true;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  return Array.isArray(a) && Array.isArray(b) && sameItems(a, b);
}

/**
 * The two objects carry the same own keys and `same` holds for each. A key present on one and
 * absent on the other is a difference even when its value is `undefined` — an optional prop going
 * from absent to present is a prop the component may branch on (`hidden`, `tokenSlot`).
 */
function sameFields(
  a: object,
  b: object,
  same: (key: string, left: unknown, right: unknown) => boolean,
): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  // `Object.prototype.hasOwnProperty` rather than `Object.hasOwn`, which is ES2022 and outside the
  // `lib` this program is typed against (`tsconfig.base.json` adds only `ES2022.Error`).
  return keys.every(
    (key) => Object.prototype.hasOwnProperty.call(right, key) && same(key, left[key], right[key]),
  );
}
