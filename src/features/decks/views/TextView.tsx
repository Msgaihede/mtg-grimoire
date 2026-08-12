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
import { packColumns } from "./columns";
import { GroupHeader } from "./GroupHeader";

/** Row pitch and header height, for the packer. Read off the classes below. */
const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 26;
const GROUP_GAP = 16;

/** 300px, off the design canvas — a card name plus its cost with nothing truncated. */
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
  const columns = packColumns(groups, groupHeight, columnHeight);

  return (
    <div className={cn("flex min-w-0 flex-1 items-start gap-6 overflow-auto", className)}>
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
    <li ref={dragRef} className="group relative">
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
