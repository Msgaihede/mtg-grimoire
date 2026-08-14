/**
 * The deck as stacks of cards in columns — the default view, and the one the redesign is
 * built around.
 */
import { useRef } from "react";
import { DROP_OVER, DROP_RING } from "@/components/AppShell";
import { DEFAULT_ZOOM } from "@/lib/cardZoom";
import type { DeckCard } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { useAppStore } from "@/lib/store";
import { useCardZoomGesture } from "@/lib/useCardZoomGesture";
import { cn } from "@/lib/utils";
import { CardStack, STACK_CARD_BORDER, stackCardWidth, stackHeight } from "../CardStack";
import { deckGroupProps, useCategoryDrop, type DeckCardActions } from "../cardControl";
import { DropIndicator } from "../DropIndicator";
import type { CardGroup } from "../grouping";
import type { ValidationIssue } from "../validation/types";
import { packColumns, SIDEBOARD_ATTR, splitSideboard } from "./columns";
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
 * How wide a column is at this zoom — **the card, plus the chrome the card sits in**.
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
 * How a test finds a column. An attribute rather than a role, because a column is a *layout*
 * and carries no meaning for a reader — `packColumns` decides which groups share one, and the
 * only claim worth pinning is that it decided rather than dropped everything into one box.
 * `DropIndicator`'s `DROP_LINE_ATTR` and `cardControl`'s `DECK_GROUP_ATTR` are the same idea for
 * the same reason.
 *
 * **The Sideboard's rail is deliberately not one of these.** This attribute means "a box
 * `packColumns` produced", and the rail is by construction the one box it did not: it is taken
 * out of the packer's input, so a sweep that counts columns is counting what the pack decided
 * and must not find it. It carries `SIDEBOARD_ATTR` (`columns.ts`) alone — one name, shared with
 * `TextView`, which has no columns of this kind to be confused with.
 */
export const STACK_COLUMN_ATTR = "data-stack-column";

/**
 * A group's height in the column, header and padding included, so the packer can fill a
 * column without measuring anything.
 *
 * The 46px is the two-line header plus the section's own padding, and the 20px is the gap to
 * the next group. Both are read off the classes below; if either changes here, the packing
 * gets slightly worse and nothing breaks — which is the right failure for a number that is
 * about how full a column looks. Neither zooms: the header is text at a fixed size and the gap
 * is chrome, so only the stack in the middle grows.
 *
 * **The zoom has to reach this or the pack is wrong**, which is the one failure here that is not
 * cosmetic: a 2× stack is more than twice as tall, so a packer working from unzoomed heights
 * would fill every column to roughly half of what it thought and the last group in each would
 * run off the bottom of the desk. It defaults for the callers that legitimately mean "the base
 * geometry" — the stories, and the tests that pin the 1× sums.
 */
export function groupHeight(group: CardGroup, zoom: number = DEFAULT_ZOOM): number {
  return 46 + stackHeight(group.cards.length, zoom) + 20;
}

/**
 * How tall a column is allowed to get before the next group starts a new one.
 *
 * A default rather than a measurement, because this view has no business observing its own
 * box: the editor knows the height of the scroller it puts this in and passes it. 640 is a
 * 1280×800 window's content area with the ribbon, the toolbar and a little air.
 */
export const DEFAULT_COLUMN_HEIGHT = 640;

