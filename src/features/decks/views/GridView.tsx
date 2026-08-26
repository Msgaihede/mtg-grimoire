/**
 * The deck as a wall of cards: every card drawn, none of them covering another.
 *
 * The stack's opposite. A stack is for reading *down* a category; this is for seeing a whole
 * deck at once — which is what you want the moment before you cut something.
 */
import { useRef } from "react";
import { CardArt } from "@/components/CardArt";
import { CardChin } from "@/components/CardChin";
import { atLeast, cardScaleVars, chinHeight, scaled } from "@/lib/cardZoom";
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
import { RuleBreakMark, TagDot, TheoryMatchMark } from "../CardMarks";
import {
  DECK_CARD_VARIANT,
  deckCardBodyProps,
  deckCardName,
  deckCardMenuProps,
  deckCardMarked,
  deckCardPress,
  deckCardProps,
  deckCardSelectedProps,
  DeckCardControls,
  deckGroupMenuProps,
  deckGroupProps,
  deckGroupRename,
  LandedMark,
  REVEALED_ON_CARD,
  SELECTED_CARD,
  useCategoryDrop,
  useDeckCardDrag,
  type DeckCardActions,
} from "../cardControl";
import { theoryMatchDelta } from "../theoryMatch";
import { DropIndicator } from "../DropIndicator";
import type { CardGroup } from "../grouping";
import { ruleBreak } from "../violations";
import type { ValidationIssue } from "../validation/types";
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
  violations,
  theoryMatches,
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
  violations?: Map<string, ValidationIssue[]>;
  /** What the deck's plan says about each row — `theoryMatch.ts`'s map of slot → how far the
   *  live list is from the planned count, handed down whole like `violations` beside it.
   *  `undefined` for a deck with no plan, and on the plan itself. */
  theoryMatches?: ReadonlyMap<string, number>;
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
    // spacing choice: a group's ring is painted outside its border box, this box clips at its
    // padding box, and with no padding every group in the wall lost the ring down both of its
    // sides — the full height of the group rather than a corner, since a group here is as wide as
    // the desk.
    <div
      ref={scrollRef}
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-5 overflow-x-auto",
        DROP_MARK_ROOM,
        className,
      )}
    >
      {groups.map((group) => (
        <GridGroup
          key={group.key}
          group={group}
          marketplace={marketplace}
          violations={violations}
          theoryMatches={theoryMatches}
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
  theoryMatches,
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
  theoryMatches?: ReadonlyMap<string, number>;
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
      className={cn("relative rounded-md", FOCUS, eligible && DROP_RING, over && DROP_OVER)}
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
          className="flex flex-wrap"
        >
          {group.cards.map((card) => (
            <GridCard
              key={card.id}
              card={card}
              currency={marketplace.currency}
              ruleBreakText={ruleBreak(violations?.get(card.cardId))}
              theoryDelta={theoryMatchDelta(theoryMatches, card)}
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
 * **The frame is `components/CardArt`, which is the same object the search wall draws** (changed
 * 2026-08-16). It used to be a hand-rolled copy of it — its own `useImageRetry` call, its own
 * `aspect-[488/680]` box, its own no-image fallback, its own `FoilOverlay` — and the copy had
 * drifted in every way a copy does: `rounded-md` against the wall's `rounded-lg`, a second
 * spelling of the aspect ratio (488/680 rather than `CARD_ASPECT`'s `5 / 7`), a fallback at 9.5px
 * against the wall's 12, and no hover lift at all. A reader looking at the docked search column
 * and the deck laid out beside it was looking at two different drawings of one thing, on the same
 * screen. `CardArt`'s own doc has always claimed to be the one definition; this view is the
 * surface that had opted out.
 *
 * What stays this view's own is what a card *in a deck* says and a card in a wall does not: the
 * copy count, the reader's tag, the rule break, the landed flash and the stepper. They are laid
 * in the corners the wall leaves free — see the tile's body.
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
  theoryDelta,
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
  /** What the deck's plan says about this row — `theoryMatchDelta`, resolved by the group so a
   *  tile is handed an answer rather than a map to look itself up in. `null` is a card the plan
   *  does not ask for, `0` the card it asks for exactly. */
  theoryDelta: number | null;
  onSelect?: (card: DeckCard) => void;
  actions?: DeckCardActions;
  /** This is the card the pane is open on. */
  selected: boolean;
  /** The nonce this tile's last add was given, or `undefined`. Passed through as the mark's
   *  `key`, so adding the same card twice replays the fade. */
  landedKey: number | undefined;
  /** How large the reader is drawing cards. The tile's width is the only thing it decides
   *  outright — the picture follows by aspect ratio, and the foot follows by `chinHeight`. */
  zoom: number;
}) {
  const dragRef = useDeckCardDrag(card, actions?.drop !== undefined, actions?.groupDrag);
  // The card's foot, the same object the stacks draw — see `components/CardChin.tsx`. The
  // controls bar below is positioned off this number, which is why it is still a local.
  const footHeight = chinHeight(zoom);

  return (
    <li
      ref={dragRef}
      // The whole tile, art and foot: a right-click on the rarity gem or the price is a
      // right-click on the card. The keydown rides here too, so Shift+F10 with the caret on the
      // stepper drawn over the art still asks about this card.
      {...deckCardMenuProps(card, actions)}
      // The width is the tile's whole geometry — `CardArt` below is `CARD_ASPECT`, so its height
      // follows without a second number to keep in step. An inline style rather than the fixed
      // width utility this used to carry: Tailwind scans source text for whole class names, so an
      // interpolated one emits no rule and the tile collapses to its content.
      //
      // The two variables beside it are the other half of that geometry: everything drawn *on* the
      // card — the copy count, the tag, the rule break, the gem, the stepper — sizes itself against
      // them rather than taking a prop, because each of those marks is also drawn in the table and
      // text views, where nothing zooms. See `MARK_SCALE_VAR` in `lib/cardZoom.ts`.
      style={{ width: scaled(TILE_WIDTH, zoom), ...cardScaleVars(zoom) }}
      // The tile is the card's whole body, so a press on the chin under the card or on the
      // control bar over it — both siblings of the button rather than part of it — does not read
      // as a click on the desk. See `cardControl`'s `CARD_BODY_ATTR`.
      {...deckCardBodyProps()}
      {...deckCardSelectedProps(selected)}
      className={cn(
        // **No box of its own** (changed 2026-08-16): this used to be `rounded-md border
        // bg-surface`, a slab with the card inset in it and the foot painted on the same felt,
        // against a search tile that is the card and a caption line under it. The two read as
        // different objects on one screen. What is left is the wall's own wrapper — a positioned
        // `group`, which is what `CardArt`'s hover lift and the controls' reveal both hang from.
        "group relative",
        // Where the caret lands when this tile's menu closes — `deckCardMenuProps` is what makes
        // the tile focusable, and a hand-back the reader cannot see is half a hand-back. Outset
        // where the button inside is inset, because the outline is drawn outside this box rather
        // than in the region it clips.
        FOCUS,
        // The search wall's own recipe, on the outermost element — so a picked tile that also
        // breaks a rule keeps both marks and neither is drawn over the other. See
        // `SELECTED_CARD`, which says why this is here rather than on the card's face.
        selected && SELECTED_CARD,
      )}
    >
      <button
        type="button"
        aria-label={deckCardName(card, ruleBreakText, theoryDelta)}
        {...deckCardProps(card)}
        {...deckCardPress(card, onSelect, actions)}
        // Inset, for the stacked card's reason: the button holds a face that clips its own
        // corners, and an outline standing off its edge lands on the tile's own gap.
        className={cn("block w-full cursor-pointer text-left", FOCUS_INSET)}
      >
        {/* The card's face, and the box the deck's own marks are positioned against — which is
            why `CardArt` is wrapped rather than given them: it takes no children.

            `overflow-hidden rounded-lg` is `CardArt`'s own pair repeated one level out, so a mark
            laid over the picture is clipped by the same corner the picture is. */}
        <span
          className={cn(
            "relative block overflow-hidden rounded-lg",
            // **The card's own edge, and only a rule break changes it** — `CardMarks`' fourth
            // separation between a rule break and a game changer, kept as a ring on the face
            // now that the tile has no border. A ring rather than a border because a border
            // would shrink the picture by 2px on exactly the cards that break a rule; and on
            // the face rather than on the `<li>` so that it can never collide with
            // `SELECTED_CARD`, which is a ring on the element outside this one.
            ruleBreakText !== null && "ring-2 ring-destructive",
          )}
        >
          <CardArt
            // `null` for an orphan — nothing fetches a picture of a card that is not in the
            // database, and `CardArt` draws "No card" for it rather than "No image".
            cardId={card.needsReview === null ? card.cardId : null}
            // The name is the `alt` and what the no-picture fallback prints. It does **not**
            // reach the button's accessible name: that is the `aria-label` above, which
            // replaces this element's content outright and already carries the whole sentence.
            name={card.name}
            // The whole card, the same `grid` variant the stack draws.
            variant={DECK_CARD_VARIANT}
            finish={playedFinish(card.finish, card.finishes)}
            // In the same chip, whose glyph and word it replaces — so a Surge Foil in a deck
            // says so here exactly as it does on the search wall docked beside this view.
            treatments={finishTreatments(
              card.promoTypes,
              playedFinish(card.finish, card.finishes),
            )}
            // The crown, in the same chip as the finish and in the same corner the search wall
            // puts it — which is why this view no longer draws `GameChangerBadge`'s `GC`. The
            // two abbreviations of one fact are still right where there is no room for a glyph
            // over art (the table's rows, the text columns); a wall of card faces has the room,
            // and the docked search column beside this one has been drawing the crown all along.
            gameChanger={card.gameChanger === true}
            hoverZoom
            // A wall of a hundred tiles is a hundred mounted images — this view is a plain
            // scroller rather than a virtualised one, so the browser's gate is the only thing
            // bounding what they ask for. See the prop, which is `"eager"` everywhere else.
            loading="lazy"
          />

          {/* What a card *in a deck* says that a card in a wall does not, in the corners the
              wall leaves free: top-**left**, because top-right is `FoilOverlay`'s chip on every
              card surface in this app. It used to be a full-width scrim strip along the top with
              these pushed to the right end — under that chip, which the two have overlapped for
              as long as both were drawn. */}
          <span
            className={cn(
              "absolute flex items-center",
              "top-[calc(0.25rem*var(--mark-scale,1))] left-[calc(0.25rem*var(--mark-scale,1))]",
              "gap-[calc(0.25rem*var(--mark-scale,1))]",
            )}
          >
            {card.tagName !== null && <TagDot name={card.tagName} color={card.tagColor} />}
            {/* The copy count, at the size it is on a card at 100% zoom. `TagDot` beside it reads
                the same variable from inside its own component; this one is the view's own chip,
                so it says so here. */}
            <span
              className={cn(
                "shrink-0 rounded-sm bg-accent font-mono tabular-nums text-accent-fg",
                "px-[calc(0.25rem*var(--mark-scale,1))]",
                "text-[calc(0.5625rem*var(--mark-scale,1))]",
              )}
            >
              {card.quantity}
            </span>
          </span>

          {/* The plan's tick, in the corner this wall does **not** otherwise own.
              `src/CLAUDE.md`'s standing rule is that top-right belongs to `FoilOverlay`'s chip
              and a surface's own marks take the corners it leaves — and this is the one mark
              that cannot honour it, because the same fact is drawn in the same corner on the
              stack, where the chip is switched off, and a mark that changed corners between two
              drawings of one deck would be a mark nobody could find twice.

              So the chip keeps the corner and the tick **stacks under it**, on the one card in
              four that has a chip at all. `1.5rem` is that chip's own box measured rather than
              guessed: `FinishMark` and `GameChangerMark` are `0.75rem` glyphs in `py-[0.125rem]`
              — 16px — plus the 4px inset above it and 4px of gap, every term scaled by the same
              `--mark-scale` the chip is. The condition has to be spelled the way `FoilOverlay`
              spells it (`finish !== null || gameChanger`), because a chip is drawn for **either**
              fact and reading only the finish would put the tick under an empty corner on every
              non-foil game changer. */}
          {theoryDelta !== null && (
            <span
              className={cn(
                "absolute right-[calc(0.25rem*var(--mark-scale,1))]",
                playedFinish(card.finish, card.finishes) !== null || card.gameChanger === true
                  ? "top-[calc(1.5rem*var(--mark-scale,1))]"
                  : "top-[calc(0.25rem*var(--mark-scale,1))]",
              )}
            >
              {/* The tile's own quantity chip, not the stack's banner — see the component. */}
              <TheoryMatchMark variant="chip" delta={theoryDelta} />
            </span>
          )}

          {/* Bottom-left, opposite the tick above — `CardMarks.tsx` has why the two must never
              share a corner. This wall has drawn it here all along; it is the **stack** that
              moved its copy down to match, on 2026-08-20. */}
          {ruleBreakText !== null && (
            <RuleBreakMark
              text={ruleBreakText}
              className={cn(
                "absolute",
                "bottom-[calc(0.25rem*var(--mark-scale,1))]",
                "left-[calc(0.25rem*var(--mark-scale,1))]",
              )}
            />
          )}

          {/* Over the picture rather than over the whole tile, so the foot's gem and price stay
              at full strength while the card itself lights up. Nothing overlaps a tile on this
              wall, so unlike the stack there is no reveal strip the mark has to survive into —
              it is the same mark, drawn in the one place the reader is looking.

              The corner is the caller's — `rounded-[inherit]` emits no rule at all — so it is
              spelled as the radius this face is drawn with. */}
          {landedKey !== undefined && <LandedMark key={landedKey} className="rounded-lg" />}
        </span>
      </button>

      {/* **The card's foot, and a sibling of the button rather than a child of it.**

          It said a rarity and a price in 9px type on a 20px strip with no felt and no edges, and
          left out which printing the card *is* — the one fact a reader comparing two copies of
          one card needs. It is `components/CardChin` now, the same object `CardStack` draws, so a
          deck read in one view and then the other says the same things in the same order.

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
          still asks about this card. And the controls bar below is positioned against that same
          `<li>` at `bottom: footHeight`, so it goes on landing on the chin's top edge — the tile's
          height is the face plus the chin either way, and which element the chin is nested in
          moves neither box. */}
      <CardChin
        zoom={zoom}
        rarity={card.rarity}
        setCode={card.setCode}
        collectorNumber={card.collectorNumber}
        // The code is what fits; the set's name is one hover away, exactly as on the stacked card
        // — `PF26` is not a word anybody knows, and the hint being on one of two drawings of one
        // deck is the drift this task exists to remove. `null` for an orphan, whose `setName`
        // `cards` no longer has: then the code stands on its own rather than being annotated with
        // a guess.
        printingTitle={card.setName === null ? null : `${card.setName} · #${card.collectorNumber}`}
        finish={playedFinish(card.finish, card.finishes)}
        treatments={finishTreatments(card.promoTypes, playedFinish(card.finish, card.finishes))}
        money={formatPrice(card.unitPrice, currency)}
        // **`"art"`, not the stack's.** This tile's face is `CardArt`, whose own edge stops where
        // this bar begins rather than enclosing it — so the chin supplies all three of its own and
        // the two are one outline. Under the stack's bordered card it must not, or the foot is 2px
        // and everything else is 1px.
        seam="art"
        // **No `tone`, and that is the whole of this tile's rule-break answer being the ring.**
        //
        // `CardChin`'s `tone` exists so the chin's edge can match the *card's* edge, and the stack
        // is where that is load-bearing: its card really is bordered in destructive, so a chin
        // left at the neutral edge would put 28px of the wrong colour back through the left and
        // right edges of that outline — the one thing the outline exists to prevent, stated at the
        // prop and again at `CardStack`'s foot.
        //
        // Here the argument runs the other way. `CardArt` grew an edge of its own on 2026-08-26 so
        // the picture and this bar would read as one outlined object, and that edge is **neutral**
        // — a rule break on this surface is the `ring-2 ring-destructive` on the face above, which
        // is drawn outside the border box and leaves the border alone. Reddening only the chin
        // therefore ran the card's outline grey down the art and red across its foot, so the card
        // stopped reading as one object at exactly the join the border was added to close.
        //
        // The fix is this absence rather than a red edge on `CardArt`: the ring already says it,
        // an outline saying it as well is one fact drawn twice, and `CardArt`'s two callers
        // disagree about how a rule break is marked — so the colour is not that component's
        // decision to take.
      />

      {/* Over the art, as in the stack. Absolute, so the tile is exactly as wide and as tall as
          its card whatever it holds — which is what let the `Move…` select be removed on
          2026-08-14 without a number here changing: 150px was too narrow for a stepper and a
          select on one line, so the controls' own `flex-wrap` used to put the select on a
          second, and a bar that takes no height cost the tile nothing either way.

          The positioning is a wrapper's rather than the controls' own `className`, and that is
          the zoom's doing: the bar sits directly on top of the foot, so its offset is the foot's
          height — a computed number, and `DeckCardControls` takes a class string and no style. An
          offset utility was that number while the foot was always 20px. */}
      <span
        style={{ bottom: footHeight }}
        className="absolute inset-x-0 px-[calc(0.25rem*var(--mark-scale,1))]"
      >
        <DeckCardControls card={card} actions={actions} className={REVEALED_ON_CARD} />
      </span>
    </li>
  );
}
