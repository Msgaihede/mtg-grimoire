/**
 * The deck as stacks of cards in columns — the default view, and the one the redesign is
 * built around.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import type { DeckCard } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { useAppStore } from "@/lib/store";
import { useCardZoomGesture } from "@/lib/useCardZoomGesture";
import { cn } from "@/lib/utils";
import { CardStack, STACK_CARD_BORDER, stackCardWidth } from "../CardStack";
import {
  deckGroupMenuProps,
  deckGroupProps,
  deckGroupRename,
  FOCUS,
  useCategoryDrop,
  type DeckCardActions,
} from "../cardControl";
import { DropIndicator } from "../DropIndicator";
import type { CardGroup } from "../grouping";
import type { ValidationIssue } from "../validation/types";
import { RAIL_ATTR, splitRail } from "./columns";
import { GroupHeader } from "./GroupHeader";

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
 * **The rail is deliberately not one of these.** Its piles are taken out before the flow is drawn
 * and stacked down a box of their own, so a sweep counting the flow must not find them. That box
 * carries `RAIL_ATTR` (`columns.ts`) alone — one name, shared with `TextView`, which still packs.
 *
 * The value is `data-deck-stack`, which pairs with the rail's `data-deck-rail`: the two boxes a
 * pile can be in, named the same way.
 */
export const STACK_ATTR = "data-deck-stack";

