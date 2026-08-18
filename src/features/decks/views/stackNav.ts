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
 * `splitRail(groups)` as `flow` then `rail`, each group's `cards` in the order it already holds
 * them. Nothing here re-derives it: this takes the pile sizes already in that order, so the two
 * cannot disagree about what "the next pile" is. `deckWalk.ts` builds that same order for the
 * printings modal to step through, and the agreement is deliberate — a reader pressing
 * ArrowRight and a reader pressing "next printing" are walking one deck.
 */

/** Where the caret is, or where it is going: a pile in drawn order, and a card in that pile. */
export interface StackPosition {
  /** Which pile, in the order the view draws them — the flow, then the rail. */
  pile: number;
  /** Which card of that pile, in the order the pile already holds them. */
  card: number;
}

/**
 * One arrow press: where the caret goes, or `null` for a press that moves it nowhere.
 *
 * **`null` covers three different nothings on purpose**, because the caller does exactly one
 * thing with all of them — leave the event alone, so the key keeps whatever meaning the browser
 * or a surface above has for it. They are: a key that is not an arrow; a press against a clamp
 * (the top card of a pile, either end of the walk); and a position naming no card at all, which
 * is what a caller holding a stale index has. Telling them apart would hand the caller a branch
 * with nothing different to do in it.
 *
 * **Up and down are clamped inside the pile, and that is not an oversight.** The flow is a
 * masonry — a pile that will not fit on a line starts at the foot of the pile *above* it — so
 * "the pile above this one" is a fact about how wide the window happened to be, and a reader
 * pressing ArrowUp on a pile's top card cannot point at what they would get. Left and right are
 * the only honest way out of a pile, which is why they are the presses that change piles.
 *
 * **Left and right land on the top card (index 0) rather than at the same depth.** Both were on
 * offer and the reader chose this one: the top of a pile is a place that always exists, where
 * "the same depth" is a card a shorter neighbour may not have — and clamping *that* to the last
 * card would make one press mean two different things depending on how deep the pile beside it
 * happened to be.
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
  // each arm because all four would need it, and a caller that read its position out of the DOM
  // can legitimately be holding one: a card removed between the render that drew it and the
  // press that reached this.
  if (at.pile < 0 || at.pile >= sizes.length) return null;
  const held = sizes[at.pile];
  if (at.card < 0 || at.card >= held) return null;

  switch (key) {
    case "ArrowUp":
      return at.card > 0 ? { pile: at.pile, card: at.card - 1 } : null;
    case "ArrowDown":
      return at.card + 1 < held ? { pile: at.pile, card: at.card + 1 } : null;
    case "ArrowLeft":
      return topOfNextPile(sizes, at.pile, -1);
    case "ArrowRight":
      return topOfNextPile(sizes, at.pile, 1);
    default:
      return null;
  }
}

/**
 * The top card of the nearest pile that has one, walking `step` at a time — `null` at the end of
 * the walk, which is the clamp.
 *
 * A loop rather than a `findIndex` over a slice, because the leftward search runs backwards: a
 * reversed slice is two allocations and an index to translate back, for a walk that is a few
 * dozen piles long at the very most.
 */
function topOfNextPile(sizes: readonly number[], from: number, step: 1 | -1): StackPosition | null {
  for (let pile = from + step; pile >= 0 && pile < sizes.length; pile += step) {
    if (sizes[pile] > 0) return { pile, card: 0 };
  }
  return null;
}
