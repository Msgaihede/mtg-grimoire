import { CardImage } from "@/components/CardImage";
import { FoilOverlay } from "@/components/CardArt";
import { ManaText } from "@/components/ManaText";
import { RarityGem } from "@/components/RarityGem";
import { soleFinish } from "@/lib/finish";
import { cardImageUrl } from "@/lib/images";
import type { DeckCard } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { usdPrice } from "@/lib/prices";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";
import { GameChangerBadge, RuleBreakMark, TagDot } from "./CardMarks";
import { ruleBreak } from "./violations";
import type { ValidationIssue } from "./validation/types";

/**
 * The stack's geometry, and it is arithmetic rather than taste — the four numbers below have
 * to agree or the trick does not work.
 *
 * A card is **312px**: a 30px title bar, 256px of art, a 24px data line, and the 1px border
 * above and below them. Collapsed, every card carries a **−278px** bottom margin, so each one
 * advances the stack by 312 − 278 = **34px** — exactly its title bar plus the hairline. That
 * is the whole of the collapsed look: a column of title bars with the last card, which
 * nothing covers, drawn in full.
 *
 * The list is then given a **fixed height** of `34n + 286`: the collapsed stack (`34n + 278`)
 * plus **8px**, which is one lifted card's bottom margin. Fixed is the point. A lifted card's
 * margin goes from −278 to +8 and pushes every card after it down by 286px — out of the
 * list's box, over whatever is below, and *not* into the list's height. So the group's header
 * does not move, the next group in the column does not move, and the reader can run down a
 * fifteen-card stack without the page walking away from the pointer.
 */
export const STACK_CARD_HEIGHT = 312;
/** The collapsed bottom margin, in px. Negative: each card is pulled up over its neighbour. */
export const STACK_COLLAPSED_MARGIN = -278;
/** How far one card advances the stack — its title bar and the hairline under it. */
export const STACK_ADVANCE = STACK_CARD_HEIGHT + STACK_COLLAPSED_MARGIN;
/** The bottom margin a lifted card takes, and therefore the slack the list is given. */
export const STACK_LIFTED_MARGIN = 8;

/**
 * How tall the list is for `count` cards — **a function of the count and nothing else**.
 *
 * That is the property `hovering_a_card_does_not_change_the_group_height` pins, and it is
 * why the lift is pure CSS: there is no hover state in this component for a height to depend
 * on. An empty stack is 0 rather than 286 — a group with nothing in it draws its header and
 * no box.
 */
export function stackHeight(count: number): number {
  if (count === 0) return 0;
  return STACK_ADVANCE * (count - 1) + STACK_CARD_HEIGHT + STACK_LIFTED_MARGIN;
}

/** Keyboard focus, in the shape the rest of the app uses: a gold outline standing off the
 *  control's edge, never a ring. */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * The pie deep one colour letter is drawn in — `DeckStats`' own `PIP_COLOR`, which is not
 * exported, so this is the second copy of a five-line table and is named as such.
 */
const PIE: Record<string, string> = {
  W: "var(--color-pie-w)",
  U: "var(--color-pie-u)",
  B: "var(--color-pie-b)",
  R: "var(--color-pie-r)",
  G: "var(--color-pie-g)",
};

/**
 * The title bar's tint: the card's **colour identity**, faded into the app's own surface.
 *
 * This is the one place the stack spends colour, and it spends it on Magic meaning, which is
 * the direction's whole rule for when colour is allowed. Collapsed, a stack is a column of
 * these bars — so the shape of a deck's colours is legible before a single card is read.
 *
 * One letter is that colour, several are gold (a multicolour card), none is the colourless
 * grey. `colorIdentity` is **concatenated letters** (`"WU"`), never JSON — reading it a
 * character at a time is the documented way.
 */
export function identityTint(colorIdentity: string | null): string {
  const letters = [...(colorIdentity ?? "")].filter((letter) => letter in PIE);
  const base =
    letters.length === 0
      ? "var(--color-pie-c)"
      : letters.length === 1
        ? PIE[letters[0]]
        : "var(--color-pie-gold)";
  // 30 %, so the bar reads as tinted rather than as painted: a hundred fully saturated title
  // bars would out-shout the art they are stacked over, which the direction forbids outright.
  return `linear-gradient(180deg, color-mix(in oklab, ${base} 30%, var(--color-surface)) 0%, var(--color-surface) 100%)`;
}