export function StackView({
  groups,
  marketplace,
  violations,
  onSelect,
  actions,
  selectedCardId,
  landed,
  className,
}: {
  groups: readonly CardGroup[];
  /** Which marketplace every price in this view is quoted from — the heading's total and each
   *  card's own unit price. One value for the whole view, so the two cannot disagree. */
  marketplace: Marketplace;
  violations?: Map<string, ValidationIssue[]>;
  onSelect?: (card: DeckCard) => void;
  /** What may be done to a card here, and where a dropped one lands. See
   *  {@link DeckCardActions}; omitted, this view is exactly what it always was. */
  actions?: DeckCardActions;
  /** The printing the pane is open on — the picked card wears a gold ring, and in this view it
   *  is also what the pile rests open on. See {@link CardStack}. */
  selectedCardId?: string | null;
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
  // **The split happens before anything is drawn, and it has to.** The flow runs in the reader's
  // own order and never re-orders anything, so a sideboard or a maybeboard left in that stream
  // lands wherever the line it fell on happened to end. A rail held against the right edge is not
  // part of the flow at all, so those groups are taken out of the *input* rather than pulled back
  // out of the answer. Which kinds are railed, why the rail is not sorted here, and why there is
  // no grouping-mode check beside the kind: {@link splitRail}.
  const { flow, rail } = splitRail(groups);

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
    // It costs nothing while it is not needed: `overflow-x-auto` computes `overflow-y` to `auto`
    // too, and a box with no height of its own is never taller than its own content, so the Y
    // scrollbar this pair implies can never have anything to scroll.
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
    <div
      ref={scrollRef}
      className={cn(
        "flex min-w-0 flex-1 flex-wrap content-start items-start gap-4 overflow-x-auto pb-2",
        className,
      )}
    >
      {/* The flowing half, and **every pile in it is an item of this one grid** — no columns, no
          packing, nothing measuring this box. They run left to right in the reader's own order and
          the one that will not fit drops to the next line, which is what fills the desk's width
          before it spends any of its height. See {@link STACK_ATTR} for the two layouts this
          replaced and the bug each of them left standing.

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

          **`items-start` is load-bearing twice over now.** It keeps each pile its own height —
          stretched, a switched-off pile's `bg-surface/60` wash would grow to fill its whole grid
          area and read as an empty box nobody drew — and that same content-sizing is what makes
          the measurement above safe: a pile's height cannot depend on the span it was given, so
          measure → span → measure cannot oscillate.

          **`gap-x-4` only, and the vertical gutter is inside each span.** A grid gap is drawn at
          every row boundary an item crosses, so a `gap-y` here would put hundreds of gutters
          inside a single pile; {@link FLOW_GAP_Y} carries the same 20px the `gap-y-5` this
          replaced drew, once, under each pile. The 16px horizontal gutter is unchanged and is
          still the one the rail is spaced by.

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
        className="grid flex-1 items-start gap-x-4"
      >
        {flow.map((group) => (
          <StackGroup
            key={group.key}
            group={group}
            marketplace={marketplace}
            violations={violations}
            onSelect={onSelect}
            actions={actions}
            selectedCardId={selectedCardId}
            landed={landed}
            zoom={cardZoom}
            flowWidth={columnWidth}
          />
        ))}
      </div>
      {/* The rail: the piles played *beside* the deck — the Sideboard and the Maybeboard, in the
          reader's own `sortOrder` and never re-arranged here — on the right, never packed and
          never wrapped away from the edge while there is room for it. It draws for an **empty**
          pile too: an empty pile is where the next card of that kind goes, and a rail that
          appeared with the first card would move the whole layout under the reader's hand at the
          moment they were using it.

          **The Maybeboard is seeded switched off, so this rail routinely holds a dimmed pile**,
          which is the first thing a reader will notice about it and needs no code here at all: a
          group in the rail is the same `StackGroup` as one in the flow, so the wash, the dimmed
          heading and the stack's `opacity-60` arrive with it rather than being defined twice. The
          rail is *where* a pile is drawn, never *what* it is.

          `ml-auto` is a no-op while the flowing half is `flex-1`, and does the work in the one
          case that matters: the rail on its own line, still right. The width is the same
          `stackColumnWidth` the flowing piles are, inline and in both halves of the shorthand,
          because a Tailwind class built from a number emits no CSS rule at all.

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
              onSelect={onSelect}
              actions={actions}
              selectedCardId={selectedCardId}
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
  onSelect,
  actions,
  selectedCardId,
  landed,
  zoom,
  flowWidth,
}: {
  group: CardGroup;
  marketplace: Marketplace;
  violations?: Map<string, ValidationIssue[]>;
  onSelect?: (card: DeckCard) => void;
  actions?: DeckCardActions;
  /** Handed through to the stack — see {@link StackView}'s own props. */
  selectedCardId?: string | null;
  landed?: ReadonlyMap<number, number>;
  /** The zoom this pile's box was sized from, handed straight through to the stack so the two
   *  are the same number rather than two reads of one store. */
  zoom: number;
  /**
   * The width to draw at as an item of the flowing grid, and the mark that says it is one.
   *
   * **Absent in the rail, and that is what tells the two boxes apart here.** The rail is a
   * `flex-col` box that carries the width for every pile in it, so a pile there is a plain block —
   * no width of its own, no `STACK_ATTR`, and no row span, a grid row meaning nothing in a flex
   * column. One prop answers all four, which is what keeps a rail pile from being a second, quietly
   * different kind of pile.
   */
  flowWidth?: number;
}) {
  const { attach, over, eligible } = useCategoryDrop(group.categoryId, actions?.drop);
  const inFlow = flowWidth !== undefined;
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
        eligible && DROP_RING,
        over && DROP_OVER,
      )}
    >
      {/* The app's own drop mark, the same one the deck's columns used to draw. */}
      {over && <DropIndicator />}
      <GroupHeader
        group={group}
        marketplace={marketplace}
        layout="stacked"
        id={`group-${group.key}`}
        className="px-1 pb-1.5"
      />
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
          onSelect={onSelect}
          actions={actions}
          selectedCardId={selectedCardId}
          landed={landed}
          zoom={zoom}
          // The third of the three signals a switched-off pile carries — the wash on the section
          // and `GroupHeader`'s dimmed name and `INACTIVE` chip are the other two. Card art is the
          // loudest thing in this view by a wide margin, so a pile whose *chrome* says "not in
          // the deck" while its cards read at full strength says it twice as quietly as it meant
          // to. 60 % is far enough back to sort at a glance and near enough to still read.
          //
          // **`opacity` below 1 makes this `<ul>` a stacking context**, and that `<ul>` is exactly
          // the element that takes `LAYER.raised` when a card in it opens. The lift survives it —
          // what comes forward over the groups below is the whole raised list, and the raised
          // list *is* this new context's root, so it moves as one — but this is the first thing
          // to check if that lift ever regresses on an inactive pile. It is the only place in
          // this view where a stacking context appears out of a property that is not a z-index,
          // and `layers.ts`' sweep cannot see it.
          className={group.isActive ? undefined : "opacity-60"}
        />
      )}
    </section>
  );
}
