/**
 * The deck as a wall of cards: every card drawn, none of them covering another.
 *
 * The stack's opposite. A stack is for reading *down* a category; this is for seeing a whole
 * deck at once — which is what you want the moment before you cut something.
 */
import { useRef } from "react";
import { CardChin } from "@/components/CardChin";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { atLeast, cardScaleVars, scaled } from "@/lib/cardZoom";
import { DROP_MARK_ROOM, DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import { playedFinish } from "@/lib/finish";
import { finishTreatments } from "@/lib/treatment";
import { FOCUS, FOCUS_INSET } from "@/lib/focus";
import type { DeckCard } from "@/lib/ipc";
import type { Currency, Marketplace } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { useCardZoomGesture } from "@/lib/useCardZoomGesture";
import { cn } from "@/lib/utils";
import {
  deckCardBodyProps,
  deckCardDimmed,
  deckCardName,
  deckCardMenuProps,
  deckCardMarked,
  deckCardPress,
  deckCardProps,
  deckCardSelectedProps,
  deckCardShort,
  DeckCardControls,
  deckGroupMenuProps,
  deckGroupProps,
  deckGroupRename,
  REVEALED_ON_CARD,
  SELECTED_CARD,
  useCategoryDrop,
  useDeckCardDrag,
  type DeckCardActions,
} from "../cardControl";
import { DeckCardFace } from "../DeckCardFace";
import { theoryMatchMark, type TheoryMark, type TheoryPlan } from "../theoryMatch";
import { DropIndicator } from "../DropIndicator";
import type { CardGroup } from "../grouping";
import { ruleBreak } from "../violations";
import type { ValidationIssue } from "../validation/types";
import { splitRail } from "./columns";
import { GroupHeader } from "./GroupHeader";

/**
 * A tile at 1× and the gutter around it — what is left of the wall's geometry, and both of these
 * were a Tailwind literal before the reader could zoom.
 *
 * `TILE_WIDTH` is the size this wall has always drawn and `TILE_GAP` the gutter between tiles
 * (`gap-2.5`). **The tile's foot is neither of them any more**: it is `chinHeight(zoom)` out of
 * `lib/cardZoom.ts`, drawn by `components/CardChin` — one bar, one height and one type size
 * across every surface in the app that draws a card, where this view used to hold a pair of
 * numbers of its own and had drifted from both of its siblings.
 *
 * They are constants here rather than classes there because **a computed Tailwind class emits no
 * CSS rule at all** — the scanner reads source text, so a width class built by interpolation
 * produces nothing and the tile silently loses its width. Anything that moves with the zoom is
 * an inline style.
 *
 * (The one class still named above is one the app uses elsewhere. The tile's own width literal
 * is deliberately *not* spelled anywhere in this file, comments included: this file is under
 * Tailwind's `@source`, so writing it would go on emitting a rule for a utility nothing uses.)
 */
const TILE_WIDTH = 150;
const TILE_GAP = 10;

export function GridView({
  groups,
  marketplace,
  tracksCollection,
  violations,
  theoryPlan,
  onSelect,
  actions,
  selectedSlot,
  landed,
  className,
}: {
  groups: readonly CardGroup[];
  /** Which marketplace every price in this view is quoted from — the heading's total and each
   *  tile's own unit price. */
  marketplace: Marketplace;
  /**
   * Does this deck read the collection at all? `deckKind.ts`'s `tracksCollection(deck)`, `false`
   * for a **virtual** deck (issue #401) — the kind the reader tracks without owning the
   * cardboard.
   *
   * Handed down whole like `theoryPlan` and `violations` below it, and for their reason: one fact
   * about the deck that every tile on the wall is drawn against. What it decides here is
   * `deckCardShort` — the red `3/4` in a tile's chin, which this view has drawn since 2026-09-08,
   * and the *you own 3 of 4* clause in the tile's accessible name. A virtual deck has no
   * `collection_folders` group, so it can draw on no pool at all, every row reads 0 owned and
   * **every** tile would wear the mark: the hundred red marks issue #354 reported on a plan
   * (2026-08 to 2026-09-03), reached by a different route. The plan's own case is no longer an
   * arithmetic one — a theory row reads a truthful count since 2026-09-09 (issue #435) and
   * `deckCardShort` passes it over by choice — but a virtual deck's still is.
   *
   * **`card.variant` cannot answer it**: a virtual deck's rows are ordinary `live` rows on
   * purpose, because `DeckRow.cardCount` and the gallery's colour bar both count
   * `variant = 'live'`.
   *
   * **Required, like `marketplace` above it and like every other view's.** The four views are one
   * deck drawn four ways, and a prop required on one and defaulted on the next is how they come
   * to disagree about a deck one toolbar press apart.
   */
  tracksCollection: boolean;
  violations?: Map<string, ValidationIssue[]>;
  /** The deck's plan — `theoryMatch.ts`'s two lookups and the deck's own two mark switches,
   *  handed down whole like `violations` beside it. `undefined` for a deck with no plan, and on
   *  the plan itself. */
  theoryPlan?: TheoryPlan;
  onSelect?: (card: DeckCard) => void;
  /** What may be done to a card here — see {@link DeckCardActions}. */
  actions?: DeckCardActions;
  /** The slot the pane is open on ({@link deckCardSlot}), so its tile wears the same gold ring a
   *  search tile does. By the slot rather than the printing, so a card filed in two piles is
   *  marked in the one the reader clicked — `CardStack` has why. */
  selectedSlot?: string | null;
  /** `deck_cards.id` → the nonce of the add that put it there. See `cardControl`'s
   *  `LandedMark`. */
  landed?: ReadonlyMap<number, number>;
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

  // **The command zone, then the deck, then everything played beside it** — `splitRail`'s three
  // runs, concatenated back into one list of full-width wrapping groups.
  //
  // This view rendered `groups` straight through until now, and on a real Commander deck that read
  // Commander → Sideboard (3 cards) → Maybeboard (19) → the deck: the two piles the reader has
  // said are *not* in the deck sat above it, roughly 900px of wall before their own columns
  // started. `StackView` and `TextView` have both called `splitRail` since it existed, so the
  // three views disagreed about where a reader's Sideboard is — which is one deck laid out two
  // ways, one toolbar press apart.
  //
  // **Ordering only, and deliberately not a rail.** The other two views draw the rail as a column
  // pinned to the right of the flow, and that is exactly what a wall must not do: a group here is
  // as wide as the desk, so a 19-card Maybeboard in a one-tile column is ~4,500px of scroll for a
  // pile that is read at a glance. Full-width groups throughout, last instead of first.
  const { command, flow, rail } = splitRail(groups);
  const ordered = [...command, ...flow, ...rail];

  return (
    // Down the page rather than across it: a wall wraps, so the columns the other two views
    // pack into are the window's own width here.
    //
    // **And "the page" is now literally the page** (changed 2026-08-14): this box is given no
    // height and grows to hold every group, so a deck taller than the window scrolls
    // `DeckEditor`'s one page scroller rather than a second scrollbar drawn inside the deck
    // builder. `overflow-x-auto` rather than nothing at all, for `StackView`'s reason — a single
    // tile at 2× is wider than a narrow desk, and the overhang has to stop here rather than
    // reach the page, where it would be an X scrollbar across the whole app. It implies
    // `overflow-y: auto`, which can never find anything to scroll in a box with no height of
    // its own.
    //
    // {@link DROP_MARK_ROOM} for `StackView`'s reason and it is the same defect, not a matching
    // spacing choice: this box clips at its padding box, and with no padding every group in the
    // wall lost its mark down both sides — the full height of the group rather than a corner,
    // since a group here is as wide as the desk. The mark that was clipped was the drop ring,
    // which has been `ring-inset` since 2026-09-03 and is now drawn within the border box where
    // nothing can reach it; `FOCUS` is what still needs the room, and is what the 6px was sized
    // for all along. See `StackView`'s note.
    <div
      ref={scrollRef}
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-5 overflow-x-auto",
        DROP_MARK_ROOM,
        className,
      )}
    >
      {ordered.map((group) => (
        <GridGroup
          key={group.key}
          group={group}
          marketplace={marketplace}
          violations={violations}
          theoryPlan={theoryPlan}
          tracksCollection={tracksCollection}
          onSelect={onSelect}
          actions={actions}
          selectedSlot={selectedSlot}
          landed={landed}
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
  theoryPlan,
  tracksCollection,
  onSelect,
  actions,
  selectedSlot,
  landed,
  zoom,
}: {
  group: CardGroup;
  marketplace: Marketplace;
  violations?: Map<string, ValidationIssue[]>;
  /** Handed through to the tiles — see {@link GridView}'s own props. */
  theoryPlan?: TheoryPlan;
  /** Handed through to the tiles — see {@link GridView}'s own props. **Required here where the
   *  wall's is optional**: this group is module-private with one mount, so a required prop costs
   *  nothing and a hop that forgets to forward it is a red build rather than a red `0/4` on every
   *  tile of a virtual deck. */
  tracksCollection: boolean;
  onSelect?: (card: DeckCard) => void;
  actions?: DeckCardActions;
  /** Handed through to the tiles — see {@link GridView}'s own props. */
  selectedSlot?: string | null;
  landed?: ReadonlyMap<number, number>;
  /** How large the reader is drawing cards, from the wall above. */
  zoom: number;
}) {
  const { attach, over, eligible } = useCategoryDrop(group.categoryId, actions?.drop);

  return (
    <section
      ref={attach}
      aria-labelledby={`grid-group-${group.key}`}
      // **The pile's own menu, on this element rather than on `GroupHeader`** - see
      // `deckGroupMenuProps`, which carries the whole reason: that header is drawn inside
      // `CategoriesDialog`'s scrimmed dialog too, and a menu opened there would paint under the
      // scrim. A card inside stops the event, so the innermost surface still wins.
      {...deckGroupMenuProps(group.categoryId, actions)}
      {...deckGroupProps(group.categoryId)}
      // The sidebar's pair, said here — one vocabulary for "this can take the card you are
      // holding" and "and it is this one" across the four views and the two screens.
      // `FOCUS` because this is where the caret comes back to when the pile's menu closes; the
      // tab index is already here from `deckGroupProps`.
      className={cn(
        "relative rounded-md",
        FOCUS,
        // **A switched-off pile is washed here as it is on the stacks** (2026-09-08), and it is
        // the ordering change above that made the absence cost something. This view drew the
        // `INACTIVE` chip and nothing else, which was survivable while a switched-off pile sat
        // wherever `sortOrder` put it among the deck's own columns; now `splitRail` puts every
        // one of them **last**, so a nineteen-card Maybeboard is the bottom of the wall — and
        // undimmed, the deck simply appears to carry on past its own end. `StackView` says it
        // three ways and this is the first of them; the second is `GroupHeader`'s dimmed name and
        // chip, which this view has always drawn, and the third is the cards' own `opacity-60`
        // below. An active pile carries none of the three: being in the deck is the default, and
        // being switched off is the fact worth spending marks on.
        !group.isActive && "bg-surface/60",
        eligible && DROP_RING,
        over && DROP_OVER,
      )}
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
      {deckGroupRename(group.categoryId, actions)}
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
          // The third of the three signals a switched-off pile carries, and the same class
          // `StackView` puts on its own `<ul>` — the cards themselves go quiet, so a reader
          // scanning the wall reads the tail of it as *not the deck* before they have read a
          // heading. `opacity` below 1 makes this a stacking context; unlike the stack's `<ul>`
          // nothing here takes `LAYER.raised`, so there is no lift for it to trap.
          className={cn("flex flex-wrap", !group.isActive && "opacity-60")}
        >
          {group.cards.map((card) => (
            <GridCard
              key={card.id}
              card={card}
              currency={marketplace.currency}
              ruleBreakText={ruleBreak(violations?.get(card.cardId))}
              theoryMark={theoryMatchMark(theoryPlan, card)}
              tracksCollection={tracksCollection}
              onSelect={onSelect}
              actions={actions}
              selected={deckCardMarked(card, selectedSlot, actions)}
              landedKey={landed?.get(card.id)}
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
 * **The face is `DeckCardFace`, which is the object `CardStack` draws** (changed here after
 * 2026-08-16's move to `components/CardArt`, which was the right fix aimed at the wrong wall).
 * That change was made because this tile had a hand-rolled copy of the *search wall's* frame and
 * had drifted from it, and it is true that a deck tile and a search tile should not be two
 * drawings of one card. But the wall docked beside the desk is not the surface this tile is one
 * toolbar press from: `Stacks | Grid` are two drawings of *this deck*, and those two had drifted
 * from each other instead — a printed frame under the picture against a 5:7 box with `CardArt`'s
 * own smaller fallback, a folded label-and-count tag against a `bg-accent` chip with a separate
 * `LabelDot` beside it, a `Game Changer` ribbon against the crown in `FoilOverlay`'s chip, and a
 * rule break drawn as an edge on one and as a ring on the other. One component is what settles it,
 * and the reader asked for this one.
 *
 * What the tile keeps for itself is the *box* the face goes in: the wrapper's own edge and resting
 * shadow, the chin under it (this view's `seam` and the deck's own shortage figure), and the
 * controls column over it. That is exactly the split `CardStack` makes.
 *
 * **No name line, and that is the app's existing answer rather than a new one.** A 150px card's
 * printed name is a few pixels tall — but the frame `DeckCardFace` draws under the picture carries
 * the name, the cost and the type line in the app's own hand, so a card is legible before its
 * bytes land and a caption would be a second answer. The button's accessible name still carries
 * the whole sentence, and `GroupHeader` still names the pile.
 */
function GridCard({
  card,
  currency,
  ruleBreakText,
  theoryMark,
  tracksCollection,
  onSelect,
  actions,
  selected,
  landedKey,
  zoom,
}: {
  card: DeckCard;
  /** How the tile's foot writes the row's one unit price. */
  currency: Currency;
  ruleBreakText: string | null;
  /** What the deck's plan says about this row — `theoryMatchMark`, resolved by the group so a
   *  tile is handed an answer rather than a plan to look itself up in. `null` is a card the plan
   *  does not ask for; otherwise the tier it is in and how far the live list is from the plan at
   *  that tier's own grain, where `0` is the card the plan asks for exactly. */
  theoryMark: TheoryMark | null;
  /** Whether the deck reads the collection at all — see {@link GridView}'s own props. Required
   *  here for {@link GridGroup}'s reason. */
  tracksCollection: boolean;
  onSelect?: (card: DeckCard) => void;
  actions?: DeckCardActions;
  /** This is the card the pane is open on. */
  selected: boolean;
  /** The nonce this tile's last add was given, or `undefined`. Passed through as the mark's
   *  `key`, so adding the same card twice replays the fade. */
  landedKey: number | undefined;
  /** How large the reader is drawing cards. The tile's width is the only thing it decides
   *  outright — the face's height follows from it by `cardFaceHeight`, and the chin follows by
   *  `chinHeight` inside `CardChin`. */
  zoom: number;
}) {
  const tip = useTooltip();
  const dragRef = useDeckCardDrag(card, actions?.drop !== undefined, actions?.groupDrag);
  // {@link deckCardShort}, which is also what `deckCardName` says this card's shortage in words
  // from — an inactive pile and a virtual deck each read 0 owned for a reason that is not an
  // empty shelf, and a theory row is passed over by a product call rather than by its number
  // (2026-09-09, issue #435). The **switch**, never the kind: a Maybeboard switched *on* is
  // short of copies like any other pile. It is the stack's figure, and this tile draws it now
  // because the two views are one card. The virtual guard is the deck's rather than the row's
  // and cannot be read off `card`, which is why it arrives as a prop.
  const short = deckCardShort(card, tracksCollection);

  return (
    <li
      ref={dragRef}
      // The whole tile, art and foot: a right-click on the rarity gem or the price is a
      // right-click on the card. The keydown rides here too, so Shift+F10 with the caret on the
      // stepper drawn over the art still asks about this card.
      {...deckCardMenuProps(card, actions)}
      // The width is the tile's whole geometry — `DeckCardFace` derives its height from this same
      // number, so there is no second measurement to keep in step. An inline style rather than the
      // fixed width utility this used to carry: Tailwind scans source text for whole class names,
      // so an interpolated one emits no rule and the tile collapses to its content.
      //
      // The two variables beside it are the other half of that geometry: everything drawn *on* the
      // card — the copy count, the label, the rule break, the gem, the stepper — sizes itself
      // against them rather than taking a prop, because each of those marks is also drawn in the
      // table and text views, where nothing zooms. See `MARK_SCALE_VAR` in `lib/cardZoom.ts`.
      style={{ width: scaled(TILE_WIDTH, zoom), ...cardScaleVars(zoom) }}
      // The tile is the card's whole body, so a press on the chin under the card or on the
      // control bar over it — both siblings of the button rather than part of it — does not read
      // as a click on the desk. See `cardControl`'s `CARD_BODY_ATTR`.
      {...deckCardBodyProps()}
      {...deckCardSelectedProps(selected)}
      className={cn(
        // **The stacked card's own wrapper, class for class.** This was `group relative` and
        // nothing else from 2026-08-16 until the two views became one card: a bare positioned box
        // around a `CardArt` frame that supplied its own edge. A stacked card is `rounded-lg
        // border` with the face inset at `rounded-[7px]` and the chin riding onto that border, so
        // the tile has to carry the same edge or the shared face would sit in two different
        // objects on two drawings of one deck.
        //
        // **`group` stays, and it is the one thing here that is not the stack's.** The stack
        // reveals its controls by which card is *open* — a collapsed card shows 34px of itself, so
        // `group-hover:` would arm a bar hundreds of pixels below the strip under the pointer.
        // Nothing overlaps a tile on this wall, so the pointer is the honest question and
        // `REVEALED_ON_CARD` hangs off this class.
        "group relative block rounded-lg border",
        // Deeper than Tailwind's own `shadow-lg`/`shadow-2xl`, whose alphas are 0.1 and 0.25 —
        // written for a card on white. These sit on the app's felt at 0.16 lightness, where a
        // 10 % shadow is not a shadow. The stack's *resting* shadow and not its open one: a tile
        // on this wall is never fanned out of anything, so there is no second state to draw.
        "shadow-[0_10px_15px_-3px_rgb(0_0_0/0.45),0_4px_6px_-4px_rgb(0_0_0/0.45)]",
        // Where the caret lands when this tile's menu closes — `deckCardMenuProps` is what makes
        // the tile focusable, and a hand-back the reader cannot see is half a hand-back. Outset
        // where the button inside is inset, because the outline is drawn outside this box rather
        // than in the region it clips.
        FOCUS,
        // A card that breaks a rule is outlined in the destructive colour, which is the stack's
        // answer and is now this view's. It used to be a `ring-2 ring-destructive` on the face,
        // over a neutral `CardArt` edge — the right answer while the face had an edge of its own
        // and the wrapper had none, and the wrong one now: the wrapper *is* the card's edge here
        // exactly as it is on a stacked card, and `CardChin`'s `tone` below carries the colour
        // through the foot so the outline is one colour all the way round.
        ruleBreakText ? "border-destructive" : "border-border",
        // Outside all of that, and therefore never confusable with the card's own edge: a ring is
        // painted beyond the border box, so a picked card that also breaks a rule wears a gold
        // ring around a red card rather than one edge arguing with itself. See `SELECTED_CARD`.
        selected && SELECTED_CARD,
        // What the game-changer spotlight fades. It marks the cards that are *not* game changers
        // and is inert until the toolbar's count puts the attribute on an ancestor — see
        // `deckCardDimmed` and the rule in `index.css`. It goes on this element because the tile
        // is the card's whole body: face, chin, controls and all fade together.
        deckCardDimmed(card.gameChanger),
      )}
    >
      <button
        type="button"
        aria-label={deckCardName(card, ruleBreakText, theoryMark, tracksCollection)}
        {...deckCardProps(card)}
        {...deckCardPress(card, onSelect, actions)}
        // Inset, for the stacked card's reason: the button *is* the card face, whose edge sits 1px
        // inside the card's own border with the chin butted against its bottom, so an outline
        // standing 2px off it is drawn over both and reads as a thicker card rather than as focus.
        className={cn("block w-full cursor-pointer text-left", FOCUS_INSET)}
      >
        {/* The card, which is one component with the stacked card's — see `DeckCardFace`. The
            width is the tile's own and the face's height falls out of it, so the picture, the
            printed frame under it, the marks strip and the rule break are one drawing on both
            views — the game changer included, since the crown folded into the quantity tag and
            left this component with nothing to decide between two widths.

            No zoom goes with it: everything drawn on the card reads `--mark-scale`, which the
            `<li>` above publishes. */}
        <DeckCardFace
          card={card}
          width={scaled(TILE_WIDTH, zoom)}
          ruleBreakText={ruleBreakText}
          theoryMark={theoryMark}
          landedKey={landedKey}
        />
      </button>

      {/* **The card's foot, and a sibling of the button rather than a child of it.**

          It said a rarity and a price in 9px type on a 20px strip with no felt and no edges, and
          left out which printing the card *is* — the one fact a reader comparing two copies of one
          card needs. It is `components/CardChin` now, the same object `CardStack` draws, so a deck
          read in one view and then the other says the same things in the same order.

          **Outside the button for the reason that component states, and this view is why it is
          worth restating**: everything in the chin is a *fact* rather than a mark, and a button's
          `aria-label` replaces its content outright — so inside it the printing and the price had
          no reader at all. That was survivable while the foot held a gem and a price; the move to
          the shared chin put the set, the number and the finish in there too, which would have
          been three more facts drawn where nothing announces them. `deckCardName` carries none of
          the five.

          **The consequence is that the foot no longer opens the card**, which is exactly what the
          stacked card already does — the two views agree afterwards, where before this one had a
          ~28px strip of the tile that opened the pane and the other did not.

          It is still inside the tile, which is the card's whole body: the `<li>` carries
          `deckCardBodyProps()` and `deckCardMenuProps`, so a press on the gem or the price is
          still a press on *this card* rather than on the desk behind it, and a right-click there
          still asks about this card. */}
      <CardChin
        zoom={zoom}
        rarity={card.rarity}
        setCode={card.setCode}
        collectorNumber={card.collectorNumber}
        // The code is what fits; the set's name is one hover away, exactly as on the stacked card
        // — `PF26` is not a word anybody knows, and the hint being on one of two drawings of one
        // deck is the drift this view exists to remove. `null` for an orphan, whose `setName`
        // `cards` no longer has: then the code stands on its own rather than being annotated with
        // a guess.
        printingTitle={card.setName === null ? null : `${card.setName} · #${card.collectorNumber}`}
        finish={playedFinish(card.finish, card.finishes)}
        treatments={finishTreatments(card.promoTypes, playedFinish(card.finish, card.finishes))}
        money={formatPrice(card.unitPrice, currency)}
        // The card's own edge, and the two must move together — see `CardChin`'s `tone`.
        //
        // **This prop was deliberately absent while the tile's face was `CardArt`**, and the
        // argument for the absence expired with the premise rather than being overruled. It ran:
        // `CardArt` draws a neutral edge of its own, a rule break here is the `ring-2` outside
        // that edge, so reddening only the chin would run the outline grey down the art and red
        // across the foot. Every clause of that was about a card whose edge belonged to the
        // picture. The tile is `rounded-lg border` now, like a stacked card, and its border is the
        // rule break's — so a neutral chin would put 28px of `border-border` back through the left
        // and right edges of that outline, which is the one thing the outline exists to prevent.
        tone={ruleBreakText !== null ? "destructive" : "default"}
        // **`"card"`, where it was `"art"`.** The face inside the button clips its own corners at
        // `rounded-[7px]` and this tile carries the border, so the chin draws sides only and rides
        // onto the card's own border rather than supplying a bottom edge of its own — the stacked
        // card's arrangement exactly, and now for the same reason. `"art"` is what a bare
        // `CardArt` frame needs, and there is no longer one here.
        seam="card"
        // **The shortage, and it is drawn only where it says something**: a fully covered card
        // prints nothing at all, because sixty ticks are sixty things to read past on the way to
        // the three that matter. It is the deck's own fact — the one slot no other surface's chin
        // fills — and this wall drew it nowhere until the two card-face views became one card.
        //
        // `aria-hidden` even out here, outside the button: the button beside it already says the
        // shortage in words, and a screen reader should not hear "1 slash 2" as well.
        extra={
          short ? (
            <span
              aria-hidden="true"
              // Redundant with `deckCardName`'s own "you own N of M" clause — the button beside
              // this figure already says the shortage in words.
              {...tip(`You own ${card.ownedQuantity} of the ${card.quantity} this deck wants`, {
                describes: false,
              })}
              className="shrink-0 tabular-nums text-destructive"
            >
              {card.ownedQuantity}/{card.quantity}
            </span>
          ) : undefined
        }
      />

      {/* **Over the card, never in it** — the stacked card's column, at the stacked card's offset.
          An absolutely positioned column takes no height, so the tile is exactly as wide and as
          tall as its card whatever it holds.

          It was a full-width bar sitting on the chin's top edge at `bottom: chinHeight(zoom)`,
          which is where a 150px tile could fit a stepper and the `Move…` select beside it; that
          select was removed on 2026-08-14 and the bar has been one control on one line ever since.
          The column is the stack's answer to the same question and needs no computed offset at
          all: `top-9` clears the 27px title bar the quantity tag and the plan's tick are in, and
          the controls run down the card's right margin from there.

          **Revealed on hover, not by an open state**, which is the one place this tile is not the
          stack: `revealedWhenOpen` asks which card the pile has fanned out, and a wall has no such
          card. `REVEALED_ON_CARD` hangs off the `<li>`'s `group`.

          A **sibling** of the button rather than a child, because a button may not contain a
          button: the whole face is the control that opens the card, and these are more. */}
      <DeckCardControls
        card={card}
        actions={actions}
        layout="card-column"
        className={cn("absolute top-9 right-1.5", REVEALED_ON_CARD)}
      />
    </li>
  );
}
