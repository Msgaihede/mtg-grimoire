/**
 * The deck as a wall of cards: every card drawn, none of them covering another.
 *
 * The stack's opposite. A stack is for reading *down* a category; this is for seeing a whole
 * deck at once — which is what you want the moment before you cut something.
 */
import { DROP_OVER, DROP_RING } from "@/components/AppShell";
import { CardImage } from "@/components/CardImage";
import { FoilOverlay } from "@/components/CardArt";
import { RarityGem } from "@/components/RarityGem";
import { soleFinish } from "@/lib/finish";
import { cardImageUrl } from "@/lib/images";
import type { DeckCard } from "@/lib/ipc";
import type { Currency, Marketplace } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";
import { GameChangerBadge, RuleBreakMark, TagDot } from "../CardMarks";
import {
  DECK_CARD_VARIANT,
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
  marketplace,
  violations,
  onSelect,
  actions,
  className,
}: {
  groups: readonly CardGroup[];
  /** Which marketplace every price in this view is quoted from — the heading's total and each
   *  tile's own unit price. */
  marketplace: Marketplace;
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
          marketplace={marketplace}
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
      aria-labelledby={`grid-group-${group.key}`}
      {...deckGroupProps(group.categoryId)}
      // The sidebar's pair, said here — one vocabulary for "this can take the card you are
      // holding" and "and it is this one" across the four views and the two screens.
      className={cn("relative rounded-md", eligible && DROP_RING, over && DROP_OVER)}
    >
      {over && <DropIndicator />}
      {/* `tight`, because this section is as wide as the window: counts pushed to the far
          edge would be a price 1 200px away from the heading it belongs to. */}
      <GroupHeader
        group={group}
        marketplace={marketplace}
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
              currency={marketplace.currency}
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
 * One card as a 150px tile: **the whole card**, with the app's marks over it.
 *
 * The stack's card at 71 % — the same object, so a reader switching views is not learning a
 * second one. What it drops is the set line and the shortage figure, which do not survive being
 * that small; what it keeps is the card itself and how many copies are in the deck.
 *
 * **No name line, and that is the app's existing answer rather than a new one.** A 150px card's
 * printed name is a few pixels tall — but `CardGrid`'s search wall already draws whole `grid`
 * cards at 150–170px and a reader identifies them by frame and art, so a caption here would be a
 * second answer to a question this app has already settled. The button's accessible name still
 * carries the whole sentence, and `GroupHeader` still names the pile.
 */
function GridCard({
  card,
  currency,
  ruleBreakText,
  onSelect,
  actions,
}: {
  card: DeckCard;
  /** How the tile's foot writes the row's one unit price. */
  currency: Currency;
  ruleBreakText: string | null;
  onSelect?: (card: DeckCard) => void;
  actions?: DeckCardActions;
}) {
  const dragRef = useDeckCardDrag(card, actions?.drop !== undefined);
  // The whole card, the same `grid` variant the stack draws. `null` for an orphan — nothing
  // fetches a picture of a card that is not in the database.
  const face = useImageRetry(
    card.needsReview === null ? cardImageUrl(card.cardId, 0, DECK_CARD_VARIANT) : null,
  );

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
        {/* 150 × 680/488, the whole card at this tile's width — `aspect-[488/680]` rather than a
            pixel height, because unlike the stack nothing here does arithmetic on it. */}
        <span className="relative block aspect-[488/680] overflow-hidden bg-surface">
          {face.src && !face.failed ? (
            <CardImage
              src={face.src}
              alt=""
              draggable={false}
              // A wall of a hundred tiles is a hundred mounted images — this is a plain
              // scroller rather than a virtualised one, so the browser's gate is the only
              // thing bounding what they ask for.
              loading="lazy"
              decoding="async"
              onError={face.onError}
              className="size-full object-cover"
            />
          ) : (
            // The card's name, which the tile has nowhere else to say it now: the title bar that
            // carried it is gone, and a picture that has not arrived says nothing on its own.
            <span className="flex size-full flex-col items-center justify-center gap-0.5 px-1 text-center">
              <span className="text-[0.59375rem] font-medium">{card.name}</span>
              <span className="text-[0.5625rem] text-dim">
                {face.retrying ? "Retrying…" : card.needsReview !== null ? "No card" : "No image"}
              </span>
            </span>
          )}

          <FoilOverlay finish={soleFinish(card.finishes)} />

          {/* The reveal strip's marks, in the stack's own arrangement and for its reasons: right
              over the card's printed title bar, so the printed name stays readable. */}
          <span className="absolute inset-x-0 top-0 flex items-center justify-end gap-1 bg-gradient-to-b from-bg/70 to-transparent px-1 py-0.5">
            {card.tagName !== null && <TagDot name={card.tagName} color={card.tagColor} />}
            {card.gameChanger === true && <GameChangerBadge />}
            <span className="shrink-0 rounded-sm bg-accent px-1 font-mono text-[0.5625rem] tabular-nums text-accent-fg">
              {card.quantity}
            </span>
          </span>

          {ruleBreakText !== null && (
            <RuleBreakMark text={ruleBreakText} className="absolute bottom-1 left-1" />
          )}
        </span>

        <span className="flex h-5 items-center gap-1 px-1.5 font-mono text-[0.5625rem] text-dim">
          <RarityGem rarity={card.rarity} />
          <span className="ml-auto shrink-0 tabular-nums text-text">
            {formatPrice(card.unitPrice, currency)}
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
