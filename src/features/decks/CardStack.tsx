import { CardImage } from "@/components/CardImage";
import { FoilOverlay } from "@/components/CardArt";
import { RarityGem } from "@/components/RarityGem";
import { soleFinish } from "@/lib/finish";
import { cardImageUrl } from "@/lib/images";
import type { DeckCard } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { usdPrice } from "@/lib/prices";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";
import { GameChangerBadge, RuleBreakMark, TagDot } from "./CardMarks";
import {
  DECK_CARD_VARIANT,
  deckCardName,
  deckCardProps,
  DeckCardControls,
  FOCUS_INSET,
  REVEALED_ON_CARD,
  useDeckCardDrag,
  type DeckCardActions,
} from "./cardControl";
import { ruleBreak } from "./violations";
import type { ValidationIssue } from "./validation/types";

/**
 * The stack's geometry, and it is arithmetic rather than taste — the numbers below have to
 * agree or the trick does not work.
 *
 * **A card is the card**: one whole `grid` image, edge to edge, with the app's own marks
 * overlaid on it. So its height is not a number somebody chose, it is the aspect ratio of a
 * Magic card applied to the width `StackView` gives it:
 *
 * ```
 * column 224 (StackView's COLUMN_WIDTH, a fixed 14rem — never measured)
 *   − the section's p-1.5 either side (6 + 6)   = 212
 *   − the card's own border (1 + 1)             = 210  →  STACK_CARD_WIDTH
 * 210 × 680/488                                 = 292.6 →  STACK_IMAGE_HEIGHT (293)
 *   + the border back                           = 295  →  STACK_CARD_HEIGHT
 * ```
 *
 * Collapsed, every card carries a **−261px** bottom margin, so each one advances the stack by
 * 295 − 261 = **34px**. That 34 is unchanged from when this frame was three app-drawn bands and
 * the advance was its 30px title bar: it is now the card's **printed** title bar plus a sliver
 * of art, which is what a real fanned stack shows — and it is a legibility floor rather than a
 * proportion, because the quantity chip overlaid on that strip has to fit in it.
 *
 * The list is then given a **fixed height** of `34n + 269`: the collapsed stack (`34n + 261`)
 * plus **8px**, which is one lifted card's bottom margin. Fixed is the point. A lifted card's
 * margin goes from −261 to +8 and pushes every card after it down by 269px — out of the
 * list's box, over whatever is below, and *not* into the list's height. So the group's header
 * does not move, the next group in the column does not move, and the reader can run down a
 * fifteen-card stack without the page walking away from the pointer.
 */
export const STACK_CARD_WIDTH = 210;
/**
 * A Magic card's proportions, taken from the `grid` variant's own 488×680 — the image these
 * cards draw, so the frame cannot disagree with its contents about what shape a card is.
 */
const CARD_ASPECT = 680 / 488;
/** The image's own height at {@link STACK_CARD_WIDTH}, which is the card face and nothing else. */
export const STACK_IMAGE_HEIGHT = Math.round(STACK_CARD_WIDTH * CARD_ASPECT);
export const STACK_CARD_HEIGHT = STACK_IMAGE_HEIGHT + 2;
/** How far one card advances the stack — its printed title bar and a sliver of art. A floor for
 *  the overlaid quantity chip, not a fraction of the card. */
export const STACK_ADVANCE = 34;
/** The collapsed bottom margin, in px. Negative: each card is pulled up over its neighbour. */
export const STACK_COLLAPSED_MARGIN = STACK_ADVANCE - STACK_CARD_HEIGHT;
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

/**
 * The one strip of a collapsed card the reader can see — its printed title bar — as the box the
 * app's own marks are laid over.
 *
 * The marks go **right**, and that is the whole reason this is a named constant rather than a
 * class on a div: a printed name is left-aligned, and a collapsed stack is *read* down this
 * strip. A quantity chip on the left would cover the one thing that says which card this is.
 * What it covers instead is the printed mana cost, which the table view, the card pane and the
 * mana curve all still carry.
 */
const CARD_MARKS_STRIP = "absolute inset-x-0 top-0 flex items-center justify-end gap-1 px-1";

/**
 * **`identityTint` used to live here and is gone**, with its five-line copy of `DeckStats`'
 * `PIP_COLOR` table. It faded a card's colour identity into the app-drawn title bar, and it was
 * the one place this component spent colour — on Magic meaning, which is the direction's rule for
 * when colour is allowed at all.
 *
 * Drawing the whole card retires it rather than replacing it: a printed frame *is* that colour, in
 * the vocabulary a player already reads, so a collapsed stack still shows the shape of a deck's
 * colours — off the cards themselves instead of off a tint derived from them. Recorded here
 * because a reader looking for the tint should find out where it went, not just that it is
 * missing.
 */

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
  /**
   * What the reader may do to a card here, or nothing — see {@link DeckCardActions}.
   *
   * **It cannot change the stack's height, and that is checked rather than intended**: the
   * controls are drawn over the card, absolutely positioned, so they take no space at all.
   * {@link stackHeight} is still a function of the count alone.
   */
  actions?: DeckCardActions;
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
export function CardStack({
  cards,
  label,
  violations,
  onSelect,
  actions,
  className,
}: CardStackProps) {
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
          actions={actions}
        />
      ))}
    </ul>
  );
}

