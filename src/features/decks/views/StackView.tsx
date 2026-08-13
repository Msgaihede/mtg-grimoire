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
import { packColumns } from "./columns";
import { GroupHeader } from "./GroupHeader";

/**
 * The group section's own `p-1.5`, one side — 6px, read off the class below.
 *
 * It does not zoom, and neither does the card's border: padding and a hairline are chrome around
 * a card rather than part of one, and a reader who asks for bigger cards is not asking for a
 * thicker gutter. That is why {@link stackColumnWidth} adds them rather than scaling 224.
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
  // The pack has to see the zoom too — a taller stack is fewer groups to a column. Wrapped
  // rather than passed by name, because `packColumns` takes a measurement of one item and knows
  // nothing about decks, let alone about how big the reader is drawing them.
  const columns = packColumns(groups, (group) => groupHeight(group, cardZoom), columnHeight);

  return (
    // Scrolls both ways: sideways because a fifteen-category deck is more columns than a
    // window is wide, and down because a lifted card at the foot of a column overflows its
    // group on purpose and has to have somewhere to go.
    <div
      ref={scrollRef}
      className={cn("flex min-w-0 flex-1 gap-4 overflow-auto pb-2", className)}
    >
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
        "relative rounded-lg p-1.5",
        // A switched-off pile is drawn as a dashed outline over the faintest of
        // washes: present, reachable, and visibly not part of the deck.
        group.isActive
          ? "border border-border"
          : "border border-dashed border-border bg-surface/40",
        // `AppShell`'s pair, as in the other three views — a ring rather than this column's own
        // border colour, so the dashed edge that says "switched off" is not overwritten by the
        // mark that says "drop here".
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
        />
      )}
    </section>
  );
}
