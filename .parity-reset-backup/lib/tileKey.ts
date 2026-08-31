/**
 * A collection tile's identity — `` `${cardId}:${finish}` `` — and the **one** place in the app
 * that string is spelled.
 *
 * ## Why it is a function, and why it is here
 *
 * This app draws the reader's collection as art on two walls: the collection page's, and the deck
 * editor's docked Collection tab. Both fold rows into tiles at the grain *printing **and**
 * finish* — a foil and a played nonfoil are two objects at two prices sharing only a set and a
 * number — so on both, two tiles carry one card id and the wall's ring, arrow walk and picked set
 * all key on this instead (`CardGrid`'s `GridCard.key`).
 *
 * **Four callers, and they are the two ends of a ring, twice over.** Each wall's fold stamps this
 * on every tile it emits; each wall then builds the same string out of the card the pane is
 * showing and the finish it was opened as, for `CardGrid`'s `selectedId`. Both ends are plain
 * `string` and **nothing in the type system relates them**, so a change to one spelling that
 * missed the other would be a wall where pressing a tile rings nothing at all — silently, with no
 * type to catch it and nothing red. That is the defect this shape exists to prevent, and it is
 * why the default below lives here rather than at any call site.
 *
 * **`src/lib/` rather than either feature.** The two folds sit in `features/collection` and
 * `features/decks`, and an import between them would be a dependency in the wrong direction for
 * one of the pair whichever way it went — the deck editor's fold lives in the decks tree for
 * historical reasons rather than because the idea belongs there. It was written out twice, byte
 * for byte, before this module existed: two identical functions, each with a doc block arguing
 * that duplication is what must not happen. That is the joke this file ends.
 *
 * ## `?? "nonfoil"` is what makes the two ends meet
 *
 * A tile always names a finish; the pane's `paneFinish` is `Finish | null`, and its `null` means
 * "no surface named a finish" — which, on a wall where every tile names one, is the plain copy.
 * So the default belongs to the *reading* end and is spelled once, here, for both walls.
 *
 * **One consequence, taken knowingly.** `collection_entries.finish` is TEXT with a CHECK rather
 * than an enum this side knows, so a row can arrive spelling a finish this build cannot name. Its
 * tile keys as itself (`bolt:galaxy`) while the ring composite can only ever spell `bolt:nonfoil`
 * — the press hands the pane a narrowed `Finish | null`, which has no way to carry that word back.
 * So pressing such a tile does not merely fail to ring it: it opens the card with no finish named
 * and **rings the plain tile beside it**, or nothing where the reader holds no plain copy. That is
 * strictly better than the state before the split, where no tile of a printing was distinguishable
 * from any other, and under the CHECK constraint it describes 0 rows.
 */
export function tileKeyOf(cardId: string, finish: string | null): string {
  return `${cardId}:${finish ?? "nonfoil"}`;
}