export interface CardStackProps {
  cards: readonly DeckCard[];
  /**
   * What the list is called — the group's own heading. The header is drawn by the view above
   * (every view draws one), so the stack states it for anything that reads structure rather
   * than pixels.
   */
  label: string;
  /**
   * Every finding, by `cardId` — `violationsByCard`'s answer, handed in whole rather than
   * per card so one map serves a whole view.
   */
  violations?: Map<string, ValidationIssue[]>;
  /**
   * Open this card. The whole row is passed rather than an id, because the pane needs the
   * slot: the same printing sits in two categories often enough that "which one was pressed"
   * is not derivable from the card.
   */
  onSelect?: (card: DeckCard) => void;
  className?: string;
}

/**
 * One group's cards as a stack: overlapping card faces, each showing only its title bar, and
 * the one under the pointer lifted clear of the rest.
 *
 * This is the signature interaction of the deck builder, and the reason it is a stack rather
 * than a list of rows: a deck is a physical object, and the thing a builder does with one is
 * fan it. Reading a column of eighty rows tells you their names; running a pointer down a
 * stack shows you the cards.
 *
 * **The lift is pure CSS** — `hover:` and `focus-within:` on the card, and nothing in
 * JavaScript. Two things follow from that, and both are the point. The list's height cannot
 * depend on which card is lifted, because nothing in this component knows; and the caret does
 * exactly what the pointer does for free, rather than by a second code path that would drift.
 */
