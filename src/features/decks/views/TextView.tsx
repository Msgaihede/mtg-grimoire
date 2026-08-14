/**
 * The deck as text: one line per card, in columns, the way a decklist is written down.
 *
 * The densest of the four views and the one to reach for when the question is "what is in
 * this deck" rather than "what does this card do". No art at all — a line is a quantity, a
 * name, its marks and its cost, which is exactly what a player reads off a printed list.
 */
import { DROP_OVER, DROP_RING } from "@/components/AppShell";
import type { DeckCard } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { ManaText } from "@/components/ManaText";
import { cn } from "@/lib/utils";
import { GameChangerBadge, rowMarkColor, TagDot } from "../CardMarks";
import {
  deckCardName,
  deckCardMenuProps,
  deckCardProps,
  DeckCardControls,
  deckGroupProps,
  FOCUS,
  REVEALED_ON_CARD,
  useCategoryDrop,
  useDeckCardDrag,
  type DeckCardActions,
} from "../cardControl";
import { DropIndicator } from "../DropIndicator";
import type { CardGroup } from "../grouping";
import { ruleBreak } from "../violations";
import type { ValidationIssue } from "../validation/types";
import { packColumns, RAIL_ATTR, splitRail } from "./columns";
import { GroupHeader } from "./GroupHeader";

/** Row pitch and header height, for the packer. Read off the classes below. */
const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 26;
const GROUP_GAP = 16;

/**
 * 300px, off the design canvas — a card name plus its cost with nothing truncated.
 *
 * Fixed, unlike `StackView`'s: nothing here is drawn at a size the reader picked, because a line
 * of text is not a card and Ctrl+wheel never reaches this view.
 *
 * **One constant, read three times**: the packed column's width, both halves of its `flex`
 * shorthand, and the flowing area's `minWidth` — which is the number that decides whether the
 * rail fits beside the columns. A second spelling of "300px" would let the rail wrap at
 * a width the columns had stopped agreeing with, and the layout would be wrong only in the narrow
 * window nobody develops in. It stays an **inline style** rather than a Tailwind class for the
 * usual reason: the scanner reads source text, so a class built from a constant emits no rule.
 */
const COLUMN_WIDTH = "18.75rem";

/** How tall a group is here, so `packColumns` can fill a column without measuring. */
export function groupHeight(group: CardGroup): number {
  return HEADER_HEIGHT + Math.max(1, group.cards.length) * ROW_HEIGHT + GROUP_GAP;
}

