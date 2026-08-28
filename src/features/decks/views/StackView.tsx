/**
 * The deck as stacks of cards in columns — the default view, and the one the redesign is
 * built around.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { GripVertical } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { keepCaretForCard } from "@/lib/caretWalk";
import { DROP_MARK_ROOM, DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import { FOCUS } from "@/lib/focus";
import type { DeckCard } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { useAppStore } from "@/lib/store";
import { useCardZoomGesture } from "@/lib/useCardZoomGesture";
import { cn } from "@/lib/utils";
import { CardStack, STACK_CARD_BORDER, stackCardWidth, stackLiftRoom } from "../CardStack";
import {
  CARD_BODY_ATTR,
  deckGroupMenuProps,
  deckGroupProps,
  deckGroupRename,
  useCategoryDrop,
  type DeckCardActions,
} from "../cardControl";
import { useCategoryDragSource, useCategoryReorderDrop } from "../categoryDrag";
import { deckCardSlot, DECK_CARD_ATTR } from "../dnd";
import { DropIndicator } from "../DropIndicator";
import type { CardGroup } from "../grouping";
import type { ValidationIssue } from "../validation/types";
import { RAIL_ATTR, splitRail } from "./columns";
import { GroupHeader } from "./GroupHeader";
import { nextStackPosition, type StackPosition } from "./stackNav";

/**
 * The group section's own `p-1.5`, one side — 6px, read off the class below.
 *
 * It does not zoom, and neither does the hairline beside it: padding and a border are chrome
 * *around* a card rather than part of one, and a reader who asks for bigger cards is not asking
 * for a thicker gutter. That is why {@link stackColumnWidth} adds them rather than scaling 224.
 *
 * **That hairline is the section's own and it is `border-transparent` at rest** (changed
 * 2026-08-14 — `StackGroup` has the whole of why). It used to be called "the card's border" here,
 * which was wrong even before it stopped painting: `STACK_CARD_BORDER` is a length, and the two
 * edges the sum below reserves are drawn by the `<section>`, not by anything inside it. A border
 * that paints nothing still occupies its 1px, so the box the arithmetic depends on is intact —
 * but that is only true while the *class* survives. Clearing the colour is the change that was
 * made; deleting the class is the one that would make every card 2px wider than
 * `stackCardWidth()` says it is.
 */
const SECTION_PADDING = 6;

/**
 * How wide one pile's box is at this zoom — **the card, plus the chrome the card sits in**.
 *
 * "Column" survives in the name because that is the shape of the box: a pile is one card wide and
 * as tall as its stack. What it no longer means is *a box several groups share* — see
 * {@link STACK_ATTR}, where the pack that used to fill one went.
 *
 * The direction of this derivation is the whole of what makes the view survive a zoom, and it is
 * the reverse of what it used to be. The column was a fixed `14rem` off the design canvas (224px,
 * which a 1280px window fits five of beside the stats panel) and `CardStack` subtracted the
 * padding and the borders from it to learn what a card was. Now the card is the given —
 * `stackCardWidth(zoom)` — and the column is whatever holds it.
 *
 * Two numbers scaled independently would agree at 1× and drift everywhere else: at 1.1 a column
 * of `round(224 × 1.1) = 246` around a card of `round(210 × 1.1) = 231` leaves 15px of padding
 * where the classes draw 14, and the card would be stretched a pixel wider than the height its
 * own aspect ratio was computed from. Derived, the two cannot disagree at any stop on the ladder.
 *
 * At 1× it is 210 + 12 + 2 = 224, which is the `14rem` this replaced, exactly.
 *
 * **The `2 × STACK_CARD_BORDER` term is the `<section>`'s own hairline, and it is transparent.**
 * It is a real 1px of border box either side whether or not a line is painted in it, so the
 * width did not move when `StackGroup` stopped drawing the outline. Worth stating because the
 * term now names a length nobody can see: it is a *box*, not a decoration, and it is what keeps
 * the card inside filling exactly {@link stackCardWidth}.
 */
export function stackColumnWidth(zoom: number): number {
  return stackCardWidth(zoom) + 2 * SECTION_PADDING + 2 * STACK_CARD_BORDER;
}

/**
 * The row the flowing grid is ruled in, in pixels — and it is 1 so that **a span is a height**.
 *
 * The flow is a grid of `stackColumnWidth` tracks whose rows are one pixel each, and a pile claims
 * as many of them as it is tall ({@link flowRowSpan}). That is what turns CSS Grid's ordinary
 * row-major placement into a masonry: with every row a pixel, "the next free cell at or after the
 * cursor" is "the foot of the shortest pile that is not in the way", so a pile that wraps lands
 * directly **under the pile above it** rather than under the tallest pile on a shared line.
 *
 * A coarser rule (4px, say) would cut the implicit row count fourfold and put up to 3px of slop
 * between two piles in a column. The row count a pixel costs is the height of the tallest column
 * in the deck, which is the same order as the pixels already being laid out; it is the first thing
 * to trade away if this view is ever measured as slow, and nothing has measured it yet.
 */
const FLOW_ROW = 1;

/**
 * The gutter between two piles in the same column, in pixels — the `gap-y-5` this view had when
 * the flow was a wrapping flex box, drawn a different way.
 *
 * **It cannot be a `row-gap` any more and that is arithmetic, not taste.** A grid gap is drawn at
 * every row boundary an item *crosses*, so a pile spanning 400 one-pixel rows would carry 399
 * gutters inside itself. The row gap is therefore zero and the gutter is added to each pile's own
 * span, which puts it exactly once under each pile. The visible cost is one trailing gutter at the
 * foot of every column — 20px of slack under the last pile, on top of the root's `pb-2`.
 */
const FLOW_GAP_Y = 20;

/**
 * The gutter under the whole view, in pixels — the `pb-2` this used to be written as.
 *
 * A number rather than a class because {@link stackLiftRoom} is added to it, and a Tailwind
 * `pb-*` and an inline `padding-bottom` do not add up: the inline one simply replaces it. Kept at
 * 8 rather than folded into {@link DROP_MARK_ROOM}'s 6 because the foot of a column is the one
 * edge that was never the drop marks' problem — see the root's own note.
 */
const ROOT_GUTTER = 8;

/**
 * How many rows of the flowing grid a pile of this pixel height claims — its height, plus the one
 * gutter under it.
 *
 * `Math.ceil` because a measured height is fractional and a span is an integer: rounding *up* is
 * the only safe direction, since a span a pixel short would let the pile below it start a pixel
 * inside this one. `Math.max(1, …)` because `grid-row: span 0` is invalid and would be dropped,
 * and because **jsdom measures every box as 0** — a suite that never sees a layout still has to
 * produce a legal span.
 */
export function flowRowSpan(height: number): number {
  return Math.max(1, Math.ceil(height) + FLOW_GAP_Y);
}

/**
 * A pile's own height, measured, as a row span for the flowing grid — `null` until it has been.
 *
 * **The measurement is of the pile, never of the box the piles are in**, which is the distinction
 * that lets this exist beside the rule stated on `TextView`'s flowing box: a view has no business
 * observing *its own* box, because a second reading of the box it is laid out in answers a frame
 * behind the layout it is reacting to. Nothing here reads the desk. How many columns fit is still
 * CSS's answer — `repeat(auto-fill, …)`, which needs no number from us — and what a pile measures
 * cannot be derived from it: a heading wraps or it does not, and only the browser knows.
 *
 * **There is no feedback loop, and `align-items: start` is what forbids one.** A grid item aligned
 * to the start of its area is sized by its content, so a pile's height does not depend on the span
 * we give it; the span depends on the height and never the other way round. Stretch it — the
 * default — and this would oscillate.
 *
 * The read is a `useLayoutEffect` on **every** render rather than a dependency list, so a span is
 * never a frame behind the thing that changed it: a card added, a zoom step, a filter. It runs
 * before paint, so the first frame a pile is drawn in already has its right span. The
 * `ResizeObserver` beside it is for the changes no render of this component causes — the desk
 * narrowing under a dragged search panel until a heading wraps, a font arriving late.
 *
 * `enabled` is false in the rail, which is a `flex-col` box where a grid row means nothing: the
 * piles there are plain blocks and measuring them would be a rect read and a state update per
 * render for a number nobody would use.
 */
