/**
 * The deck as a wall of cards: every card drawn, none of them covering another.
 *
 * The stack's opposite. A stack is for reading *down* a category; this is for seeing a whole
 * deck at once — which is what you want the moment before you cut something.
 */
import { CardImage } from "@/components/CardImage";
import { FoilOverlay } from "@/components/CardArt";
import { ManaText } from "@/components/ManaText";
import { RarityGem } from "@/components/RarityGem";
import { soleFinish } from "@/lib/finish";
import { cardImageUrl } from "@/lib/images";
import type { DeckCard } from "@/lib/ipc";
import { usdPrice } from "@/lib/prices";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";
import { identityTint } from "../CardStack";
import { GameChangerBadge, RuleBreakMark, TagDot } from "../CardMarks";
import {
  deckCardName,
  deckCardProps,
  DeckCardControls,
  deckGroupProps,
  FOCUS_INSET,
  REVEALED_ON_CARD,
  useCategoryDrop,
  useDeckCardDrag,
  type DeckCardActions,
} from "../cardControl";
import { DropIndicator } from "../DropIndicator";
import type { CardGroup } from "../grouping";
import { ruleBreak } from "../violations";
import type { ValidationIssue } from "../validation/types";
import { GroupHeader } from "./GroupHeader";

export function GridView({
  groups,
  violations,
  onSelect,
  actions,
  className,
}: {
  groups: readonly CardGroup[];
  violations?: Map<string, ValidationIssue[]>;
  onSelect?: (card: DeckCard) => void;
  /** What may be done to a card here — see {@link DeckCardActions}. */
  actions?: DeckCardActions;
  className?: string;
}) {
  return (
    // Down the page rather than across it: a wall wraps, so the columns the other two views
    // pack into are the window's own width here.
    <div className={cn("flex min-w-0 flex-1 flex-col gap-5 overflow-auto", className)}>
      {groups.map((group) => (
        <GridGroup
          key={group.key}
          group={group}
          violations={violations}
          onSelect={onSelect}
          actions={actions}
        />
      ))}
    </div>
  );
}

/** One pile as a heading and its wall, and a place a dragged card can be let go —
 *  `StackView`'s `StackGroup`, for its reason. */
function GridGroup({
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
      aria-labelledby={`grid-group-${group.key}`}
      {...deckGroupProps(group.categoryId)}
      className={cn("relative", over && "rounded-md ring-1 ring-accent")}
    >
      {over && <DropIndicator />}
      {/* `tight`, because this section is as wide as the window: counts pushed to the far
          edge would be a price 1 200px away from the heading it belongs to. */}
      <GroupHeader
        group={group}
        layout="tight"
        id={`grid-group-${group.key}`}
        className="px-0.5 pb-1.5"
      />
      {group.cards.length === 0 ? (
        <p className="px-0.5 text-xs text-dim">Nothing here yet.</p>
      ) : (
        <ul aria-label={group.name} className="flex flex-wrap gap-2.5">
          {group.cards.map((card) => (
            <GridCard
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
 * One card as a 150px tile: a title bar, its art, and a data line.
 *
 * The stack's card at 42 % — the same three bands, so a reader switching views is looking at
 * the same object rather than learning a second one. What it drops is the set line and the
 * shortage figure, which do not survive being that small; what it keeps is everything that
 * makes a card worth stopping at.
 */
function GridCard({
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
  // The `art` crop, not the whole card: the title bar above is this frame's own, so a full
  // card face would print the name twice. `null` for an orphan — nothing fetches a picture of
  // a card that is not in the database.
  const art = useImageRetry(card.needsReview === null ? cardImageUrl(card.cardId, 0, "art") : null);

  return (
    <li
      ref={dragRef}
      className={cn(
        "group relative w-[150px] overflow-hidden rounded-md border bg-surface",
        ruleBreakText !== null ? "border-destructive" : "border-border",
      )}
    >
      <button
        type="button"
        aria-label={deckCardName(card, ruleBreakText)}
        {...deckCardProps(card)}
        onClick={onSelect ? () => onSelect(card) : undefined}
        // Inset, for the stacked card's reason: this button fills a tile that clips its own
        // corners, and an outline standing off its edge is never drawn at all.
        className={cn("block w-full cursor-pointer text-left", FOCUS_INSET)}
      >
        {/* The same colour-identity tint the stacked card's title bar carries — this tile *is*
            the stacked card at 42 %, so a reader switching views is looking at one object. */}
        <span
          style={{ backgroundImage: identityTint(card.colorIdentity) }}
          className="flex h-6 items-center gap-1 px-1"
        >
          <span className="shrink-0 rounded-sm bg-accent px-1 font-mono text-[0.5625rem] tabular-nums text-accent-fg">
            {card.quantity}
          </span>
          <span className="min-w-0 flex-1 truncate text-[0.59375rem] font-medium">{card.name}</span>
          {card.tagName !== null && <TagDot name={card.tagName} color={card.tagColor} />}
          <ManaText source={card.manaCost} className="shrink-0 text-[0.5rem]" />
        </span>

        <span className="relative block h-[124px] overflow-hidden bg-surface">
          {art.src && !art.failed ? (
            <CardImage
              src={art.src}
              alt=""
              draggable={false}
              // A wall of a hundred tiles is a hundred mounted images — this is a plain
              // scroller rather than a virtualised one, so the browser's gate is the only
              // thing bounding what they ask for.
              loading="lazy"
              decoding="async"
              onError={art.onError}
              className="size-full object-cover"
            />
          ) : (
            <span className="flex size-full items-center justify-center px-1 text-center text-[0.625rem] text-dim">
              {art.retrying ? "Retrying…" : card.needsReview !== null ? "No card" : "No image"}
            </span>
          )}

          <FoilOverlay finish={soleFinish(card.finishes)} />

          {/* Top-right and bottom-left: the two marks never share a corner, in this view or
              in the stack. */}
          {card.gameChanger === true && (
            <GameChangerBadge className="absolute top-1 right-1 bg-bg/60" />
          )}
          {ruleBreakText !== null && (
            <RuleBreakMark text={ruleBreakText} className="absolute bottom-1 left-1" />
          )}
        </span>

        <span className="flex h-5 items-center gap-1 px-1.5 font-mono text-[0.5625rem] text-dim">
          <RarityGem rarity={card.rarity} />
          <span className="ml-auto shrink-0 tabular-nums text-text">
            {usdPrice(card.unitPriceUsd)}
          </span>
        </span>
      </button>

      {/* Over the art, as in the stack — 150px is too narrow for a stepper and a select on one
          line, so the wrapper's `flex-wrap` puts the move control on a second. Absolute either
          way, so the tile is still 150px whatever it holds. */}
      <DeckCardControls
        card={card}
        actions={actions}
        className={cn("absolute inset-x-0 bottom-5 px-1", REVEALED_ON_CARD)}
      />
    </li>
  );
}