export function TextView({
  groups,
  marketplace,
  violations,
  onSelect,
  actions,
  columnHeight = 640,
  className,
}: {
  groups: readonly CardGroup[];
  /** Which marketplace the group headings' totals are quoted from. The lines themselves show
   *  no price — a decklist line is a quantity, a name and its marks. */
  marketplace: Marketplace;
  violations?: Map<string, ValidationIssue[]>;
  onSelect?: (card: DeckCard) => void;
  /** What may be done to a card here — see {@link DeckCardActions}. */
  actions?: DeckCardActions;
  columnHeight?: number;
  className?: string;
}) {
  // The Sideboard and the Maybeboard are lifted out before anything is packed, so `packColumns` is
  // handed a shorter list and none of its own rules change. Each is a category like any other to a
  // greedy in-order pack, which drops it wherever it lands — usually the far end of a long run,
  // i.e. the two piles a reader looks for by position, in the one place they can never be.
  // {@link splitRail} has which kinds, and why the rail is not sorted here.
  const { flow, rail } = splitRail(groups);
  const columns = packColumns(flow, groupHeight, columnHeight);

  return (
    // Scrolls **down**, and sideways only when a single 300px column will not fit the desk at
    // all. Columns used to run off the right edge — `packColumns` opens the next one to the
    // right, so a fifteen-category deck was wider than the window and the reader got an X
    // scrollbar across the whole desk, which is the thing the editor's 1024px floor exists to
    // prevent, arriving by a route that floor never measured. `overflow-auto` stays rather than
    // becoming `overflow-y-auto`: clipping a card name is worse than a scrollbar in the one case
    // that can still produce one.
    //
    // `content-start` is on this box because this is the box the editor gives a height to — a
    // `flex-1` item of a `min-h-0 flex-col` parent, so it is as tall as the scroller and not as
    // tall as its lines. The moment the rail wraps there are two of those lines, and
    // `align-content`'s initial `normal` is a **stretch** that shares the leftover height out
    // between them, hanging the rail in the middle of the desk under a short list. `items-start`
    // aligns an item inside its line and can say nothing about this.
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-wrap content-start items-start gap-6 overflow-auto",
        className,
      )}
    >
      {/* The flowing columns, one column wide at minimum — and that `minWidth` is what decides,
          in CSS and without measuring anything, whether the rail fits beside them. Too narrow
          for a column *and* the rail, and the outer box's own `flex-wrap` drops the rail onto
          the next line instead of restoring the sideways scroll. `flex-1 min-w-0` cannot say
          that; a `ResizeObserver` could, and is refused — a view has no business observing its
          own box. `items-start` keeps a column its own height rather than its line's.

          It carries no `content-start`: the outer `items-start` never stretches this box, so it
          is exactly as tall as the lines inside it and an `align-content` here would have no
          free space to work in. The root above is where that rule bites. */}
      <div style={{ minWidth: COLUMN_WIDTH }} className="flex flex-1 flex-wrap items-start gap-6">
        {columns.map((column, index) => (
          <div
            key={index}
            style={{ width: COLUMN_WIDTH, flex: `0 0 ${COLUMN_WIDTH}` }}
            className="flex flex-col gap-4"
          >
            {column.map((group) => (
              <TextGroup
                key={group.key}
                group={group}
                marketplace={marketplace}
                violations={violations}
                onSelect={onSelect}
                actions={actions}
              />
            ))}
          </div>
        ))}
      </div>

      {/* The Sideboard and the Maybeboard, in the reader's own `sortOrder` — nothing here
          re-arranges them. Drawn for an **empty** pile too, which is the case worth stating: an
          empty pile is where the next card of that kind goes, and a rail that appeared with the
          first card would shove the whole layout sideways under the reader's hand mid-drag.

          A group in here is the same `TextGroup` as one in the flow, so its heading, its aria and
          its drop target need no second definition — the rail is where it is drawn, not what it
          is. **That is also the whole answer to the Maybeboard being seeded switched off**: this
          rail will routinely hold a dimmed pile, and it takes no code here, because the dimming
          belongs to the group and travels with it. */}
      {rail.length > 0 && (
        <div
          {...{ [RAIL_ATTR]: "" }}
          style={{ width: COLUMN_WIDTH, flex: `0 0 ${COLUMN_WIDTH}` }}
          // `ml-auto` is a no-op while the flowing area is `flex-1` and does the whole job in the
          // one case that matters: the rail has wrapped onto a line of its own and should still
          // be on the right, where the reader last saw it.
          className="ml-auto flex flex-col gap-4"
        >
          {rail.map((group) => (
            <TextGroup
              key={group.key}
              group={group}
              marketplace={marketplace}
              violations={violations}
              onSelect={onSelect}
              actions={actions}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One pile as a heading and its lines, and a place a dragged card can be let go —
 *  `StackView`'s `StackGroup`, for its reason. */
function TextGroup({
  group,
  marketplace,
  violations,
  onSelect,
  actions,
}: {
  group: CardGroup;
  marketplace: Marketplace;
  violations?: Map<string, ValidationIssue[]>;
  onSelect?: (card: DeckCard) => void;
  actions?: DeckCardActions;
}) {
  const { attach, over, eligible } = useCategoryDrop(group.categoryId, actions?.drop);

  return (
    <section
      ref={attach}
      aria-labelledby={`text-group-${group.key}`}
      {...deckGroupProps(group.categoryId)}
      // `AppShell`'s pair, as in the other three views: one vocabulary for a drop target.
      className={cn("relative rounded-md", eligible && DROP_RING, over && DROP_OVER)}
    >
      {over && <DropIndicator />}
      <GroupHeader
        group={group}
        marketplace={marketplace}
        id={`text-group-${group.key}`}
        className="border-b border-border px-1 pb-1"
      />
      {group.cards.length === 0 ? (
        <p className="px-1 pt-1 text-xs text-dim">Nothing here yet.</p>
      ) : (
        <ul aria-label={group.name}>
          {group.cards.map((card) => (
            <TextRow
              key={card.id}
              card={card}
              ruleBreakText={ruleBreak(violations?.get(card.cardId))}
              onSelect={onSelect}
              actions={actions}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One card as one line.
 *
 * The `RULE BREAK` chip has no room here and would not fit on a 22px row, so the mark is the
 * **stripe** down the left of the name instead — destructive for a break, gold for a game
 * changer, transparent otherwise. The whole sentence is still there: it is the row's `title`
 * and it is read aloud in the button's name, which is what makes the colour a shortcut rather
 * than the only way to know.
 */
function TextRow({
  card,
  ruleBreakText,
  onSelect,
  actions,
}: {
  card: DeckCard;
  ruleBreakText: string | null;
  onSelect?: (card: DeckCard) => void;
  actions?: DeckCardActions;
}) {
  const dragRef = useDeckCardDrag(card, actions?.drop !== undefined);

  return (
    // The controls are drawn *over* the end of the line rather than in it, so this view stays
    // what it is for: a decklist you read down, at 22px a line, with no room spent on chrome
    // that is only wanted on the one card being edited.
    // The whole line, the controls drawn over its tail included — a right-click anywhere on it
    // is a question about this card, and the keydown reaches here from the caret wherever it
    // sits inside the row.
    <li ref={dragRef} {...deckCardMenuProps(card, actions)} className="group relative">
      <button
        type="button"
        // The stripe is the only mark this row has room for, so the name is where the words
        // are — `deckCardName` is the one definition, shared with the stack and the grid.
        aria-label={deckCardName(card, ruleBreakText)}
        title={ruleBreakText ?? undefined}
        {...deckCardProps(card)}
        onClick={onSelect ? () => onSelect(card) : undefined}
        className={cn(
          "flex h-[22px] w-full cursor-pointer items-center gap-1.5 rounded px-1 text-xs",
          "transition-colors duration-150 hover:bg-surface motion-reduce:transition-none",
          ruleBreakText !== null && "bg-destructive/5",
          FOCUS,
        )}
      >
        <span className="w-4 shrink-0 text-right font-mono text-[0.6875rem] tabular-nums text-dim">
          {card.quantity}
        </span>
        <span
          style={{ borderColor: rowMarkColor(ruleBreakText, card.gameChanger) }}
          className="min-w-0 flex-1 truncate border-l-2 pl-1.5 text-left"
        >
          {card.name}
        </span>
        {card.gameChanger === true && <GameChangerBadge />}
        {card.tagName !== null && <TagDot name={card.tagName} color={card.tagColor} />}
        <ManaText source={card.manaCost} className="shrink-0 text-[0.625rem]" />
      </button>

      <DeckCardControls
        card={card}
        actions={actions}
        // `bg-surface` because this bar covers the tail of the line it belongs to — the cost
        // and the marks — rather than pushing them aside. A translucent one would print two
        // things on top of each other.
        className={cn(
          "absolute inset-y-0 right-1 flex-nowrap rounded bg-surface pl-1",
          REVEALED_ON_CARD,
        )}
      />
    </li>
  );
}