function useFlowRowSpan(enabled: boolean) {
  // The name has to end in `Ref` — `react-hooks/immutability` refuses a write to anything else a
  // hook returned. It is the mirror of `useCategoryDrop`'s `attach`, which must *not* be called
  // `ref` because the same plugin would then read every use of it as a ref access during render.
  const elementRef = useRef<HTMLElement | null>(null);
  const [span, setSpan] = useState<number | null>(null);

  const read = useCallback(() => {
    const node = elementRef.current;
    if (!node || !enabled) return;
    // Setting the value it already holds is a bail-out in React, so the every-render read costs
    // one extra pass only when the pile has actually changed height.
    setSpan(flowRowSpan(node.getBoundingClientRect().height));
  }, [enabled]);

  useLayoutEffect(read);

  useEffect(() => {
    const node = elementRef.current;
    if (!node || !enabled) return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, read]);

  return { elementRef, span };
}

/**
 * Everything an arrow key may not be answered from — a text field the press belongs to, and the
 * desk, which is not a card.
 *
 * A pile heading goes into rename mode with a live `<input>` inside this view (see
 * `deckGroupRename`), and an arrow in a field is the caret moving through text. `closest` rather
 * than a tag test on the target, because the press lands on whichever leaf the caret is in — and
 * `[contenteditable]` is here for completeness rather than for a call site: nothing in this view
 * draws one, and a rule that only listed what exists today is a rule that goes wrong quietly.
 */
const NOT_THE_CARET = "input, textarea, select, [contenteditable]";

/**
 * Where in the walk the card carrying `slot` is, or `null` for a slot this view is not drawing.
 *
 * **The slot is the address, never a DOM index.** `deckCardProps` stamps `DECK_CARD_ATTR` on
 * every card's button and `dnd.ts` owns both ends of the spelling, so the question "where is the
 * caret" is answered against the same array the movement is computed over — rather than by
 * counting buttons, which would answer about the *drawn* order of a grid whose placement is
 * CSS's and whose piles are two boxes.
 *
 * `null` is a real answer and the caller acts on it: a card can leave the deck between the render
 * that drew it and the press that reached here (a stepper reaching zero removes the row), and a
 * press with nowhere to move from is a press this view leaves alone.
 */
/**
 * The slot the caret is standing on, or `null` for a press that started nowhere in particular.
 *
 * **Two elements of a card can hold the caret and only one of them carries the address.**
 * `DECK_CARD_ATTR` is stamped on the card's *button* — the art — and that is what a `closest`
 * from the caret finds in the ordinary case. But a card's outermost element is a `<li>` carrying
 * `CARD_BODY_ATTR` and `tabIndex={-1}`, and it takes the caret by two routes a reader really
 * uses: `ContextMenu` hands it back there after a row runs or Escape closes, and a click on the
 * card's **data line** — a sibling of the button, not a child — lands on it as the nearest
 * focusable ancestor. From there the button is a *descendant*, so `closest` finds nothing and the
 * arrows did nothing at all. Reported as the window eating the caret; measured 2026-08-19.
 *
 * **`from === body` and not `from.closest(body)`**, which is the difference between reading the
 * caret's own element and reading anything inside a card. The stepper's `+` and `−` and the
 * quick-add all sit inside that same `<li>`, and a press on one of those is about that control —
 * the field guard cannot see a `<button>`, so widening this is how the arrows would come to move
 * the deck's selection out from under a reader adjusting a quantity.
 */
function caretCardSlot(from: Element): string | null {
  const onButton = from.closest(`[${DECK_CARD_ATTR}]`);
  const body = from.hasAttribute(CARD_BODY_ATTR) ? from : null;
  const card = onButton ?? body?.querySelector(`[${DECK_CARD_ATTR}]`) ?? null;
  return card?.getAttribute(DECK_CARD_ATTR) ?? null;
}

function stackPositionOf(walk: readonly CardGroup[], slot: string): StackPosition | null {
  for (let pile = 0; pile < walk.length; pile += 1) {
    const card = walk[pile].cards.findIndex(
      (c) => deckCardSlot(c.categoryId, c.cardId, c.finish) === slot,
    );
    if (card !== -1) return { pile, card };
  }
  return null;
}

/**
 * Put the caret on a card's own button and bring it into view.
 *
 * Found by the slot rather than held as a ref, for `deckCardProps`' reason: the cards are not
 * virtualised, so the button is already in the DOM, but which element stands for a row is a
 * question only the document can answer after a write has replaced it. The search is scoped to
 * this view's root, which is stronger than the pane's document-wide one — two deck views are
 * never mounted together today, and this is not the place to depend on that.
 *
 * **`block: "nearest"` against the *page*, and the distinction is load-bearing since
 * 2026-08-14**: this view is deliberately no longer its own scroll container — it is given no
 * height, the piles wrap, and `DeckEditor`'s page scroller is the one thing that scrolls (the
 * root element's own comment carries the whole of why). So there is no local scrollport to
 * scroll a card inside, `nearest` asks for the least page movement that puts the card on screen,
 * and a card already visible moves nothing at all. `preventScroll` on the focus is what stops
 * the browser doing its own scroll first, by a different rule, on the way.
 *
 * The optional call is jsdom's: it lays nothing out and leaves `scrollIntoView` undefined, which
 * is `SetCombobox`' spelling for the same reason rather than a doubt about the browser.
 */
function focusStackCard(root: HTMLElement, card: DeckCard): void {
  const slot = deckCardSlot(card.categoryId, card.cardId, card.finish);
  const button = root.querySelector<HTMLElement>(`[${DECK_CARD_ATTR}="${slot}"]`);
  if (!button) return;
  button.focus({ preventScroll: true });
  button.scrollIntoView?.({ block: "nearest" });
}

/**
 * How a test finds one pile's box in the flow. An attribute rather than a role, because where a
 * pile was drawn is a *layout* and carries no meaning for a reader. `DropIndicator`'s
 * `DROP_LINE_ATTR` and `cardControl`'s `DECK_GROUP_ATTR` are the same idea for the same reason.
 *
 * **It marks one pile, not a box several piles share, and that is the change of 2026-08-14.**
 * The flowing half of this view used to be `packColumns`' answer — groups packed into columns of
 * a measured height, each column a box, opening a new one when the next group would not fit under
 * the last. That pack is gone from this view: **every pile is now an item of one grid**, left to
 * right in the reader's own order, dropping to the next line when it runs out of width. The reason
 * is a bug a reader could see and the pack could not: a column height is a fact about the *desk*,
 * and the pack knew nothing about the desk's **width** — so a tall window filled three columns to
 * the brim and left half the desk empty beside them, while the same deck in a shorter window
 * spread across six. The width is what a reader is looking at, and CSS is already measuring it.
 *
 * **A wrapping flex box was the first answer and it left half the bug standing**, which is the
 * change of 2026-08-15. A flex line is as tall as the tallest item in it, so one forty-card
 * Creature pile made the whole line 1 500px tall and every short pile beside it sat over that much
 * blank desk — the reader's own screenshot of exactly what the pack had been doing, arriving by
 * the other axis. The flow is a **masonry** now: a grid of one-pixel rows in which each pile spans
 * its own height ({@link flowRowSpan}), so a pile that wraps starts at the foot of the pile above
 * it. Nothing about the order moved — the piles are still the reader's `sortOrder` in the DOM, and
 * grid placement never walks backwards up the page — so reading order, tab order and what a screen
 * reader hears are what they were.
 *
 * **Neither the rail nor the command zone is one of these**, and the two are absent for opposite
 * reasons. The rail's piles are taken out before the flow is drawn and stacked down a box of their
 * own, so a sweep counting the flow must not find them; that box carries `RAIL_ATTR`
 * (`columns.ts`) alone — one name, shared with `TextView`, which still packs. The command zone
 * *is* an item of this grid — the first one — but the piles inside it are not: it is one item
 * holding two piles ({@link COMMAND_ATTR}), because a masonry deals two short piles into two
 * columns and the reader asked for the companion to sit under the commander.
 *
 * The value is `data-deck-stack`, and it is now one of three: `data-deck-rail` is the piles played
 * *beside* the deck, `data-deck-command` is the ones the deck was built *around*, and this is a
 * pile of the deck itself. The three boxes a pile can be drawn in, named the same way.
 */
