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
import type { CardGroup } from "../grouping";
import { ruleBreak } from "../violations";
import type { ValidationIssue } from "../validation/types";
import { GroupHeader } from "./GroupHeader";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export function GridView({
  groups,
  violations,
  onSelect,
  className,
}: {
  groups: readonly CardGroup[];
  violations?: Map<string, ValidationIssue[]>;
  onSelect?: (card: DeckCard) => void;
  className?: string;
}) {
  return (
    // Down the page rather than across it: a wall wraps, so the columns the other two views
    // pack into are the window's own width here.
    <div className={cn("flex min-w-0 flex-1 flex-col gap-5 overflow-auto", className)}>
      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`grid-group-${group.key}`}>
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
                />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
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
}: {
  card: DeckCard;
  ruleBreakText: string | null;
  onSelect?: (card: DeckCard) => void;
}) {
  // The `art` crop, not the whole card: the title bar above is this frame's own, so a full
  // card face would print the name twice. `null` for an orphan — nothing fetches a picture of
  // a card that is not in the database.
  const art = useImageRetry(card.needsReview === null ? cardImageUrl(card.cardId, 0, "art") : null);
  const name = [
    card.name,
    card.quantity > 1 ? `${card.quantity} copies` : null,
    card.tagName,
    card.gameChanger ? "game changer" : null,
    ruleBreakText && `rule break: ${ruleBreakText}`,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <li
      className={cn(
        "w-[150px] overflow-hidden rounded-md border bg-surface",
        ruleBreakText !== null ? "border-destructive" : "border-border",
      )}
    >
      <button
        type="button"
        aria-label={name}
        onClick={onSelect ? () => onSelect(card) : undefined}
        className={cn("block w-full cursor-pointer text-left", FOCUS)}
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
    </li>
  );
}
