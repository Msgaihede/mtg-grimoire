/**
 * Who owns ArrowLeft and ArrowRight when a card surface would otherwise walk the list.
 *
 * **Two surfaces step a card walk with the arrows now** — `AllPrintingsDialog` and
 * `CardDetailModal` — and this is the predicate both ask before treating a press as a step. It
 * was `AllPrintingsDialog`'s private one until the modal grew the same keys on 2026-09-03; a
 * second copy would have been two lists of exempt controls to keep in agreement, and the whole
 * failure this guards is a control quietly falling off one of them.
 *
 * **The case it exists for is `<select>`.** ArrowLeft on a focused `<select>` changes its value
 * in Chromium and in WebView2 with it — so a reader narrowing a wall by set would step to the
 * next card instead, or step *and* re-sort, depending on the engine. `<input>`, `<textarea>` and
 * a `contenteditable` are here for the same reason one rung along: the arrows move a caret, and a
 * caret's owner has the better claim.
 *
 * **A third predicate rather than a widening of one of the two that exist**, which is
 * `src/CLAUDE.md`'s standing rule about `isTextField` and `isTextEntry`: those answer *does the
 * browser's own context menu survive here* and *does an open menu panel yield its keys to a
 * caret*, and this answers *does this control own the arrow keys*. `<select>` is the one element
 * where the three genuinely disagree, and it is the one this exists for.
 *
 * **`select` is the original clause and is now the dead one.** `PrintingsFilterBar`'s controls
 * became `Dropdown`s on 2026-08-26, so what has to be exempted is a dropdown's two shapes
 * instead: the **trigger** while its panel is open — ArrowLeft/ArrowRight there belong to the
 * control the reader is inside, not to the walk — and anything **inside the panel**, which is
 * where the caret actually sits. `select` stays in the list because the app may grow one back,
 * and a stale clause that matches nothing costs nothing.
 */
const ARROW_OWNERS =
  "input, textarea, select, [contenteditable=''], [contenteditable='true']," +
  '[aria-haspopup="listbox"][aria-expanded="true"], [role="listbox"]';

/**
 * Does the pressed-on element own the arrow keys?
 *
 * `closest` rather than a tag test, because the press lands on whatever is under the caret and a
 * `contenteditable` region is a tree.
 */
export function ownsArrowKeys(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(ARROW_OWNERS) !== null;
}
