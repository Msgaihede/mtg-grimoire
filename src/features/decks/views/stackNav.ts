/**
 * Where an arrow key puts the caret in `StackView` — the whole movement, as arithmetic over how
 * many cards each pile holds.
 *
 * **A module of its own because the movement is not a fact about the DOM.** The view's handler
 * has real work to do that only a browser can answer — which card the press came from, which
 * button to hand the caret to, whether a text field wanted the key — and none of that is the
 * *rule*. The rule is two integers and a keyname, so it is written here where a test can drive
 * every corner of it without mounting a deck, and `StackView` is left holding only the half that
 * needs a document.
 *
 * **The order it walks is the order the view draws**, which `StackView` derives from
 * `splitRail(groups)` as `command`, then `flow`, then `rail` — the command zones being the pinned
 * pair at the head of the desk — each group's `cards` in the order it already holds them. Nothing
 * here re-derives it: this takes the pile sizes already in that order, so the two cannot disagree
 * about what "the next card" is. `deckWalk.ts` builds that same order for the printings modal to
 * step through, and since 2026-08-21 the agreement is exact rather than merely compatible: a
 * reader pressing ArrowRight on the desk and a reader pressing ArrowRight inside the modal take
 * **the same step to the same card**, because both are now walking one flat list of every row in
 * the deck.
 */

/** Where the caret is, or where it is going: a pile in drawn order, and a card in that pile. */
export interface StackPosition {
  /** Which pile, in the order the view draws them — the command zone, then the flow, then the
   *  rail. */
  pile: number;
  /** Which card of that pile, in the order the pile already holds them. */
  card: number;
}

/**
 * One arrow press: where the caret goes, or `null` for a press that moves it nowhere.
 *
 * **Left and right step one card, and the pile boundary is not a stop** (changed 2026-08-21,
 * [#178](https://github.com/Msgaihede/mtg-grimoire/issues/178)). Right off the last card of a
 * pile lands on the **first** card of the next one that has any, left off the first card lands on
 * the **last** card of the previous one — so the two keys walk the whole deck, one card at a
 * time, in the order the desk draws it. That is what the reader asked for and it is what the
 * printings modal already did: two keys are the whole gesture, and there is no second axis to
 * learn or to lose your place on.
 *
 * They used to move a **pile** at a time and land on its top card, with up and down running
 * through the pile the caret was in. The old rule needed a paragraph about masonry to explain why
 * it was the shape it was; this one needs none, which is most of the argument for it.
 *
 * **Up and down are not handled at all — no branch, no answer, nothing** — and the absence is
 * deliberate rather than an omission. This view is given no height of its own: the piles wrap and
 * `DeckEditor`'s page scroller is the one thing that scrolls, so what is under those two keys on
 * a focused card is the page's own scrolling, which is exactly what a reader pressing them on a
 * wall of card art wants. Answering `null` here is what leaves the press alone.
 * `AllPrintingsDialog` states the same thing the same way: "up does nothing" would be a claim,
 * and leaving the keys alone is the absence of one.
 *
 * **`null` covers three different nothings on purpose**, because the caller does exactly one
 * thing with all of them — leave the event alone, so the key keeps whatever meaning the browser
 * or a surface above has for it. They are: a key this movement does not answer, which is now
 * every key but two; a press against a clamp at either end of the walk; and a position naming no
 * card at all, which is what a caller holding a stale index has. Telling them apart would hand
 * the caller a branch with nothing different to do in it.
 *
 * **A pile holding no cards is skipped**, because `CardStack` draws nothing at all for one: an
 * empty pile is a heading and the words "Nothing here yet." Landing on it would put the caret on
 * a card that is not there, which is the one answer this function must never give.
 *
 * @param sizes how many cards each drawn pile holds, in drawn order
 * @param at where the caret is now
 * @param key the `KeyboardEvent.key` of the press
 */
export function nextStackPosition(
  sizes: readonly number[],
  at: StackPosition,
  key: string,
): StackPosition | null {
  // A position that names no card is not a position to move from. Checked here rather than in
  // each arm because both would need it, and a caller that read its position out of the DOM can
  // legitimately be holding one: a card removed between the render that drew it and the press
  // that reached this.
  if (at.pile < 0 || at.pile >= sizes.length) return null;
  const held = sizes[at.pile];
  if (at.card < 0 || at.card >= held) return null;

  switch (key) {
    case "ArrowLeft":
      // Inside the pile while there is a card above; otherwise out of its head and onto the
      // *foot* of the pile before it, which is what makes the two directions each other's undo.
      return at.card > 0 ? { pile: at.pile, card: at.card - 1 } : edgeOfNextPile(sizes, at.pile, -1);
    case "ArrowRight":
      return at.card + 1 < held
        ? { pile: at.pile, card: at.card + 1 }
        : edgeOfNextPile(sizes, at.pile, 1);
    default:
      return null;
  }
}

/**
 * The near edge of the nearest pile that holds a card, walking `step` at a time — `null` at the
 * end of the walk, which is the clamp.
 *
 * **"Near" is what makes the walk reversible**: stepping right enters a pile at its first card
 * and stepping left enters it at its last, so a reader who presses one key and then the other is
 * back on the card they started on. Enter both from the top and left would strand them a pile
 * further back every time they changed their mind.
 *
 * A loop rather than a `findIndex` over a slice, because the leftward search runs backwards: a
 * reversed slice is two allocations and an index to translate back, for a walk that is a few
 * dozen piles long at the very most.
 */
function edgeOfNextPile(
  sizes: readonly number[],
  from: number,
  step: 1 | -1,
): StackPosition | null {
  for (let pile = from + step; pile >= 0 && pile < sizes.length; pile += step) {
    if (sizes[pile] > 0) return { pile, card: step === 1 ? 0 : sizes[pile] - 1 };
  }
  return null;
}