export const STACK_ATTR = "data-deck-stack";

/**
 * How a test — or a live pass — finds the box the command zones are drawn in: the commander, and
 * under it the companion, stacked inside a single item at the head of the flow.
 *
 * An attribute rather than a role, for the reason {@link STACK_ATTR} and `columns.ts`' `RAIL_ATTR`
 * are attributes: **which box a pile was drawn in is a layout, and it says nothing at all to a
 * reader who cannot see it.** So there is no role to give this box and no accessible name to
 * search it by — it is a `<div>` with two `<section>`s in it, and each of those keeps the heading,
 * the `aria-labelledby` and the drop target it would have had anywhere else. A reader hears
 * "Commander" and "Companion"; that the two happen to share a grid cell is not a fact about the
 * deck.
 *
 * **It is not also a `STACK_ATTR` box, and that is the rail's rule reaching a second box.**
 * `STACK_ATTR` means "a pile drawn in the flow" — one pile, one box, one grid item — and these are
 * piles drawn in a box of their own that *happens* to be a grid item. One element answering both
 * names would make every sweep that counts the deck's own piles count this box as a pile, while
 * the two real piles inside it went uncounted: they carry no `flowWidth`, exactly as in the rail,
 * so they carry no `STACK_ATTR` either.
 *
 * The value is `data-deck-command`, the third of the three names above.
 */
export const COMMAND_ATTR = "data-deck-command";