export function StackView({
  groups,
  marketplace,
  violations,
  onSelect,
  actions,
  columnHeight = DEFAULT_COLUMN_HEIGHT,
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
  /** The height of the box this is being drawn into. See {@link DEFAULT_COLUMN_HEIGHT}. */
  columnHeight?: number;
  className?: string;
}) {
  const cardZoom = useAppStore((s) => s.cardZoom);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Ctrl+wheel, on the element that scrolls: this view is the whole desk, and a wheel event
  // bubbles from whichever card the pointer is over up to here — including from the gaps between
  // the columns, which belong to no card at all. A native non-passive listener is what the hook
  // is for; React's own wheel listeners are passive and could not `preventDefault`, so WebView2
  // would zoom the entire window underneath the cards.
  useCardZoomGesture(scrollRef);

  // Sized from the same zoom the stacks inside are, so the column is exactly the card plus its
  // chrome at every stop on the ladder. A px number in an inline style rather than the `14rem`
  // this replaced, because a computed Tailwind class emits no CSS rule at all.
  const columnWidth = stackColumnWidth(cardZoom);
  // **The split happens before the pack, and it has to.** `packColumns` fills a column in the
  // reader's own order and never re-orders anything, so a sideboard left in that stream lands
  // in whichever column happened to have room for it. A rail held against the right edge is not
  // a column the packer may put anything in, so it is taken out of the packer's *input* rather
  // than pulled back out of its answer — which would mean lifting a group out of a column
  // somebody else is already sharing and re-flowing the rest. Why `kind === "side"` is the whole
  // test, and why there is no grouping-mode check beside it: {@link splitSideboard}.
  const { flow, sideboard } = splitSideboard(groups);
  // The pack has to see the zoom too — a taller stack is fewer groups to a column. Wrapped
  // rather than passed by name, because `packColumns` takes a measurement of one item and knows
  // nothing about decks, let alone about how big the reader is drawing them.
  const columns = packColumns(flow, (group) => groupHeight(group, cardZoom), columnHeight);

  return (
    // Scrolls **down**, and that is the whole of this layout. A column that will not fit opens
    // *below* the line rather than off the right edge: a fifteen-category deck used to run
    // sideways and put an X scrollbar across the entire desk, which is the one thing the app's
    // 1024px floor forbids — reached by the route `DeckEditor`'s `DECK_FLOOR` never measured,
    // since 208 is the width this view is guaranteed and it does not hold even one column.
    // Down is also where a lifted card at the foot of a column has always had to go, so there
    // is one direction to scroll rather than two.
    //
    // `overflow-auto` and not `overflow-y-auto`: one column at 2× really is wider than a narrow
    // desk, and clipping a card is worse than a scrollbar the reader asked for by zooming.
    // Wrapping is what makes that the rare case instead of the ordinary one.
    //
    // The `flex-wrap` *here* is what decides the narrow desk. With the flowing box below
    // refusing to go under one column wide, a desk too narrow to hold a column beside the rail
    // drops the rail onto its own line — CSS answering it, with nothing in this view measuring
    // its own box, which its `DEFAULT_COLUMN_HEIGHT` is equally explicit about.
    //
    // `content-start` belongs on *this* box and only here, because this is the box with height
    // to spare: `DeckEditor` renders it as a `flex-1` item of a `min-h-0 flex-col` parent, so
    // its height is the scroller's rather than its content's. Once the rail has wrapped, that
    // makes two flex lines in a box taller than both — and `align-content`'s initial `normal`
    // behaves as **stretch**, dealing the slack out between them. A freshly created deck — four
    // nearly empty piles, one short column — would draw that column at the top and the Sideboard
    // floating a couple of hundred pixels under it with nothing in between. `items-start` cannot
    // prevent it: that aligns an item within its line, never the lines within the box.
    <div
      ref={scrollRef}
      className={cn(
        "flex min-w-0 flex-1 flex-wrap content-start items-start gap-4 overflow-auto pb-2",
        className,
      )}
    >
      {/* The flowing half. `minWidth` is one column, and that number is the whole mechanism
          above: below it the rail wraps, rather than this box squeezing under a column's fixed
          width and scrolling sideways. `min-w-0`/`flex-1` cannot say it — they describe how a
          box shares slack, not the width at which it must stop sharing. `flex-wrap` is what
          sends the column that will not fit onto the next line, and `items-start` keeps a column
          its own height: stretched, a switched-off pile's `bg-surface/60` wash would grow to the
          tallest thing on its line and read as an empty box nobody drew. (It was the dashed
          outline that made this obvious, until 2026-08-14 took the outline away — the wash it
          left behind stretches exactly as far.)

          **No `content-start` here, on purpose.** This box is a flex item of a line the outer
          `items-start` never stretches, so its height is exactly its content's, there is no free
          cross-space in it, and an `align-content` would have nothing to align. The one place
          that rule can act is the root above. */}
      <div style={{ minWidth: columnWidth }} className="flex flex-1 flex-wrap items-start gap-4">
        {columns.map((column, index) => (
          <div
            // By position, and that is safe here in the way a table row's key is not: a column
            // is not a thing the reader can address, and its identity is exactly "the nth
            // column of this layout".
            key={index}
            {...{ [STACK_COLUMN_ATTR]: "" }}
            style={{ width: columnWidth, flex: `0 0 ${columnWidth}px` }}
            className="flex flex-col gap-5"
          >
            {column.map((group) => (
              <StackGroup
                key={group.key}
                group={group}
                marketplace={marketplace}
                violations={violations}
                onSelect={onSelect}
                actions={actions}
                zoom={cardZoom}
              />
            ))}
          </div>
        ))}
      </div>
      {/* The rail: the Sideboard, on the right, never packed and never wrapped away from the
          edge while there is room for it. It draws for an **empty** Sideboard too — an empty
          pile is where the next sideboard card goes, and a rail that appeared with the first
          card would move the whole layout under the reader's hand at the moment they were
          using it. `ml-auto` is a no-op while the flowing half is `flex-1`, and does the work
          in the one case that matters: the rail on its own line, still right. The width is the
          same `stackColumnWidth` the columns are, inline and in both halves of the shorthand,
          because a Tailwind class built from a number emits no CSS rule at all. */}
      {sideboard.length > 0 && (
        <div
          {...{ [SIDEBOARD_ATTR]: "" }}
          style={{ width: columnWidth, flex: `0 0 ${columnWidth}px` }}
          className="ml-auto flex flex-col gap-5"
        >
          {sideboard.map((group) => (
            <StackGroup
              key={group.key}
              group={group}
              marketplace={marketplace}
              violations={violations}
              onSelect={onSelect}
              actions={actions}
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
  zoom,
}: {
  group: CardGroup;
  marketplace: Marketplace;
  violations?: Map<string, ValidationIssue[]>;
  onSelect?: (card: DeckCard) => void;
  actions?: DeckCardActions;
  /** The zoom the column above was sized from, handed straight through to the stack so the two
   *  are the same number rather than two reads of one store. */
  zoom: number;
}) {
  const { attach, over, eligible } = useCategoryDrop(group.categoryId, actions?.drop);

  return (
    <section
      ref={attach}
      aria-labelledby={`group-${group.key}`}
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
