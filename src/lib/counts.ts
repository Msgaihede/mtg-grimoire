/**
 * Counting, in words: a number with its thousands separators, and a unit that agrees with it.
 *
 * Two functions, no imports. There were four `plural`s with three incompatible signatures
 * (`FolderTree`, `auditText`, `DeckHistoryDialog`, `ClearCategory`) and the thousands separator
 * was written out character for character nine times — which is the shape of thing that reads
 * as one rule until two surfaces on one screen disagree about it.
 *
 * **`SearchPage`'s `countOf` is not a caller and must not become one.** Its condition is
 * `total === 1 && !capped`, because the backend stops counting at 5 000 and `5,000+ card` must
 * never print. That is a rule about a capped count rather than about English.
 */

/**
 * A number as the app writes one: `1,196`, `116,703`.
 *
 * `"en-US"` explicitly rather than the host locale, because every other number this app prints
 * — prices through `formatPrice`, dates through the `Intl` formatters in `auditText` and
 * `DeckHistoryDialog` — is pinned the same way, and a figure that changed separator with the
 * machine would make one screen disagree with the next.
 */
export function count(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * `1 card`, `2 cards`, `1 category`, `2 categories`.
 *
 * The app must never print "1 cards". The irregular plural is **passed rather than derived** —
 * teaching this English is a much larger promise than the four sentences that need it, and the
 * one caller that tried to route around a missing `many` (`ImportDeckDialog`'s `categoryCount`,
 * deleted 2026-08-16) was solving a problem the default argument had already solved.
 *
 * The number is written plainly rather than through {@link count}: every caller counts cards,
 * lines, piles or folders in a deck, and none of them reaches four figures. A caller that does
 * wants `${count(n)} ${…}` and its own thought about it.
 */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