export function CardStack({ cards, label, violations, onSelect, className }: CardStackProps) {
  if (cards.length === 0) return null;

  return (
    // `overflow-visible` and the fixed height are the two halves of one idea, and neither
    // works alone: the height is what stops the group resizing, and the overflow is what lets
    // the lifted card and the cards after it leave the box instead of being clipped.
    //
    // `relative` plus the lift, so the whole stack comes forward over the groups below it in
    // the column while it is being read — the cards that slide out of the box are painted
    // over by anything later in the document otherwise.
    <ul
      aria-label={label}
      style={{ height: stackHeight(cards.length) }}
      className={cn(
        "relative block overflow-visible",
        LAYER.raisedOnHover,
        LAYER.raisedOnFocus,
        className,
      )}
    >
      {cards.map((card) => (
        <StackedCard
          key={card.id}
          card={card}
          ruleBreakText={ruleBreak(violations?.get(card.cardId))}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

/**
 * One card in the stack: a title bar, its art, and a data line — a card frame rebuilt out of
 * the app's own parts.
 *
 * Not `CardArt`, which is the 5:7 box: here the frame *is* the three bands, the art is a
 * fixed 256px window inside them, and a 5:7 aspect would break the arithmetic at the top of
 * this file. It borrows `FoilOverlay` instead, which is the same trade the card detail pane's
 * main art makes and for the same reason — what the surfaces must agree on is the marking.
 */
function StackedCard({
  card,
  ruleBreakText,
  onSelect,
}: {
  card: DeckCard;
  /** The sentence the `RULE BREAK` mark carries, or `null` when there is nothing wrong. */
  ruleBreakText: string | null;
  onSelect?: (card: DeckCard) => void;
}) {
  // The `art` crop (626×457), not the whole card: the title bar above and the data line below
  // are this frame's own, so a full card face here would print its name twice. Fed `null` for
  // an orphan, whose printing has left the card database — nothing tries to draw a picture of
  // a card that is not there, and the hook's null story is "no state machine at all".
  const art = useImageRetry(card.needsReview === null ? cardImageUrl(card.cardId, 0, "art") : null);
  const finish = soleFinish(card.finishes);
  // The allocator claims no copy for an inactive category, so every row in one reads 0 owned
  // by construction — a shortage mark there would report one the reader does not have. The
  // switch, never the kind: a Maybeboard switched *on* is short of copies like any other pile.
  const short = card.categoryActive && card.ownedQuantity < card.quantity;

  // The button's name, said once and in the order a reader would: the card, then how many,
  // then the two marks that are the reason this stack is being read at all. It begins with
  // the visible name, which is what WCAG 2.5.3 asks of a control whose label is drawn on it.
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
        "relative block overflow-hidden rounded-md border shadow-lg",
        // Collapsed, pulled up over its neighbour; lifted, standing 8px clear of it. The
        // margin is the whole animation — nothing scales, nothing translates — because a
        // margin is what pushes the cards *after* it down, which is the interaction this is
        // named for.
        //
        // Written out as literals rather than built from the constants above, because
        // Tailwind scans source text for whole class names and a class assembled at runtime
        // emits no rule at all. `a stacked card is pulled up by exactly one card's advance`
        // is what keeps the two spellings of −278 and 8 in step.
        //
        // `focus-within:` beside every `hover:`: a stack only a mouse can read is a stack
        // half the readers cannot.
        "mb-[-278px] hover:mb-2 focus-within:mb-2",
        "transition-[margin-bottom] duration-150 motion-reduce:transition-none",
        "hover:shadow-2xl focus-within:shadow-2xl",
        LAYER.raisedOnHover,
        LAYER.raisedOnFocus,
        // A card that breaks a rule is outlined in the destructive colour — the loudest of the
        // three signals it can carry, and the only one that changes the card's own edge.
        ruleBreakText ? "border-destructive" : "border-border",
      )}
    >
      <button
        type="button"
        aria-label={name}
        onClick={onSelect ? () => onSelect(card) : undefined}
        className={cn("block w-full cursor-pointer text-left", FOCUS)}
      >
        {/* The title bar — the card's own, rebuilt: how many, what it is called, what it
            costs. Tinted by colour identity, which is the one thing on this screen colour is
            allowed to mean. */}
        <span
          style={{ backgroundImage: identityTint(card.colorIdentity) }}
          className="flex h-[30px] items-center gap-1 border-b border-bg/60 px-1"
        >
          <span className="shrink-0 rounded-sm bg-accent px-1 font-mono text-[0.625rem] tabular-nums text-accent-fg">
            {card.quantity}
          </span>
          <span className="min-w-0 flex-1 truncate text-[0.6875rem] font-medium">{card.name}</span>
          {card.tagName !== null && <TagDot name={card.tagName} color={card.tagColor} />}
          {/* Gold, two letters, in the title bar. The `RULE BREAK` mark below is red, spelled
              out, and over the art — see `CardMarks.tsx` for why the pair is drawn once. */}
          {card.gameChanger === true && <GameChangerBadge />}
          <ManaText source={card.manaCost} className="shrink-0 text-[0.5625rem]" />
        </span>

        {/* 256px of art, and the arithmetic at the top of this file depends on it. */}
        <span className="relative block h-64 overflow-hidden bg-surface">
          {art.src && !art.failed ? (
            <CardImage
              src={art.src}
              // Decoration: the button above already says the card's name, and an `alt`
              // repeating it would have a screen reader read every card twice.
              alt=""
              draggable={false}
              // Lazy, because a deck's groups are plain scrollers rather than virtualised
              // walls — a hundred-card category really is a hundred mounted cards, and the
              // browser's gate is the only thing bounding what they ask for.
              loading="lazy"
              decoding="async"
              onError={art.onError}
              className="size-full object-cover"
            />
          ) : (
            <span className="flex size-full items-center justify-center px-2 text-center text-[0.6875rem] text-dim">
              {art.retrying ? "Retrying…" : card.needsReview !== null ? "No card" : "No image"}
            </span>
          )}

          <FoilOverlay finish={finish} />

          {ruleBreakText !== null && (
            <RuleBreakMark text={ruleBreakText} className="absolute bottom-1.5 left-1.5" />
          )}
        </span>

        {/* The data line: facts about the printing rather than about the deck, which is why
            it is set in the data face and one step dimmer. Its own price, per copy — a total
            belongs beside the deck, not on every card in it. */}
        <span className="flex h-6 items-center gap-1.5 border-t border-border bg-surface px-1.5 font-mono text-[0.625rem] text-dim">
          <RarityGem rarity={card.rarity} />
          <span className="min-w-0 flex-1 truncate">
            {card.setCode.toUpperCase()} · {card.collectorNumber}
          </span>
          <span className="shrink-0 tabular-nums text-text">{usdPrice(card.unitPriceUsd)}</span>
          {/* Drawn only where it says something: a fully covered card prints nothing at all,
              because sixty ticks are sixty things to read past on the way to the three that
              matter. */}
          {short && (
            <span
              title={`You own ${card.ownedQuantity} of the ${card.quantity} this deck wants`}
              className="shrink-0 tabular-nums text-destructive"
            >
              <span aria-hidden="true">
                {card.ownedQuantity}/{card.quantity}
              </span>
              <span className="sr-only">
                You own {card.ownedQuantity} of {card.quantity}
              </span>
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