/**
 * One card in the stack: **the whole card**, with the app's marks over it.
 *
 * It used to be a card frame rebuilt out of the app's own parts — a 30px title bar, a 256px
 * window on the `art` crop, a 24px data line — which meant the reader could see the
 * illustration and nothing else: no printed frame, no type line, no rules text, no P/T. A deck
 * list whose point is *what is in this deck* was showing the one part of a card that does not
 * say.
 *
 * So the picture is now the `grid` variant and it is the card: name, cost, art, type, text and
 * P/T, in the printed layout every player already reads. What the app still has to say — how
 * many copies, which tag, whether it is short, what this printing costs — is drawn **over** it
 * in two strips, and everything printed underneath that they duplicate is given up
 * deliberately (see {@link CARD_MARKS_STRIP}).
 *
 * Not `CardArt`, which is the 5:7 box with its own no-art fallback and retry: the height here is
 * a constant the stack's arithmetic depends on, and the fallback has to fill exactly it. It
 * borrows `FoilOverlay`, which is the same trade the card detail pane's main art makes and for
 * the same reason — what the surfaces must agree on is the marking.
 *
 * **This is also what closes the artist-credit gap on this surface.** Scryfall's image policy
 * requires the illustrator to be named wherever the bare art crop is shown; a printed card
 * carries its own credit, so drawing the whole card satisfies the rule with nothing added.
 */
