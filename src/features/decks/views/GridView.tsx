/**
 * The deck as a wall of cards: every card drawn, none of them covering another.
 *
 * The stack's opposite. A stack is for reading *down* a category; this is for seeing a whole
 * deck at once — which is what you want the moment before you cut something.
 */
import { useRef } from "react";
import { DROP_OVER, DROP_RING } from "@/components/AppShell";
import { CardImage } from "@/components/CardImage";
import { FoilOverlay } from "@/components/CardArt";
import { RarityGem } from "@/components/RarityGem";
import { scaled } from "@/lib/cardZoom";
import { soleFinish } from "@/lib/finish";
import { cardImageUrl } from "@/lib/images";
import type { DeckCard } from "@/lib/ipc";
import type { Currency, Marketplace } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { useCardZoomGesture } from "@/lib/useCardZoomGesture";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";
import { GameChangerBadge, RuleBreakMark, TagDot } from "../CardMarks";
import {
  DECK_CARD_VARIANT,
  deckCardName,
  deckCardMenuProps,
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

/**
 * A tile at 1×, and the two strips of chrome around it — the wall's whole geometry, and every
 * one of these was a Tailwind literal before the reader could zoom.
 *
 * `TILE_WIDTH` is the size this wall has always drawn, `CAPTION_HEIGHT` its foot (`h-5`),
 * `CAPTION_TEXT` the type in it (`text-[0.5625rem]`, which is 9px against a 16px root) and
 * `TILE_GAP` the gutter between tiles (`gap-2.5`). They are constants here rather than classes
 * there because **a computed Tailwind class emits no CSS rule at all** — the scanner reads
 * source text, so a width class built by interpolation produces nothing and the tile silently
 * loses its width. Anything that moves with the zoom is an inline style.
 *
 * (The three classes still named above are ones the app uses elsewhere. The tile's own width
 * literal is deliberately *not* spelled anywhere in this file, comments included: this file is
 * under Tailwind's `@source`, so writing it would go on emitting a rule for a utility nothing
 * uses.)
 */
const TILE_WIDTH = 150;
const CAPTION_HEIGHT = 20;
const CAPTION_TEXT = 9;
const TILE_GAP = 10;

/**
 * A base that **grows with the zoom and never shrinks below itself** — the rule for everything on
 * this wall that is not the card.
 *
 * The card is a picture and scales in both directions honestly; the things around it do not. Type
 * has a floor (9px is already the smallest this app writes anything, and 4px is not type), and a
 * 10px gutter is what stops a wall of cards reading as one sheet — halve it at 0.5× and the tiles
 * touch, which is precisely the zoom a reader chose in order to see more cards at once.
 *
 * So they hold at the bottom and grow at the top, where the opposite failure waits: a 2× tile
 * under a 20px caption is a card that has outgrown its label. It is `CardStack`'s
 * `stackAdvance` argument and `CardGrid`'s caption argument, which is three surfaces reaching the
 * same answer independently — a plain `scaled()` here would be a legibility bug at half size.
 */
function atLeast(base: number, zoom: number): number {
  return Math.max(base, scaled(base, zoom));
}

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
  // One read for the whole wall, passed down rather than read per tile: a hundred-card deck is a
  // hundred `GridCard`s, and a hundred store subscriptions to answer one number they all share.
  //
  // **`deck`, which is `StackView`'s key too, and the sharing is the decision.** This view and
  // that one are one deck drawn two ways — every card at once here, a stack per pile there — so a
  // reader who sizes the deck in Stacks and presses `Grid` must find it the size they left it. A
  // section each would make the toolbar's view switch a resize, and changing drawings is not a
  // request for bigger cards. What is *not* shared is the docked search column beside the desk
  // (`deckSearch`): that wall and this one are on screen together answering different questions,
  // which is why `cardZoom` holds a number per section at all.
  const cardZoom = useAppStore((s) => s.cardZoom.deck);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Ctrl+wheel, on this element because this is the one that scrolls — the group sections and
  // the tiles inside it do not, and a wheel over the gap between two groups belongs to neither.
  // The hook attaches a native non-passive listener, which is the only kind that may
  // `preventDefault`; without that WebView2 zooms the whole window on top of the wall.
  //
  // `"deck"` again, and it has to be the literal the read above uses and the one `StackView`
  // passes: a gesture writing one section while the geometry read another would step a number
  // this wall never draws.
  useCardZoomGesture(scrollRef, "deck");

  return (
    // Down the page rather than across it: a wall wraps, so the columns the other two views
    // pack into are the window's own width here.
    <div
      ref={scrollRef}
      className={cn("flex min-w-0 flex-1 flex-col gap-5 overflow-auto", className)}
    >
      {groups.map((group) => (
        <GridGroup
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
  zoom,
}: {
  group: CardGroup;
  marketplace: Marketplace;
  violations?: Map<string, ValidationIssue[]>;
  onSelect?: (card: DeckCard) => void;
  actions?: DeckCardActions;
  /** How large the reader is drawing cards, from the wall above. */
  zoom: number;
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
      {/* The wall's gutter grows with the tiles and holds at 10px below 1× ({@link atLeast}):
          the same fixed `gap-2.5` around 300px cards reads as a wall with no seams, and a halved
          one around 75px cards reads as one sheet of card backs. Inline, because a scaled number
          cannot be a class. */}
      {group.cards.length === 0 ? (
        <p className="px-0.5 text-xs text-dim">Nothing here yet.</p>
      ) : (
        <ul
          aria-label={group.name}
          style={{ gap: atLeast(TILE_GAP, zoom) }}
          className="flex flex-wrap"
        >
          {group.cards.map((card) => (
            <GridCard
              key={card.id}
              card={card}
              currency={marketplace.currency}
              ruleBreakText={ruleBreak(violations?.get(card.cardId))}
              onSelect={onSelect}
              actions={actions}
              zoom={zoom}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One card as a 150px tile — 150px at 1×, and {@link TILE_WIDTH} scaled at every other stop:
 * **the whole card**, with the app's marks over it.
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
  zoom,
}: {
  card: DeckCard;
  /** How the tile's foot writes the row's one unit price. */
  currency: Currency;
  ruleBreakText: string | null;
  onSelect?: (card: DeckCard) => void;
  actions?: DeckCardActions;
  /** How large the reader is drawing cards. The tile's width is the only thing it decides
   *  outright — the picture follows by aspect ratio, and the foot follows by
   *  {@link atLeast}. */
  zoom: number;
}) {
  const dragRef = useDeckCardDrag(card, actions?.drop !== undefined);
  // The whole card, the same `grid` variant the stack draws. `null` for an orphan — nothing
  // fetches a picture of a card that is not in the database.
  const face = useImageRetry(
    card.needsReview === null ? cardImageUrl(card.cardId, 0, DECK_CARD_VARIANT) : null,
  );
  // The foot and its type, which grow with the tile and never shrink under it. Computed once
  // here because three things read the height: the strip itself, the type inside it, and the
  // controls that sit directly above it.
  const captionHeight = atLeast(CAPTION_HEIGHT, zoom);
  const captionText = atLeast(CAPTION_TEXT, zoom);

  return (
    <li
      ref={dragRef}
      // The whole tile, art and foot: a right-click on the rarity gem or the price is a
      // right-click on the card. The keydown rides here too, so Shift+F10 with the caret on the
      // stepper drawn over the art still asks about this card.
      {...deckCardMenuProps(card, actions)}
      // The width is the tile's whole geometry — the picture below is `aspect-[488/680]`, so its
      // height follows without a second number to keep in step. An inline style rather than the
      // fixed width utility this used to carry: Tailwind scans source text for whole class
      // names, so an interpolated one emits no rule and the tile collapses to its content.
      style={{ width: scaled(TILE_WIDTH, zoom) }}
      className={cn(
        "group relative overflow-hidden rounded-md border bg-surface",
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
        {/* The whole card at this tile's width, whatever the zoom has made that —
            `aspect-[488/680]` rather than a pixel height, because unlike the stack nothing here
            does arithmetic on it, and a ratio needs no second number kept in step. */}
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

        {/* The foot, and the one part of a tile that is not the card: a rarity gem and this
            printing's price. Both of its numbers are inline styles rather than `h-5` and a
            `text-[…]` literal, because both move with the zoom — a 300px card over a 20px strip
            of 9px type is a card that has outgrown its label, and the strip has to be tall
            enough to hold whatever type it is given or the gem clips. */}
        <span
          style={{ height: captionHeight, fontSize: captionText }}
          className="flex items-center gap-1 px-1.5 font-mono text-dim"
        >
          <RarityGem rarity={card.rarity} />
          <span className="ml-auto shrink-0 tabular-nums text-text">
            {formatPrice(card.unitPrice, currency)}
          </span>
        </span>
      </button>

      {/* Over the art, as in the stack. Absolute, so the tile is exactly as wide and as tall as
          its card whatever it holds — which is what let the `Move…` select be removed on
          2026-08-14 without a number here changing: 150px was too narrow for a stepper and a
          select on one line, so the controls' own `flex-wrap` used to put the select on a
          second, and a bar that takes no height cost the tile nothing either way.

          The positioning is a wrapper's rather than the controls' own `className`, and that is
          the zoom's doing: the bar sits directly on top of the foot, so its offset is the foot's
          height — a computed number, and `DeckCardControls` takes a class string and no style. An
          offset utility was that number while the foot was always 20px. */}
      <span style={{ bottom: captionHeight }} className="absolute inset-x-0 px-1">
        <DeckCardControls card={card} actions={actions} className={REVEALED_ON_CARD} />
      </span>
    </li>
  );
}