export function StackView({
  groups,
  marketplace,
  violations,
  theoryMatches,
  onSelect,
  actions,
  selectedSlot,
  landed,
  className,
}: {
  groups: readonly CardGroup[];
  /** Which marketplace every price in this view is quoted from — the heading's total and each
   *  card's own unit price. One value for the whole view, so the two cannot disagree. */
  marketplace: Marketplace;
  violations?: Map<string, ValidationIssue[]>;
  /** What the deck's plan says about each row — `theoryMatch.ts`'s map of slot → how far the
   *  live list is from the planned count, handed down whole like `violations` beside it.
   *  `undefined` for a deck with no plan. */
  theoryMatches?: ReadonlyMap<string, number>;
  onSelect?: (card: DeckCard) => void;
  /** What may be done to a card here, and where a dropped one lands. See
   *  {@link DeckCardActions}; omitted, this view is exactly what it always was. */
  actions?: DeckCardActions;
  /** The slot the pane is open on ({@link deckCardSlot}) — the picked card wears a gold ring, and
   *  in this view it is also what the pile rests open on. See {@link CardStack}. */
  selectedSlot?: string | null;
  /** `deck_cards.id` → the nonce of the add that put it there, for the cards that have just
   *  landed. Handed down whole, like `violations`. */
  landed?: ReadonlyMap<number, number>;
  className?: string;
}) {
  // **`deck`, and `GridView` reads this same key on purpose.** The two are one deck drawn two
  // ways — a stack per pile here, every card at once there — so the size the reader settled on
  // has to survive the toolbar's `Stacks | Grid` press. A section each would resize the whole
  // deck on a change of *view*, which is nobody's question: switching drawings is not asking for
  // bigger cards. The pairing is the section key and nothing else, which is what keeps the two
  // files from needing to agree about anything more.
  //
  // It is equally deliberately **not** `deckSearch`, the docked card search column drawn beside
  // this view. Those are the two sections on screen together, and they answer different
  // questions — "how big are the cards I am browsing" and "how big is my deck laid out" — which
  // is the whole of why `cardZoom` stopped being one number.
  const cardZoom = useAppStore((s) => s.cardZoom.deck);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Ctrl+wheel, on the box the whole view is drawn in: a wheel event bubbles from whichever card
  // the pointer is over up to here — including from the gaps between the piles, which belong to
  // no card at all — and this is also the rect the zoom badge is anchored to. A native
  // non-passive listener is what the hook is for; React's own wheel listeners are passive and
  // could not `preventDefault`, so WebView2 would zoom the entire window underneath the cards.
  //
  // The ref's name predates 2026-08-14, when this box stopped scrolling down and became a box
  // that simply grows; it is still the element the gesture belongs on, for the two reasons above.
  //
  // The literal `"deck"` is the same key the read above takes and the same one `GridView` passes,
  // for the reason written there: the gesture and the geometry have to name one section, and the
  // two deck views have to name each other's.
  useCardZoomGesture(scrollRef, "deck");

  // Sized from the same zoom the stacks inside are, so the column is exactly the card plus its
  // chrome at every stop on the ladder. A px number in an inline style rather than the `14rem`
  // this replaced, because a computed Tailwind class emits no CSS rule at all.
  const columnWidth = stackColumnWidth(cardZoom);
  // **The room a card needs to leave its pile, kept at the foot of the view whether one is open or
  // not** — the whole of the root's `padding-bottom` note below, and the reason this view no
  // longer grows a scrollbar of its own the moment a reader rests on a long pile.
  //
  // `> 1` rather than `> 0`, because a pile of one card has nowhere to push: opening its only card
  // takes the `STACK_LIFTED_MARGIN` that `stackHeight` already carries and moves nothing after it.
  // So a freshly created deck — four piles, all empty — reserves nothing and draws exactly where
  // it always did, which is the case that would otherwise show 285px of blank felt under it.
  //
  // Every group, not just `flow`: the rail is inside this same box, and a pile in it overflows
  // downward exactly as one in the flow does.
  const liftRoom = groups.some((group) => group.cards.length > 1) ? stackLiftRoom(cardZoom) : 0;
  // **The split happens before anything is drawn, and it has to.** The flow runs in the reader's
  // own order and never re-orders anything, so a sideboard, a maybeboard or a pile the reader has
  // switched off, left in that stream, lands wherever the line it fell on happened to end. A rail
  // held against the right edge is not part of the flow at all, so those groups are taken out of
  // the *input* rather than pulled back out of the answer. The command zones are the same act at
  // the other end of the list: a commander is not a card in the curve, it is the card the curve
  // was built around, so it heads the desk rather than flowing in it. Which piles are railed, why
  // the kind is tested before the switch, why the rail is not sorted here, and why there is no
  // grouping-mode check beside any of those words: {@link splitRail}.
  const { command, flow, rail } = splitRail(groups);
  // **Every pile a reader may drag, in the order they are drawn** — the flow's own, so the rail
  // is out by construction rather than by a second test, and a derived heading ("Mana value 3")
  // is out because it has no id to move.
  //
  // **The command zone is out for a third reason, and it is the point of the box rather than an
  // omission**: its place is fixed. A commander and a companion are pinned to the head of the desk
  // in all three grouping modes, so there is no position a reorder could move them to and nothing
  // for `n of N` to count them among. The fence is not written here either — those piles are drawn
  // without a `flowWidth`, which is `StackGroup`'s own off switch for the grip, the row span and
  // the reorder drop all at once.
  //
  // It is what the grip's `n of N` counts and what the arrows **on a grip** step through — not
  // the ones that move the caret, which walk `walk` below and reach both other boxes — and it is
  // deliberately the *drawn* order rather than the deck's: a reader pressing ArrowRight on a grip
  // is asking for the pile they can see to the right, and the piles the deck holds that this desk
  // is not drawing are the editor's to thread back in ({@link DeckCardActions.moveCategory}).
  const flowIds = flow.flatMap((group) => (group.categoryId === null ? [] : [group.categoryId]));
  // **Every card the arrows walk, in the order they are drawn** — the command zone, then the
  // flow, then the rail, each pile's cards in the order it already holds them. It is the same
  // `splitRail` answer the view is drawn from and deliberately not a second derivation of it: a
  // walk that disagreed with the layout by one pile would send the caret somewhere the reader is
  // not looking, and nothing on screen would say so. `deckWalk.ts` flattens this same order for
  // the printings modal off the same function, and since 2026-08-21 the two do not merely agree
  // on the order — they take the same step, because left and right here now cross pile
  // boundaries exactly as the modal's chevrons do.
  //
  // Both of the other boxes are **in** it: their piles are drawn on the desk like any other, so a
  // reader arrowing left off the first flowing pile is asking for the commander and one arrowing
  // right past the last is asking for the Sideboard. Where a pile sits is a layout; what the caret
  // can reach is not.
  const walk = [...command, ...flow, ...rail];

  /**
   * **Every selection this view makes, press and arrow alike — and the caret stays on the card.**
   *
   * The note is here rather than on the arrow handler alone, and that placement *is* the fix for
   * the second half of a reported bug. `onSelect` is `openCardFromDeck`, so it mounts the card
   * pane's body, and that body focuses itself as it opens — the right contract for a card opened
   * from somewhere the reader is passing through, and the wrong one for a deck they are working
   * out of. Announced only for the arrows, the walk worked and *a click did not*: pressing a card
   * put the caret on the pane, so the reader's next arrow moved nothing at all. Measured in the
   * shipped window 2026-08-19 — a real click on a deck card left `document.activeElement` as
   * `<aside aria-label="Card details">`, and ArrowRight and ArrowDown then did nothing.
   *
   * **That is why it wraps the prop rather than sitting at the two call sites**: a third way to
   * select a card in this view would otherwise have to remember, and the failure it causes is
   * silent — the selection is right, the ring is right, and only the *next* keypress is wrong.
   *
   * It costs the pane nothing it needs. Escape still closes it, and the caret it would have
   * handed back is where the reader already is.
   */
  const selectCard = (card: DeckCard) => {
    keepCaretForCard(card.cardId);
    onSelect?.(card);
  };

  /**
   * The arrows, for the whole view — **left and right, one card at a time, through the whole
   * deck**, pile boundaries included. {@link nextStackPosition} is the movement; this is
   * everything about it that needs a document.
   *
   * **Up and down reach no branch here at all** (changed 2026-08-21): the movement answers `null`
   * for them, so the press falls through to the page, which is the one thing that scrolls behind
   * this view. Two keys are the whole gesture, and they are the two the printings modal has
   * always used — a reader stepping through their deck presses the same pair whichever surface
   * they are on.
   *
   * **One handler on the root rather than one per card**, which is this file's standing rule for
   * a view that draws hundreds of them: a keydown bubbles from whichever button the caret is on,
   * and the slot stamped on that button says which card it was — so the alternative buys a
   * closure per card to learn something the DOM already knows.
   */
  const onArrowKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // **The grip's arrows are these arrows, and the grip goes first.** `CategoryGrip` binds the
    // same two to *reordering the pile* and calls `preventDefault()` on both, including the
    // presses that step past the end and send nothing — and it is the same synthetic event
    // bubbling up to here, so the flag is readable. With the caret on a grip an arrow moves the
    // pile; anywhere else it moves the selection. Yielding to whatever claimed the press is also
    // what keeps this from swallowing a key some later control binds inside the view.
    if (e.defaultPrevented) return;
    // A modified arrow is somebody else's gesture — the browser's own caret browsing, the window
    // manager's, a shortcut this app has not written yet. Answering one would take a key away
    // with nothing on screen saying why.
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    // Whatever leaf the caret was in when the key was pressed — a `span` inside a button as
    // often as the button itself, which is why every test below it is a `closest`.
    const from = e.target;
    if (!(from instanceof Element)) return;
    if (from.closest(NOT_THE_CARET)) return;
    // Not on a card at all: a heading, a grip that did not claim the press, the blank desk
    // between two piles. There is nowhere to move *from*, so the press is left alone.
    const slot = caretCardSlot(from);
    if (slot === null) return;
    const at = stackPositionOf(walk, slot);
    if (at === null) return;
    const to = nextStackPosition(
      walk.map((group) => group.cards.length),
      at,
      e.key,
    );
    if (to === null) return;
    const target = walk[to.pile].cards[to.card];

    e.preventDefault();
    // The pane and the gold ring follow the caret, because in this view the picked card is also
    // the pile's resting state — a reader running along a row of piles is reading them, and a
    // selection that lagged the caret would leave the ring on a card they have left.
    //
    // Called **before** the caret is moved, and the order costs nothing either way: both are
    // inside one React event, so the re-render this schedules is flushed after this handler
    // returns. Nothing remounts — a card's element is keyed by its `deck_cards.id` — so the
    // button focused here is the same node afterwards and keeps the caret. `StackedCard`'s own
    // `onFocus` opens the card it is on, which is the intended half of that: the card the caret
    // lands on stands out of its pile.
    //
    // `selectCard` rather than `onSelect` — the caret note is in there, and it is in there rather
    // than here precisely so that a *press* on a card gets it too.
    selectCard(target);
    // `e.currentTarget` is the view's own root — the element this handler is attached to — which
    // is both the right scope for the lookup and one fewer read of `scrollRef`. It is only valid
    // for the length of the handler, which is exactly how long it is used for.
    focusStackCard(e.currentTarget, target);
  };

  return (
    // Scrolls **down**, and that is the whole of this layout. A pile that will not fit opens
    // *below* the line rather than off the right edge: a fifteen-category deck used to run
    // sideways and put an X scrollbar across the entire desk, which is the one thing the app's
    // 1024px floor forbids — reached by the route `DeckEditor`'s `DECK_FLOOR` never measured,
    // since 208 is the width this view is guaranteed and it does not hold even one column.
    // Down is also where a lifted card at the foot of a pile has always had to go, so there
    // is one direction to scroll rather than two.
    //
    // **And down means the *page*, not this box** (changed 2026-08-14). This root used to be
    // `overflow-auto` inside a bounded desk, so a deck with more piles than the window was tall
    // got a second scrollbar *inside* the deck builder — a wall of cards in a letterbox, with the
    // editor's own scrollbar beside it and nothing saying which one a wheel would move. It is
    // `overflow-x-auto` now and it is given no height at all: the piles wrap, the box grows to
    // hold every line of them, the desk row grows with it and `DeckEditor`'s page scroller is the
    // one thing that scrolls. **The X axis keeps its scrollbar and that is not an oversight** —
    // one column at 2× really is wider than a narrow desk, clipping a card is worse than a
    // scrollbar the reader asked for by zooming, and the alternative is that overhang reaching
    // the *page* and putting an X scrollbar across the whole app, which the 1024px floor forbids.
    // **`overflow-x-auto` computes `overflow-y` to `auto` as well, and that Y scrollbar is real
    // — which is what {@link liftRoom} at the foot of this box is for** (added 2026-08-20). "A box
    // with no height of its own is never taller than its own content" stood here for six days and
    // is false twice over. This box *does* get a height of its own — `h-full` off a desk row the
    // editor's column has spare space to hand out, which is every window taller than the deck —
    // and its content *does* outgrow it, because a pile's list is a fixed height with
    // `overflow-visible` (`CardStack`) and an open card pushes the cards after it
    // {@link stackLiftRoom} px past that box on purpose. Under the tallest column there is nothing
    // to absorb it, so it became scrollable overflow *here* and the reader got the second
    // scrollbar the change above had just taken away — measured in the shipped window on
    // 2026-08-20 at 1400×1300: root `clientHeight` 1081, `scrollHeight` 1144, a 15px bar beside
    // the page's own. A long pile among short ones is exactly the shape that finds it, because the
    // long one is what sets this box's height and so is the one with nothing underneath.
    //
    // The room is **reserved, not scrolled to**, and reserved **always rather than while a card is
    // open**. A box that grew on hover would walk the page under the reader's pointer, which is
    // the one thing `stackHeight` being a function of the count alone exists to prevent one floor
    // up; and it is what this box did in the other half of the case — a deck taller than the
    // window is content-sized rather than stretched, so the same open card grew the desk row by
    // 404px instead of scrolling it. Reserving is one answer for both.
    //
    // The `flex-wrap` *here* is what decides the narrow desk. With the flowing box below
    // refusing to go under one column wide, a desk too narrow to hold a column beside the rail
    // drops the rail onto its own line — CSS answering it, with **nothing in this view measuring
    // its own box in either axis**. That rule used to be stated on a `DEFAULT_COLUMN_HEIGHT` the
    // editor passed a measured height into; the height is gone and the rule outlived it.
    //
    // `content-start` belongs on *this* box and only here, because this is the only box here
    // that a host can hand height to spare. `DeckEditor` no longer does — it gives this view no
    // height, which is the change above — but a host that draws it in a box of its own still
    // can, and the Storybook decorator's `h-[42rem]` is exactly that. Once the rail has wrapped
    // there are two flex lines in a box taller than both, and `align-content`'s initial `normal`
    // behaves as **stretch**, dealing the slack out between them: a freshly created deck — four
    // nearly empty piles, one short line — draws that line at the top and the Sideboard floating
    // a couple of hundred pixels under it with nothing in between. `items-start` cannot prevent
    // it: that aligns an item within its line, never the lines within the box.
    //
    // `flex-1` is inert in the editor for the same reason — the page hands this view a plain
    // block to fill — and is kept because it is the sentence a host in a *row* reads: it is how
    // the view takes its share of the width, which is the axis this box has ever shared.
    //
    // **{@link DROP_MARK_ROOM} is the padding, and it is what keeps a drag's own affordance on
    // screen.** This box clips at its padding box, so with none the leftmost pile's `DROP_RING`
    // and the rail's were each sliced down the edge for the whole length of a drag, and a pile's
    // focus outline with them. The bottom edge is {@link ROOT_GUTTER} instead — the `pb-2` this
    // was written as until the reserve above needed adding to it, and an inline `padding-bottom`
    // replaces a Tailwind one rather than adding to it — because the foot of a column is the one
    // edge that was never clipped and 8px is what the layout was drawn with.
    <div
      ref={scrollRef}
      // The arrow keys, for every card in the view — see {@link onArrowKey}, which is also where
      // the four things it refuses to answer are written down.
      onKeyDown={onArrowKey}
      style={{ paddingBottom: ROOT_GUTTER + liftRoom }}
      className={cn(
        "flex h-full min-w-0 flex-1 flex-wrap content-start items-start gap-4 overflow-x-auto",
        DROP_MARK_ROOM,
        className,
      )}
    >
      {/* The flowing half, and **every pile in it is an item of this one grid, except the two the
          deck was built around, which share the first item** — no columns, no packing, nothing
          measuring this box. They run left to right in the reader's own order and the one that
          will not fit drops to the next line, which is what fills the desk's width before it
          spends any of its height. See {@link STACK_ATTR} for the two layouts this replaced and
          the bug each of them left standing, and {@link CommandZone} for why one item holds two
          piles.

          **The masonry is `auto-fill` tracks over one-pixel rows, and nothing else.**
          `repeat(auto-fill, columnWidth)` is CSS counting how many piles fit on a line — the one
          number this view refuses to work out for itself — and `gridAutoRows: 1px` makes a row
          span a pixel height, so each pile claims exactly its own ({@link flowRowSpan}). Grid's
          own placement does the rest: it fills the first free cell at or after the cursor and
          never walks back up the page, which with pixel rows means a wrapped pile lands at the
          foot of the shortest pile that is not in its way rather than under the tallest pile of a
          shared line. That line was the whole defect — one forty-card Creature stack set the
          height of every short pile beside it, and the reader was looking at the blank desk under
          them.

          `minWidth` is one pile, and that number is the whole of the narrow case: below it the
          rail wraps, rather than this box squeezing under a pile's fixed width and scrolling
          sideways. `min-w-0`/`flex-1` cannot say it — they describe how a box shares slack, not
          the width at which it must stop sharing.

          **There is no `maxWidth` here any more, and the rail sits at the right edge because this
          box takes everything else** (changed 2026-08-18). `flowMaxWidth` capped it at whole
          columns for a day, which freed the leftover — up to very nearly a whole column, and a
          different number at every stop on the zoom ladder — to sit *after* the rail, so the rail
          came to rest one gutter from the deck's last pile wherever the deck happened to end. The
          reader's call reverses that: the piles played beside the deck are looked for **on the
          right**, at every width and every zoom, and the leftover is what pays for it. With
          nothing capping it, `flex-1` swallows every pixel the rail leaves, so the remainder is
          dead desk *inside* this box, between the last pile and the rail, and the rail is flush
          against the right edge of the desk. **The deck's own gutters are untouched, which is the
          half of this the reader asked to keep**: `auto-fill` over a definite width spends whole
          columns and `gap-x-2` is 8px at every stop on the ladder. **The column count is
          untouched too** — a capped box was exactly `n × (column + gap) − gap` wide, so
          `auto-fill` counts the same `n` either way, and dropping the cap moved no pile.

          **`items-start` is load-bearing twice over now.** It keeps each pile its own height —
          stretched, a switched-off pile's `bg-surface/60` wash would grow to fill its whole grid
          area and read as an empty box nobody drew — and that same content-sizing is what makes
          the measurement above safe: a pile's height cannot depend on the span it was given, so
          measure → span → measure cannot oscillate.

          **`gap-x-2` only, and the vertical gutter is inside each span.** A grid gap is drawn at
          every row boundary an item crosses, so a `gap-y` here would put hundreds of gutters
          inside a single pile; {@link FLOW_GAP_Y} carries the same 20px the `gap-y-5` this
          replaced drew, once, under each pile.

          **The horizontal gutter is 8px and the rail's is still 16** (halved 2026-08-22). It was
          `gap-x-4` until then, the same 16 the root's `gap-4` spaces the rail by, and the two were
          one number by descent rather than by argument. The reader asked for the piles to sit
          closer together and for that axis only — {@link FLOW_GAP_Y} is untouched — so this is
          now the deck's own rhythm and the root's is the boundary between the deck and the rail.
          **The rail is not moved by it**: this box is `flex-1` and swallows every pixel the rail
          leaves, so what the reader sees in front of the rail is the leftover, not this gap.
          `auto-fill` does move — 8px of track spacing rather than 16 is how a line comes to hold
          one more pile at some desk widths, which is the point of asking.

          **No `content-start` here, on purpose.** This box is a flex item of a line the outer
          `items-start` never stretches, so its height is exactly its content's, there is no free
          cross-space in it, and an `align-content` would have nothing to align. The one place
          that rule can act is the root above. */}
      <div
        style={{
          minWidth: columnWidth,
          gridTemplateColumns: `repeat(auto-fill, ${columnWidth}px)`,
          gridAutoRows: `${FLOW_ROW}px`,
        }}
        className="grid flex-1 items-start gap-x-2"
      >
        {/* The command zone, first of the grid's items and the only one that is more than one
            pile — see {@link CommandZone}, which carries the whole of why the commander and the
            companion are one box rather than two neighbours.

            **The `length > 0` is the only test here, and every decision behind it was made
            upstream.** Whether an empty commander pile is a place worth drawing is
            `drawsWhenEmpty`'s question — it draws where the deck's format has a command zone and
            an empty Companion never does — and whether a switched-off one belongs here at all is
            `splitRail`'s, which answers no and leaves it to the rail with every other pile the
            reader turned off. A view that added a second test would be a third opinion about a
            deck, in the file with the least standing to hold one. */}
        {command.length > 0 && (
          <CommandZone
            groups={command}
            marketplace={marketplace}
            violations={violations}
            onSelect={selectCard}
            actions={actions}
            selectedSlot={selectedSlot}
            landed={landed}
            zoom={cardZoom}
            columnWidth={columnWidth}
          />
        )}
        {flow.map((group) => (
          <StackGroup
            key={group.key}
            group={group}
            marketplace={marketplace}
            violations={violations}
            theoryMatches={theoryMatches}
            onSelect={selectCard}
            actions={actions}
            selectedSlot={selectedSlot}
            landed={landed}
            zoom={cardZoom}
            flowWidth={columnWidth}
            flowIds={flowIds}
          />
        ))}
      </div>
      {/* The rail: everything that is not the deck being laid out — the piles played *beside* it,
          the Sideboard and the Maybeboard, and under them every pile the reader has switched off —
          on the right, never packed and never wrapped away from the edge while there is room for
          it. Both runs are in the reader's own `sortOrder` and neither is re-arranged here. It
          draws for an **empty** pile too: an empty pile is where the next card of that kind goes,
          and a rail that appeared with the first card would move the whole layout under the
          reader's hand at the moment they were using it.

          **The switched-off half costs this file nothing, which is the point of it being a split
          rather than a second box** (added 2026-08-17). A group in the rail is the same
          `StackGroup` as one in the flow, so the wash, the dimmed heading, the `INACTIVE` chip and
          the stack's `opacity-60` arrive with it rather than being defined twice — and the return
          journey is free for the same reason: `splitRail` is derived per render, so switching a
          pile back on drops it into the flow at its own `sortOrder` with no state anywhere
          recording that it was ever here. The rail is *where* a pile is drawn, never *what* it is,
          and there is deliberately no divider between the two runs: an inactive pile already says
          so three times over, and the Maybeboard heading the rail is switched off as well, so a
          rule drawn under it would be marking a boundary that is not the one it looked like.

          **The Maybeboard is seeded switched off, so this rail has always held a dimmed pile** —
          which is why the change above needed no new drawing code at all.

          **`ml-auto` is back, and it earns its keep on the wrapped line rather than beside the
          deck** (changed 2026-08-18). On the ordinary line it does nothing at all: the flowing box
          is `flex-1` with no cap since the change above, so `flex-grow` has already taken every
          free pixel and an auto margin resolves to zero — the rail is at the right edge because
          there is no line left to its right, not because a margin put it there. The line where
          free space survives is the **wrapped** one: a desk too narrow to hold a pile beside the
          rail drops the rail below the deck, alone on its own line, and this is what holds it at
          the right edge there too. That reverses the call of 2026-08-17 — the rail landed at the
          **left**, under the first column, on the argument that once it is under the deck there is
          no "right of the deck" left to be at. True, and the reader's answer is that the rail's
          place is the right edge of the *desk*, whether or not the deck is beside it.

          The width is the same `stackColumnWidth` the flowing piles are, inline and in both halves
          of the shorthand, because a Tailwind class built from a number emits no CSS rule at all.

          **The piles inside carry no `flowWidth`, and that is not tidiness.** This box is
          `flex-col`, so a `flex: 0 0 224px` on a child would be read down the *main* axis and
          become a height — every railed pile 224px tall, its cards clipped or floating. The rail
          holds the width for both of them; a pile in it is a plain block filling that width. */}
      {rail.length > 0 && (
        <div
          {...{ [RAIL_ATTR]: "" }}
          style={{ width: columnWidth, flex: `0 0 ${columnWidth}px` }}
          className="ml-auto flex flex-col gap-5"
        >
          {rail.map((group) => (
            <StackGroup
              key={group.key}
              group={group}
              marketplace={marketplace}
              violations={violations}
              theoryMatches={theoryMatches}
              onSelect={selectCard}
              actions={actions}
              selectedSlot={selectedSlot}
              landed={landed}
              zoom={cardZoom}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The command zone: the commander and, under it, the companion — **two piles inside one item of
 * the flowing grid**, at the head of the desk.
 *
 * A component of its own rather than markup inside the render above, for `StackGroup`'s reason
 * exactly: this box is placed by a row span measured from its own height, {@link useFlowRowSpan}
 * is a hook, and a hook cannot be called per item of a list.
 *
 * **Why one item and not two neighbours.** A commander is not a card in the curve — it is the card
 * the curve was built *around*, played from a zone of its own — and the same is true of a
 * companion, so `splitRail` pins both to the head of the desk in all three grouping modes. Left as
 * two ordinary items they would then be two short piles in a row of a masonry, which deals them
 * into columns 1 and 2 side by side: the companion beside the commander rather than under it, with
 * the curve pushed a column to the right for as long as the deck has both. The reader asked for
 * the rail's arrangement instead — one on top of the other, the way the Sideboard and the
 * Maybeboard stack — and one grid cell holding a `flex-col` is the whole of how a grid is told
 * that. The alternative is hand-assigning columns, which would move the piles in the **DOM** to
 * draw them somewhere else and take the reading order, the tab order and the arrow walk with it;
 * that is the same trade {@link STACK_ATTR} records the masonry being chosen over.
 *
 * **The span is the box's, not each pile's, and the arithmetic is untouched.**
 * {@link useFlowRowSpan} measures whatever it is attached to, so this claims one run of one-pixel
 * rows for the pair — which means exactly one {@link FLOW_GAP_Y} under the *whole* box rather than
 * one under each pile in it, and the pile that flows beside it starts at the foot of the companion
 * rather than the foot of the commander. `items-start` on the grid is what keeps the measurement
 * safe here as it does for a pile: a start-aligned item is sized by its content, so this box's
 * height cannot depend on the span it was given.
 *
 * **The gutter inside is a real `gap`, and that is not a contradiction of the rule above it.**
 * {@link FLOW_GAP_Y} cannot be a `row-gap` on the *grid*, because a grid gap is drawn at every row
 * boundary an item crosses and every row there is a pixel. This is a flex column, where a gap is
 * drawn once between two items and means what it says — so `gap-5` is 20px, the same number the
 * rail is spaced by and the same number the span above adds, written as the utility rather than
 * derived from the constant because Tailwind scans source text and a class built from a number
 * emits no rule at all.
 *
 * **The piles inside carry no `flowWidth`, exactly as the rail's do**, and that one absence is
 * four answers: no width of their own (this box holds it for both), no {@link STACK_ATTR} (they
 * are not piles drawn in the flow — this box is), no row span (a grid row means nothing inside a
 * flex column), and no reorder drag. The last is the deliberate one: a grip on a pinned zone would
 * offer a reader a move with nowhere to move to, since the head of the desk is where both of these
 * are in every grouping mode. **The drop target is untouched** — `useCategoryDrop` reads a
 * `categoryId` and has never read `flowWidth` — so a card dragged onto the commander still lands
 * in it, which is the one affordance this box could not afford to cost.
 */
function CommandZone({
  groups,
  marketplace,
  violations,
  onSelect,
  actions,
  selectedSlot,
  landed,
  zoom,
  columnWidth,
}: {
  /** The active command-zone piles, in `splitRail`'s order — commander, then companion. This box
   *  draws them down the column in the order it is given and sorts nothing, for the rail's
   *  reason: which pile is which is a fact about the deck, and this file does not know one. */
  groups: readonly CardGroup[];
  marketplace: Marketplace;
  violations?: Map<string, ValidationIssue[]>;
  onSelect?: (card: DeckCard) => void;
  actions?: DeckCardActions;
  /** Handed through to the piles — see {@link StackView}'s own props. */
  selectedSlot?: string | null;
  landed?: ReadonlyMap<number, number>;
  /** The zoom the piles inside are drawn at, handed straight through so the box and its stacks
   *  are one number rather than two reads of one store. */
  zoom: number;
  /** {@link stackColumnWidth} at that zoom — one column, the same width a flowing pile is given,
   *  because this box occupies one track of the same grid. */
  columnWidth: number;
}) {
  const { elementRef, span } = useFlowRowSpan(true);
  // A callback rather than the ref object handed straight to `ref=`: the hook is shared with
  // `StackGroup`, whose element is a `<section>`, so it holds an `HTMLElement` and a `<div>`'s
  // `ref` will not take one. React 19 calls a returned cleanup **instead of** invoking the
  // callback again with `null`, so releasing the node is this function's job — forget it and the
  // `ResizeObserver` holds an unmounted box for the life of the view. `attachSection` below is the
  // same shape for the same two reasons.
  const attachBox = useCallback(
    (node: HTMLDivElement | null) => {
      elementRef.current = node;
      return () => {
        elementRef.current = null;
      };
    },
    [elementRef],
  );

  return (
    <div
      ref={attachBox}
      {...{ [COMMAND_ATTR]: "" }}
      // The same inline pair a flowing pile carries, for the same two reasons: the width is the
      // number this view's geometry is stated in and survives a change to how the tracks are
      // declared, and a Tailwind class built from a number emits no CSS rule at all. The span is
      // absent for exactly one frame — the render before the layout effect that measures it, which
      // runs before paint.
      style={{ width: columnWidth, gridRow: span === null ? undefined : `span ${span}` }}
      className="flex flex-col gap-5"
    >
      {groups.map((group) => (
        <StackGroup
          key={group.key}
          group={group}
          marketplace={marketplace}
          violations={violations}
          onSelect={onSelect}
          actions={actions}
          selectedSlot={selectedSlot}
          landed={landed}
          zoom={zoom}
        />
      ))}
    </div>
  );
}

/**
 * One pile: its heading, its stack, and the place a dragged card can be let go.
 *
 * A component of its own rather than markup inside the `map` above, because a drop target is a
 * hook and a hook cannot be called per item of a list. The same shape the other three views
 * take, for the same reason.
 */
function StackGroup({
  group,
  marketplace,
  violations,
  theoryMatches,
  onSelect,
  actions,
  selectedSlot,
  landed,
  zoom,
  flowWidth,
  flowIds,
}: {
  group: CardGroup;
  marketplace: Marketplace;
  violations?: Map<string, ValidationIssue[]>;
  /** What the deck's plan says about each row — `theoryMatch.ts`'s map of slot → how far the
   *  live list is from the planned count, handed down whole like `violations` beside it.
   *  `undefined` for a deck with no plan. */
  theoryMatches?: ReadonlyMap<string, number>;
  onSelect?: (card: DeckCard) => void;
  actions?: DeckCardActions;
  /** Handed through to the stack — see {@link StackView}'s own props. */
  selectedSlot?: string | null;
  landed?: ReadonlyMap<number, number>;
  /** The zoom this pile's box was sized from, handed straight through to the stack so the two
   *  are the same number rather than two reads of one store. */
  zoom: number;
  /**
   * The width to draw at as an item of the flowing grid, and the mark that says it is one.
   *
   * **Absent in both of the other boxes, and that is what tells the three apart here.** The rail
   * and the command zone are each a `flex-col` box carrying the width for every pile in it, so a
   * pile in either is a plain block — no width of its own, no `STACK_ATTR`, no row span (a grid row
   * means nothing in a flex column), and no reorder drag. One prop answers all five, which is what
   * keeps a pile drawn somewhere other than the flow from being a second, quietly different kind
   * of pile. The two absences are not the same argument: the rail's is a layout fact (the box holds
   * the width), the command zone's is that too **and** a decision — a zone pinned to the head of
   * every grouping has no position a reorder could move it to. See {@link CommandZone}.
   */
  flowWidth?: number;
  /** Every draggable pile of the flow, in the order they are drawn — see {@link StackView}. The
   *  rail and the command zone are handed none, which is the other half of what `flowWidth`
   *  says. */
  flowIds?: readonly number[];
}) {
  const { attach, over, eligible } = useCategoryDrop(group.categoryId, actions?.drop);
  const inFlow = flowWidth !== undefined;
  // **Only a pile in the flow may be moved**, and the fence is the same prop that says it is one
  // — the reader's Sideboard and Maybeboard stay where the rail puts them, and the commander and
  // the companion stay at the head of the desk. `undefined` here is `useCategoryReorderDrop`'s own
  // off switch, so a pile in either of those boxes registers nothing at all.
  const moveCategory = inFlow ? actions?.moveCategory : undefined;
  // Destructured under names of its own rather than kept as one object, for `useCategoryDrop`'s
  // reason one line up: React's ref lint reads a hook result whose `attach` reaches a `ref=` as a
  // ref, and every read of a sibling field beside it as a ref access during render.
  const {
    attach: attachReorder,
    over: reorderOver,
    eligible: reorderEligible,
  } = useCategoryReorderDrop(group.categoryId, moveCategory);
  // The heading is what a pile is picked up by, and the grip inside it is where the press has to
  // start. `null` in the rail and under a derived grouping, which registers nothing.
  const { attachSource, attachHandle } = useCategoryDragSource(
    moveCategory ? group.categoryId : null,
  );
  const { elementRef, span } = useFlowRowSpan(inFlow);
  // One `ref` for two consumers — the drop target and the measurement — because a `<section>` has
  // one. It returns a cleanup, which React 19 takes *instead of* calling the callback with `null`,
  // so releasing the node is this function's job rather than a later `null` call's: forget it and
  // the observer holds an unmounted pile for the life of the view.
  const attachSection = useCallback(
    (node: HTMLElement | null) => {
      elementRef.current = node;
      const detach = attach(node);
      return () => {
        elementRef.current = null;
        detach?.();
      };
    },
    [attach, elementRef],
  );

  return (
    <section
      ref={attachSection}
      aria-labelledby={`group-${group.key}`}
      // The pile *is* the grid item — there is no column box around it to carry these. Inline
      // rather than a class, because Tailwind scans source text and a class built from a number
      // emits no CSS rule at all. The width is redundant against a track of exactly that size and
      // is kept because it is the number this view's geometry is stated in: it survives a change
      // to how the tracks are declared, and it is what a probe reads a pile's box off.
      //
      // The span is the masonry (see {@link useFlowRowSpan}) and is absent for exactly one frame —
      // the render before the layout effect that measures it, which happens before paint.
      style={
        inFlow
          ? { width: flowWidth, gridRow: span === null ? undefined : `span ${span}` }
          : undefined
      }
      {...(inFlow ? { [STACK_ATTR]: "" } : {})}
      // **The pile's own menu, on the section rather than on `GroupHeader`** — see
      // `deckGroupMenuProps`, which carries the whole reason: that header is drawn inside
      // `CategoriesDialog`'s scrimmed dialog too, and a menu opened there would paint under the
      // scrim. A card inside this section stops the event, so the innermost surface still wins.
      {...deckGroupMenuProps(group.categoryId, actions)}
      // The caret lands here when a card leaves the pile under it — a stepper reaching zero, or
      // a move landing somewhere else — so the reader is left looking at the pile that changed
      // and hears its name. `tabIndex: -1`, so it is a place focus can be *put* and never a
      // stop Tab has to travel through.
      {...deckGroupProps(group.categoryId)}
      className={cn(
        // **`border-transparent`, and it is not the same thing as having no border.** The card
        // inside fills this section's content box, and `stackColumnWidth` is
        // `stackCardWidth(zoom) + 2·SECTION_PADDING + 2·STACK_CARD_BORDER` — that last term is
        // *this* hairline. Drop the class and the content box grows by 2px, so every card paints
        // 2px wider than `stackCardWidth()`, which is the one number the whole `CardStack` file's
        // arithmetic is derived from; nothing would go red and every card in the view would be
        // very slightly the wrong shape. Transparent keeps the box and paints nothing, which is
        // the whole of what was wanted here: a pile of cards on the desk, not a pile of cards in
        // a box. See {@link SECTION_PADDING}.
        "relative rounded-lg border border-transparent p-1.5",
        // Where the caret comes back to when this pile's menu closes. The tab index is already
        // here (`deckGroupProps`); this is the half that makes the landing visible.
        FOCUS,
        // A switched-off pile is a wash and nothing else now. It used to be a *dashed* outline
        // over a fainter one (`bg-surface/40`), and the dash was the signal — which only worked
        // while every other pile carried a solid outline for it to differ from. With no outline
        // anywhere the dash had nothing to be different from, so the wash goes up and takes the
        // whole job. It is still one of three things saying it: this, `GroupHeader`'s dimmed name
        // and `INACTIVE` chip, and the stack's own `opacity-60` below. An active pile carries
        // none of the three, which is the right asymmetry — being in the deck is the default, and
        // being switched off is the fact worth spending marks on.
        !group.isActive && "bg-surface/60",
        // `AppShell`'s pair, as in the other three views, and **the border going away changed
        // nothing here.** A `ring` is a box shadow drawn *outside* the border box, so the drop
        // affordance never depended on there being a line to draw it against or to overwrite —
        // it is painted in the same place, at the same width, on a section whose own edge is now
        // invisible. Said out loud because it is the first thing a reader will suspect: taking an
        // outline away from a drop target looks exactly like the change that would have broken
        // one, and this is not it.
        // **The two drags share one pair of marks, because only one of them is ever in the
        // air.** A card being dragged and a pile being dragged are the same two questions —
        // "could this pile take what you are holding" and "is it this one" — so a second
        // colour would be a second vocabulary for one gesture. `useCategoryReorderDrop`
        // refuses every card drag and `useCategoryDrop` refuses every category drag, so the
        // two pairs can never both be true.
        (eligible || reorderEligible) && DROP_RING,
        (over || reorderOver) && DROP_OVER,
      )}
    >
      {/* The app's own drop mark, the same one the deck's columns used to draw. Outside the
          reorder wrapper below because it is absolutely positioned against *this* section. */}
      {(over || reorderOver) && <DropIndicator />}
      {/* **The whole pile is where a dragged pile may be let go, and this wrapper is how.**
          It is an **ancestor** of everything in the pile rather than an overlay over it, so a
          category drag is accepted anywhere inside the column the reader is aiming at rather
          than only on the 34px of heading they grabbed it by. A plain block child of a block
          section: it draws nothing, measures nothing, and `useFlowRowSpan` still reads the
          section.

          **The reason it is a second element is no longer the registry.** pragmatic-dnd kept one
          drop target per element in a `WeakMap` and a second `set` silently replaced the first,
          so the `<section>` being the card target left nowhere for this one; `@dnd-kit/dom` keys
          its registry by entity id and two `Droppable`s on one element both register and both
          compete. What keeps them apart now is `accepts()`, which `computeCollisions` asks
          before it measures anything — `readDragGroup` refuses a category and `readCategoryDrag`
          refuses a card. The box stays because it is the right *geometry*: this wraps the whole
          pile, where the section adds its own 6px rim, and because every test and story here
          addresses the two by element. */}
      <div ref={attachReorder}>
        {/* **The heading is the drag source and the grip only says where the press may start.**
            What travels under the pointer is then the pile's name and its two numbers rather than
            a 14px ghost of the glyph — every other drag in this app previews the thing being
            moved. Registering the button itself works and is simpler; {@link useCategoryDragSource}
            carries the measurement and the trade. */}
        <div ref={attachSource}>
          <GroupHeader
            group={group}
            marketplace={marketplace}
            layout="stacked"
            id={`group-${group.key}`}
            className="px-1 pb-1.5"
            handle={
              moveCategory && group.categoryId !== null && flowIds !== undefined ? (
                <CategoryGrip
                  ref={attachHandle}
                  categoryId={group.categoryId}
                  name={group.name}
                  flowIds={flowIds}
                  onMove={moveCategory}
                />
              ) : undefined
            }
          />
        </div>
        {deckGroupRename(group.categoryId, actions)}
        {group.cards.length === 0 ? (
          // An empty category is a place as well as a heading — this is where the next card
          // goes, and saying so is what makes the empty column worth drawing.
          <p className="px-1 pb-1 text-xs text-dim">Nothing here yet.</p>
        ) : (
          <CardStack
            cards={group.cards}
            label={group.name}
            currency={marketplace.currency}
            violations={violations}
            theoryMatches={theoryMatches}
            onSelect={onSelect}
            actions={actions}
            selectedSlot={selectedSlot}
            landed={landed}
            zoom={zoom}
            // The third of the three signals a switched-off pile carries — the wash on the
            // section and `GroupHeader`'s dimmed name and `INACTIVE` chip are the other two. Card
            // art is the loudest thing in this view by a wide margin, so a pile whose *chrome*
            // says "not in the deck" while its cards read at full strength says it twice as
            // quietly as it meant to. 60 % is far enough back to sort at a glance and near enough
            // to still read.
            //
            // **`opacity` below 1 makes this `<ul>` a stacking context**, and that `<ul>` is
            // exactly the element that takes `LAYER.raised` when a card in it opens. The lift
            // survives it — what comes forward over the groups below is the whole raised list,
            // and the raised list *is* this new context's root, so it moves as one — but this is
            // the first thing to check if that lift ever regresses on an inactive pile. It is the
            // only place in this view where a stacking context appears out of a property that is
            // not a z-index, and `layers.ts`' sweep cannot see it.
            className={group.isActive ? undefined : "opacity-60"}
          />
        )}
      </div>
    </section>
  );
}

/**
 * How a test — or a live pass — finds one pile's grip. An attribute rather than a role, because
 * every one of these is a `button` with an accessible name of its own and the sweep that wants
 * them all wants "the piles that can be moved" rather than any particular name.
 *
 * `deckGroupProps`' `DECK_GROUP_ATTR` and `STACK_ATTR` are the same idea for the same reason.
 */
export const GRIP_ATTR = "data-category-grip";

/**
 * The grip a pile is picked up by — **and the whole of the keyboard's way to move one.**
 *
 * **It registers no drag of its own**: what it marks is where a press has to land, and the
 * heading around it is the draggable ({@link useCategoryDragSource}, which has why). `ref` is that
 * source's `attachHandle`, which is how the `mousedown` listener knows the press was this one.
 *
 * A handle a mouse can drag and a keyboard cannot is a reorder half the readers do not have.
 * That is `CategoriesDialog`'s rule and it is kept verbatim here, including the position in the
 * accessible name: the only other way to know where a pile landed is to look at it, and a reader
 * pressing the arrow keys is the one reader who may not be able to.
 *
 * **Left and right only, and they mean "one place earlier" and "one place later" rather than a
 * direction on the desk.** The flow is a masonry — a pile wraps to the foot of the pile above it
 * — so "the pile below" is a fact about how much room the window had, not about the order, which
 * is why the two keys that name a *place in a list* are the two that are bound.
 *
 * **Up and down were bound to the same two moves and are not any more** (changed 2026-08-21,
 * [#178](https://github.com/Msgaihede/mtg-grimoire/issues/178)). The desk now answers exactly two
 * keys everywhere on it — cards and grips alike — so a reader learns one pair rather than
 * discovering that a heading takes four presses and a card takes two. The keyboard reorder loses
 * nothing it could do: Up did what Left does and Down did what Right does, so both moves are
 * still one press away. `CategoriesDialog`'s grip is untouched and stays on up/down, and that is
 * not an inconsistency — its piles are a **vertical list** in a dialog, where those are the two
 * keys that name a place.
 *
 * **These two presses win over the view's own arrows, and `preventDefault` is the whole of the
 * handshake.** The root binds the same two keys to moving the *caret* between cards
 * ({@link nextStackPosition}), and it returns early on `defaultPrevented` — so this handler
 * marking both, including the one that steps past an end and sends nothing, is what keeps an
 * arrow on a grip meaning "move this pile" while an arrow anywhere else means "move the
 * selection". One key with two meanings, told apart by where the caret is; drop the
 * `preventDefault()` on the no-op arm and a grip at either end of the flow would silently start
 * moving the selection instead.
 *
 * **The neighbour is named rather than counted**, because {@link DeckCardActions.moveCategory}
 * takes two ids: the flow is a subset of the deck's categories, so a position here is not a
 * position in the list `deck_category_reorder` is sent, and the editor is the only thing holding
 * both. Stepping past either end sends nothing at all — `movedTo` would clamp it to a no-op
 * write, and a round trip that changes nothing is still a round trip.
 */
function CategoryGrip({
  ref,
  categoryId,
  name,
  flowIds,
  onMove,
}: {
  /** {@link useCategoryDragSource}'s `attachHandle` — the press this grip takes is the one the
   *  heading above it is allowed to be dragged by. */
  ref: (element: HTMLElement | null) => void;
  categoryId: number;
  /** The pile's own heading, so a deck of fifteen grips is fifteen addressable controls rather
   *  than one repeated fifteen times. */
  name: string;
  flowIds: readonly number[];
  onMove: (categoryId: number, targetId: number) => void;
}) {
  const tip = useTooltip();
  const index = flowIds.indexOf(categoryId);
  const step = (to: number) => {
    const target = flowIds[to];
    if (target !== undefined) onMove(categoryId, target);
  };

  return (
    <button
      ref={ref}
      type="button"
      {...{ [GRIP_ATTR]: "" }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          step(index - 1);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          step(index + 1);
        }
      }}
      aria-label={`Move ${name}, ${index + 1} of ${flowIds.length}`}
      {...tip("Drag to reorder, or press the left and right arrow keys")}
      className={cn(
        "shrink-0 cursor-grab rounded-sm text-dim",
        "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
        FOCUS,
      )}
    >
      <GripVertical className="size-3.5" aria-hidden="true" />
    </button>
  );
}