function StackedCard({
  card,
  ruleBreakText,
  onSelect,
  actions,
}: {
  card: DeckCard;
  /** The sentence the `RULE BREAK` mark carries, or `null` when there is nothing wrong. */
  ruleBreakText: string | null;
  onSelect?: (card: DeckCard) => void;
  actions?: DeckCardActions;
}) {
  const dragRef = useDeckCardDrag(card, actions?.drop !== undefined);
  // The whole card (`grid`, 488×680), not the `art` crop. Fed `null` for an orphan, whose
  // printing has left the card database — nothing tries to draw a picture of a card that is not
  // there, and the hook's null story is "no state machine at all".
  const face = useImageRetry(
    card.needsReview === null ? cardImageUrl(card.cardId, 0, DECK_CARD_VARIANT) : null,
  );
  const finish = soleFinish(card.finishes);
  // The allocator claims no copy for an inactive category, so every row in one reads 0 owned
  // by construction — a shortage mark there would report one the reader does not have. The
  // switch, never the kind: a Maybeboard switched *on* is short of copies like any other pile.
  const short = card.categoryActive && card.ownedQuantity < card.quantity;

  return (
    <li
      ref={dragRef}
      className={cn(
        // `group`, so the controls below can be revealed by the same two states that lift the
        // card. Nothing else in a stack carries one, so the unqualified variant is unambiguous.
        "group relative block overflow-hidden rounded-md border shadow-lg",
        // Collapsed, pulled up over its neighbour; lifted, standing 8px clear of it. The
        // margin is the whole animation — nothing scales, nothing translates — because a
        // margin is what pushes the cards *after* it down, which is the interaction this is
        // named for.
        //
        // Written out as literals rather than built from the constants above, because
        // Tailwind scans source text for whole class names and a class assembled at runtime
        // emits no rule at all. `a stacked card is pulled up by exactly one card's advance`
        // is what keeps the two spellings of −261 and 8 in step.
        //
        // `focus-within:` beside every `hover:`: a stack only a mouse can read is a stack
        // half the readers cannot.
        "mb-[-261px] hover:mb-2 focus-within:mb-2",
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
        // Every mark below is `aria-hidden`, so this string is the whole of what a keyboard
        // reader gets — including the red shortage figure, which nothing else would say.
        aria-label={deckCardName(card, ruleBreakText)}
        // How the card pane hands the caret back after a printing swap replaces this card.
        {...deckCardProps(card)}
        onClick={onSelect ? () => onSelect(card) : undefined}
        // Inset, because this button fills an `overflow-hidden` card: an outline standing off
        // its edge is painted entirely in the clipped region and is never seen.
        className={cn("block w-full cursor-pointer text-left", FOCUS_INSET)}
      >
        {/* The card. An explicit height rather than an `aspect-[488/680]`, because the stack's
            arithmetic depends on this number being exactly {@link STACK_IMAGE_HEIGHT} — and it is
            set here, from the constant, so the frame and the file's own sums cannot drift.

            `object-cover` against a 210:293 box where the card is 210:292.6, which crops **0.4px**
            off it. Worth taking over `object-contain`: a fraction of a pixel of the card's border
            is invisible, and a letterbox bar between the printed frame and an overlay strip would
            not be. */}
        <span
          style={{ height: STACK_IMAGE_HEIGHT }}
          className="relative block overflow-hidden bg-surface"
        >
          {face.src && !face.failed ? (
            <CardImage
              src={face.src}
              // Decoration: the button already says the card's name, and an `alt` repeating it
              // would have a screen reader read every card twice.
              alt=""
              draggable={false}
              // Lazy, because a deck's groups are plain scrollers rather than virtualised
              // walls — a hundred-card category really is a hundred mounted cards, and the
              // browser's gate is the only thing bounding what they ask for.
              loading="lazy"
              decoding="async"
              onError={face.onError}
              className="size-full object-cover"
            />
          ) : (
            // The card's name in the fallback, which the old three-band frame did not need: the
            // title bar carried it in text, and now the only place it is written is the picture
            // that has not arrived.
            <span className="flex size-full flex-col items-center justify-center gap-1 px-2 text-center">
              <span className="text-[0.6875rem] font-medium">{card.name}</span>
              <span className="text-[0.625rem] text-dim">
                {face.retrying ? "Retrying…" : card.needsReview !== null ? "No card" : "No image"}
              </span>
            </span>
          )}

          <FoilOverlay finish={finish} />

          {/* The reveal strip: what the app knows that the printed card cannot. Over the card's
              own title bar, right-aligned, so the printed name stays readable down a collapsed
              stack — {@link CARD_MARKS_STRIP} has the reasoning. The scrim is what makes a chip
              legible over art of any brightness. */}
          <span className={cn(CARD_MARKS_STRIP, "bg-gradient-to-b from-bg/70 to-transparent py-1")}>
            {card.tagName !== null && <TagDot name={card.tagName} color={card.tagColor} />}
            {/* Gold, two letters. The `RULE BREAK` mark below is red, spelled out, and lower down
                the card — see `CardMarks.tsx` for why the pair is drawn once. */}
            {card.gameChanger === true && <GameChangerBadge />}
            <span className="shrink-0 rounded-sm bg-accent px-1 font-mono text-[0.6875rem] tabular-nums text-accent-fg">
              {card.quantity}
            </span>
          </span>

          {ruleBreakText !== null && (
            <RuleBreakMark text={ruleBreakText} className="absolute bottom-8 left-1.5" />
          )}

          {/* The data line, now the card's foot rather than a band under it: facts about the
              printing rather than about the deck, in the data face and one step dimmer. Its own
              price, per copy — a total belongs beside the deck, not on every card in it.

              It duplicates a printed set code and collector number, and earns its place anyway:
              at 210px the printed line is ~5px tall, and the **price** and the shortage figure are
              the app's own facts that no card carries. */}
          <span className="absolute inset-x-0 bottom-0 flex h-6 items-center gap-1.5 bg-bg/85 px-1.5 font-mono text-[0.625rem] text-dim">
            <RarityGem rarity={card.rarity} />
            <span className="min-w-0 flex-1 truncate">
              {card.setCode.toUpperCase()} · {card.collectorNumber}
            </span>
            <span className="shrink-0 tabular-nums text-text">{usdPrice(card.unitPriceUsd)}</span>
            {/* Drawn only where it says something: a fully covered card prints nothing at all,
                because sixty ticks are sixty things to read past on the way to the three that
                matter. Decoration, like every other mark on this card — the words are in the
                button's name, which is the only place inside a labelled button that is read. */}
            {short && (
              <span
                aria-hidden="true"
                title={`You own ${card.ownedQuantity} of the ${card.quantity} this deck wants`}
                className="shrink-0 tabular-nums text-destructive"
              >
                {card.ownedQuantity}/{card.quantity}
              </span>
            )}
          </span>
        </span>
      </button>

      {/* **Over the card, never in it.** An absolutely positioned bar takes no height, so a
          card is still {@link STACK_CARD_HEIGHT} and `stackHeight` is still a function of the
          count alone — the no-reflow property survives the controls by construction rather
          than by care. `bottom-6` clears the data line's own `h-6`, so the stepper sits above it
          with the printing and the price still readable under it — unchanged by the card face
          moving in behind them, because both were already overlays on the same box.

          A **sibling** of the button rather than a child, because a button may not contain a
          button: the whole card is the control that opens it, and these are three more. */}
      <DeckCardControls
        card={card}
        actions={actions}
        className={cn("absolute inset-x-0 bottom-6 px-1", REVEALED_ON_CARD)}
      />
    </li>
  );
}
