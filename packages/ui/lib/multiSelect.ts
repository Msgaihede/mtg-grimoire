/**
 * What "several cards are picked" means, as arithmetic over strings.
 *
 * A selection is an ordered list of **keys** and an **anchor**, and this module never learns what
 * a key is: the deck editor's is a slot (`"<category>:<card>:<finish>"`, `dnd.ts`'s
 * `deckCardSlot`) and a wall's is a printing id. That is not fastidiousness — the two key spaces
 * are genuinely different shapes, and a module that knew about either would have to know about
 * both. What it knows instead is `order`: the keys currently on the surface, in the order the
 * reader sees them, which is the only fact a range needs.
 *
 * Rust supplies facts and TS draws conclusions ({@link ../../../CLAUDE.md}). Every conclusion about
 * what a modified click means is here, so it can be checked as a truth table with no DOM, no
 * store and no query behind it.
 */

/** An ordered set of picked keys, and where a Shift range measures from. */
export interface Selection {
  /**
   * Insertion-ordered and deduped — **not** sorted into `order`.
   *
   * The order a reader picked things in is a fact worth keeping: it is what makes the *last*
   * picked card the one the detail pane opens on, which is the whole of how the pane and the set
   * stay in agreement. Sorting here would throw that away to buy nothing, since every consumer
   * that cares about screen order has `order` in hand already.
   */
  keys: string[];
  /**
   * The key a Shift range runs from, or `null` before anything has been picked.
   *
   * It moves on a plain or a toggling click and **holds still** through a range, which is what
   * lets a reader Shift-click twice to grow and shrink one run from the same end. That is the
   * behaviour every file manager has, and getting it wrong is the difference between adjusting a
   * range and starting a new one on every press.
   */
  anchor: string | null;
  /**
   * **The list this set is *all of*** — written by Ctrl+A ({@link selectEverything}) and by
   * nothing else, so it is absent on every set a reader built one press at a time.
   *
   * It is what makes "everything" a standing instruction rather than a list of keys. Every wall in
   * this app pages, so the keys on a surface at the moment of the press are a **scroll position**:
   * a set of them would be the first hundred cards of three thousand, drawn as if it were all of
   * them. With this set, {@link settleSelection} answers with the surface's whole order every time
   * it is asked, so a page that lands later is in the set the moment it is drawn.
   *
   * The value is the list's identity — a wall's `listKey` — and not a bare flag, because the
   * instruction is about *that* list. A filter that changes is a different list, and "all of the
   * forty goblins" must not become "all three thousand cards" because the reader cleared the box.
   *
   * Any press ends it: {@link applySelect} builds a fresh set and does not carry this across.
   */
  allOf?: string;
}

/** Nothing picked. A `const` rather than a literal at each call site so identity is stable and a
 *  store write that clears the set is one reference. */
export const EMPTY_SELECTION: Selection = { keys: [], anchor: null };

/**
 * Which of the two chords a press was holding.
 *
 * Both `false` is a plain click, and it is a real case rather than an absence: a plain click
 * *collapses* a set to one card, which is a write.
 */
export interface SelectModifiers {
  /** Ctrl on Windows, ⌘ on a Mac — add or remove this one card. */
  toggle: boolean;
  /** Shift — take everything between the anchor and here. */
  range: boolean;
}

/** Neither chord — spelled once so a caller that means "a plain pick" says so. */
export const PLAIN_PICK: SelectModifiers = { toggle: false, range: false };

/**
 * The chords a mouse or keyboard event was holding.
 *
 * **`metaKey` counts as toggle alongside `ctrlKey`** even though this app ships on Windows only,
 * and that is deliberate rather than aspirational: the frontend runs in a webview and every
 * component test in the repo runs in jsdom, where `userEvent`'s `{Meta>}` is as reachable as
 * `{Control>}`. Refusing ⌘ would be a rule with nothing behind it.
 *
 * Typed structurally rather than as `MouseEvent` because three kinds of event reach it — React's
 * synthetic mouse event, React's synthetic keyboard event, and a native one from a `mousedown`
 * listener — and all three carry these four booleans.
 */
