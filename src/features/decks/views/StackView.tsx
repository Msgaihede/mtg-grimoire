/**
 * The deck as stacks of cards in columns — the default view, and the one the redesign is
 * built around.
 */
import type { DeckCard } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { CardStack, stackHeight } from "../CardStack";
import {
  deckGroupProps,
  useCategoryDrop,
  type DeckCardActions,
} from "../cardControl";
import { DropIndicator } from "../DropIndicator";
import type { CardGroup } from "../grouping";
import type { ValidationIssue } from "../validation/types";
import { packColumns } from "./columns";
import { GroupHeader } from "./GroupHeader";

/** The column width off the design canvas: 224px, which a 1280px window fits five of beside
 *  the stats panel — and which is a card face at a size the art is still readable at. */
const COLUMN_WIDTH = "14rem";

/**
 * How a test finds a column. An attribute rather than a role, because a column is a *layout*
 * and carries no meaning for a reader — `packColumns` decides which groups share one, and the
 * only claim worth pinning is that it decided rather than dropped everything into one box.
 * `ZoneColumn`'s `data-zone-scroller` is the same idea for the same reason.
 */
export const STACK_COLUMN_ATTR = "data-stack-column";

/**
 * A group's height in the column, header and padding included, so the packer can fill a
 * column without measuring anything.
 *
 * The 46px is the two-line header plus the section's own padding, and the 20px is the gap to
 * the next group. Both are read off the classes below; if either changes here, the packing
 * gets slightly worse and nothing breaks — which is the right failure for a number that is
 * about how full a column looks.
 */
export function groupHeight(group: CardGroup): number {
  return 46 + stackHeight(group.cards.length) + 20;
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
  violations,
  onSelect,
  actions,
  columnHeight = DEFAULT_COLUMN_HEIGHT,
  className,
}: {
  groups: readonly CardGroup[];
  violations?: Map<string, ValidationIssue[]>;
  onSelect?: (card: DeckCard) => void;
  /** What may be done to a card here, and where a dropped one lands. See
   *  {@link DeckCardActions}; omitted, this view is exactly what it always was. */
  actions?: DeckCardActions;
  /** The height of the box this is being drawn into. See {@link DEFAULT_COLUMN_HEIGHT}. */
  columnHeight?: number;
  className?: string;
}) {
  const columns = packColumns(groups, groupHeight, columnHeight);

  return (
    // Scrolls both ways: sideways because a fifteen-category deck is more columns than a
    // window is wide, and down because a lifted card at the foot of a column overflows its
    // group on purpose and has to have somewhere to go.
    <div className={cn("flex min-w-0 flex-1 gap-4 overflow-auto pb-2", className)}>
      {columns.map((column, index) => (
        <div
          // By position, and that is safe here in the way a table row's key is not: a column
          // is not a thing the reader can address, and its identity is exactly "the nth
          // column of this layout".
          key={index}
          {...{ [STACK_COLUMN_ATTR]: "" }}
          style={{ width: COLUMN_WIDTH, flex: `0 0 ${COLUMN_WIDTH}` }}
          className="flex flex-col gap-5"
        >
          {column.map((group) => (
            <StackGroup
              key={group.key}
              group={group}
              violations={violations}
              onSelect={onSelect}
              actions={actions}
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
  violations,
  onSelect,
  actions,
}: {
  group: CardGroup;
  violations?: Map<string, ValidationIssue[]>;
  onSelect?: (card: DeckCard) => void;
  actions?: DeckCardActions;
}) {
  const { attach, over } = useCategoryDrop(group.categoryId, actions?.drop);

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
        over && "border-accent",
      )}
    >
      {/* The app's own drop mark, the same one the deck's columns used to draw. */}
      {over && <DropIndicator />}
      <GroupHeader
        group={group}
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
          violations={violations}
          onSelect={onSelect}
          actions={actions}
        />
      )}
    </section>
  );
}