export function readModifiers(event: {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): SelectModifiers {
  return {
    toggle: event.ctrlKey === true || event.metaKey === true,
    range: event.shiftKey === true,
  };
}

/**
 * What a press on `key` does to the selection.
 *
 * `order` is the surface's keys as the reader sees them — the flattened, grouped, sorted deck for
 * the editor, the results array for a wall. It is read for ranges and for nothing else, so a
 * caller with no cheap ordering may pass the keys it has.
 *
 * ## The four cases
 *
 * | Held | Result | Anchor |
 * | --- | --- | --- |
 * | nothing | just this key | this key |
 * | Ctrl | this key toggled in or out | this key |
 * | Shift | the run from the anchor to here, replacing | unchanged |
 * | Ctrl+Shift | that run added to what was there | unchanged |
 *
 * **Shift outranks Ctrl when both are down**, which is Windows Explorer's rule and therefore the
 * one a reader of this app already has. The alternative — treating Ctrl+Shift as a toggle —
 * would make the chord that every file manager uses for "extend the selection" mean the opposite
 * of extending it.
 *
 * ## Two ways a range has no anchor to measure from
 *
 * Nothing picked yet, and an anchor whose row has since left the surface (a filter, a refetch,
 * another surface's delete). Both answer the same way: the range is the single key that was
 * pressed, and that key becomes the anchor. Shift-clicking into an empty wall picks one card
 * rather than doing nothing, which is what a reader who pressed a card expects, and it leaves the
 * surface in a state where the *next* Shift-click is a real range.
 */
export function applySelect(
  selection: Selection,
  key: string,
  order: readonly string[],
  mods: SelectModifiers,
): Selection {
  if (mods.range) {
    const from = selection.anchor !== null && order.includes(selection.anchor) ? selection.anchor : key;
    const run = keysBetween(order, from, key);
    // The anchor holds still through a range so a second Shift-click adjusts the same run from
    // the same end — but a range that had no anchor to measure from has just established one,
    // and `from` is it.
    const anchor = selection.anchor !== null && order.includes(selection.anchor) ? selection.anchor : from;
    if (!mods.toggle) return { keys: run, anchor };
    // Ctrl+Shift adds the run to what was there. `dedupe` keeps the reader's own pick order for
    // everything already in the set and appends only what the run brought.
    return { keys: dedupe([...selection.keys, ...run]), anchor };
  }
  if (mods.toggle) {
    const has = selection.keys.includes(key);
    return {
      keys: has ? selection.keys.filter((k) => k !== key) : [...selection.keys, key],
      // The anchor moves even when the press *removed* the key, and that matches every file
      // manager: Ctrl-clicking a card is a statement about where you are, whichever way the
      // toggle went.
      anchor: key,
    };
  }
  return { keys: [key], anchor: key };
}

/**
 * The run of `order` from one key to another, inclusive, in screen order.
 *
 * Screen order rather than press order: a reader who Shift-clicks upward has selected the cards
 * between the two presses, and which one they pressed first is not something the set should
 * remember. A key that is not in `order` at all cannot bound a run, so the answer is the other
 * one alone — which is how a range against a row that has just been deleted degrades to a pick.
 */
function keysBetween(order: readonly string[], from: string, to: string): string[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a === -1 || b === -1) return order.includes(to) ? [to] : [];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** First occurrence wins, so an existing pick keeps the place the reader gave it. */
function dedupe(keys: readonly string[]): string[] {
  return [...new Set(keys)];
}

/**
 * The selection with everything that is no longer on the surface taken out of it.
 *
 * **A set outlives the list it was made in.** A refetch lands, a filter narrows, another surface
 * deletes a row — and what is left is a set holding keys that address nothing. Left alone those
 * keys are a drag that carries phantom cards and a `Remove 4 cards` that removes three. So every
 * consumer prunes against the order it is currently drawing, on render, and the arithmetic is
 * here rather than in each of them.
 *
 * The anchor is pruned by the same rule and for a sharper reason: a range measured from a key
 * that is gone would run from wherever `indexOf` said, which is `-1`, and slice from the start of
 * the wall. {@link applySelect} guards that case too — two fences, because this one costs a
 * comparison and the failure it prevents is a reader selecting three hundred cards by accident.
 *
 * **Returns the same object when nothing changed**, so a `useMemo` or a store write can compare
 * by identity and a wall that is not selecting anything pays nothing per render.
 */
export function pruneSelection(selection: Selection, order: readonly string[]): Selection {
  const live = new Set(order);
  const keys = selection.keys.filter((k) => live.has(k));
  const anchor = selection.anchor !== null && live.has(selection.anchor) ? selection.anchor : null;
  if (keys.length === selection.keys.length && anchor === selection.anchor) return selection;
  return { keys, anchor };
}

/**
 * Everything on the surface, and everything that joins it — what Ctrl+A does to the selection.
 *
 * `list` names the list being drawn (a wall's `listKey`) and is kept on the set as
 * {@link Selection.allOf}; `order` is what of that list the surface has in hand right now.
 *
 * **The anchor stays where it was** when its row is still there, and is the first key otherwise:
 * a Shift-click after Ctrl+A then measures from the card the reader last pressed, which is what
 * Explorer does, rather than from wherever the top of the wall happens to be.
 *
 * **Nothing to select answers with the selection it was given**, the same object. An empty surface
 * told to hold "all of this list" would pick every card that later arrived on it — a set the
 * reader never saw being made. **So does a set that is already all of it**, which is what makes a
 * second press, and every render of a settled wall, free.
 */
export function selectEverything(
  selection: Selection,
  order: readonly string[],
  list: string,
): Selection {
  if (order.length === 0) return selection;
  const anchor =
    selection.anchor !== null && order.includes(selection.anchor) ? selection.anchor : order[0];
  if (selection.allOf === list && anchor === selection.anchor && sameKeys(selection.keys, order)) {
    return selection;
  }
  return { keys: [...order], anchor, allOf: list };
}

/**
 * The selection as a surface may act on it this render — {@link pruneSelection}, plus the one
 * case pruning cannot answer: a set that is {@link Selection.allOf} a list.
 *
 * | The set is… | Answer |
 * | --- | --- |
 * | built by presses | pruned to `order` |
 * | all of **this** list | the whole of `order`, as it stands now |
 * | all of **another** list | pruned to `order`, and no longer "all of" anything |
 *
 * The third row is a filter changing under a Ctrl+A. What survives is what pruning has always
 * left — the picked cards still on the surface — and the instruction is dropped, so widening the
 * filter again does not sweep in cards the reader never selected. An emptied surface drops it for
 * {@link selectEverything}'s reason.
 *
 * **Returns the same object when nothing changed**, which is {@link pruneSelection}'s promise and
 * is load-bearing for the same reader: `useCardSelection` writes the answer back to the store
 * whenever it is a new object, so an answer that was new every time would be a render loop.
 */
export function settleSelection(
  selection: Selection,
  order: readonly string[],
  list: string,
): Selection {
  if (selection.allOf === undefined) return pruneSelection(selection, order);
  if (selection.allOf !== list || order.length === 0) {
    const { keys, anchor } = pruneSelection(selection, order);
    return { keys, anchor };
  }
  return selectEverything(selection, order, list);
}

/**
 * What Ctrl+A does on a surface drawn as **stacks** — the deck editor's piles (issue #938).
 *
 * `stacks` are the keys of each stack the reader can see, in screen order; a key absent from all
 * of them (a hidden pile's) is never added.
 *
 * | The set is… | Answer |
 * | --- | --- |
 * | empty | still empty |
 * | some keys | those, and every key of each stack holding one of them |
 *
 * **A stack with nothing picked in it is left alone.** A reader who has picked two lands and a
 * creature asked for the lands and the creatures, not the deck: the press widens each set *within*
 * the stack it is in.
 *
 * **And nothing picked picks nothing**, deliberately: `Delete` removes a picked set in the deck
 * editor and undo is one press per card, so a Ctrl+A that took the whole deck from nothing would
 * make `Ctrl+A`, `Delete` a deck emptied in two keys (`docs/reference/keyboard-shortcuts.md`).
 * The whole deck is still one press away, for a reader who has picked a card in every stack.
 *
 * What was picked keeps its place in the set and the anchor stays where it was, so a Shift-click
 * after the press measures from the card the reader last pressed. Nothing to add answers with the
 * selection it was given, the same object, for {@link selectEverything}'s reason.
 *
 * Never "all of" a list: a card added to the deck after the press is not picked by it.
 */
export function selectStacks(
  selection: Selection,
  stacks: readonly (readonly string[])[],
): Selection {
  const picked = new Set(selection.keys);
  const widened = stacks.filter((stack) => stack.some((key) => picked.has(key))).flat();
  const keys = dedupe([...selection.keys, ...widened]);
  if (keys.length === selection.keys.length) return selection;
  return { ...selection, keys };
}

/** The same keys in the same order. */
function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i]);
}

/**
 * Whether a drag from `key` should carry the whole set.
 *
 * **Only when the card being dragged is in it**, which is the rule every file manager applies and
 * the one thing about multi-drag a reader will get wrong if it is not: picking up an *unselected*
 * card while four others are highlighted has to move that one card, or a stray drag rearranges
 * four cards the reader had forgotten were picked. The caller collapses the set to that card when
 * this answers `false`.
 *
 * A set of one is not a group. It would behave identically — one payload either way — but it
 * would draw the count chip, and `1 card` on a preview is an app telling the reader something
 * they can already see.
 */
export function dragsWholeSelection(selection: Selection, key: string): boolean {
  return selection.keys.length > 1 && selection.keys.includes(key);
}
