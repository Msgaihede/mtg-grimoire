/**
 * The deck as a wall of cards: every card drawn, none of them covering another.
 *
 * The stack's opposite. A stack is for reading *down* a category; this is for seeing a whole
 * deck at once — which is what you want the moment before you cut something.
 */
import { useRef } from "react";
import { CardArt } from "@/components/CardArt";
import { RarityGem } from "@/components/RarityGem";
import { cardScaleVars, scaled } from "@/lib/cardZoom";
import { DROP_MARK_ROOM, DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import { playedFinish } from "@/lib/finish";
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
import { deckCardSlot } from "../dnd";
import { matchesTheory } from "../theoryMatch";
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
 * A base that **grows with the zoom and never shrinks below itself** — and, since the marks
 * themselves learnt to scale, the rule for exactly one thing on this wall: the gutter.
 *
 * It used to govern the foot and the type in it as well, on the argument that the card is a picture
 * and scales in both directions honestly while the things around it do not. That was true while
 * they did not: a 9px caption under a halved card would have become 4px, which is not type. It is
 * false now — the caption, the gem, the copy count and the stepper all follow `--mark-scale`
 * (`lib/cardZoom.ts`), so a floored budget is a 20px strip around 5px of type, which is the same
 * fault the other way up.
 *
 * The gutter keeps the floor because it is the one measurement here that is **between** cards
 * rather than **on** one: 10px is what stops a wall of cards reading as one sheet, and halving it
 * at 0.5× is precisely the zoom a reader chose in order to see more cards at once. Nothing is being
 * contained, so there is nothing for it to stay in step with.
 */
function atLeast(base: number, zoom: number): number {
  return Math.max(base, scaled(base, zoom));
}

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
  /** Which rows the deck's plan also asks for — `theoryMatch.ts`'s set of slots, handed down
   *  whole like `violations` beside it. `undefined` for a deck with no plan, and on the plan
   *  itself. */
  theoryMatches?: ReadonlySet<string>;
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
  theoryMatches?: ReadonlySet<string>;
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
              inTheory={matchesTheory(theoryMatches, card)}
              onSelect={onSelect}
              actions={actions}
              selected={deckCardSlot(card.categoryId, card.cardId, card.finish) === selectedSlot}
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
  inTheory,
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
  /** The deck's plan asks for this row too — resolved by the group, so a tile is handed a
   *  boolean rather than a set to look itself up in. */
  inTheory: boolean;
  onSelect?: (card: DeckCard) => void;
  actions?: DeckCardActions;
  /** This is the card the pane is open on. */
  selected: boolean;
  /** The nonce this tile's last add was given, or `undefined`. Passed through as the mark's
   *  `key`, so adding the same card twice replays the fade. */
  landedKey: number | undefined;
  /** How large the reader is drawing cards. The tile's width is the only thing it decides
   *  outright — the picture follows by aspect ratio, and the foot follows by
   *  {@link atLeast}. */
  zoom: number;
}) {
  const dragRef = useDeckCardDrag(card, actions?.drop !== undefined);
  // The foot and its type, which move with the tile in both directions now — see {@link atLeast},
  // which no longer governs either of them. Computed once here because three things read the
  // height: the strip itself, the type inside it, and the controls that sit directly above it.
  const captionHeight = scaled(CAPTION_HEIGHT, zoom);
  const captionText = scaled(CAPTION_TEXT, zoom);

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
      // The tile is the card's whole body, so a press on the control bar over its foot — a
      // positioned sibling of the button rather than part of it — does not read as a click on
      // the desk. See `cardControl`'s `CARD_BODY_ATTR`.
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
        aria-label={deckCardName(card, ruleBreakText, inTheory)}
        {...deckCardProps(card)}
        onClick={onSelect ? () => onSelect(card) : undefined}
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
          {inTheory && (
            <span
              className={cn(
                "absolute right-[calc(0.25rem*var(--mark-scale,1))]",
                playedFinish(card.finish, card.finishes) !== null || card.gameChanger === true
                  ? "top-[calc(1.5rem*var(--mark-scale,1))]"
                  : "top-[calc(0.25rem*var(--mark-scale,1))]",
              )}
            >
              {/* The tile's own quantity chip, not the stack's banner — see the component. */}
              <TheoryMatchMark variant="chip" />
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

        {/* The foot, and the one part of a tile that is not the card: a rarity gem and this
            printing's price. It is the search wall's caption line in every respect but what it
            says — flush with the card's own left edge rather than padded in from a slab that is
            no longer there. Both of its numbers are inline styles rather than `h-5` and a
            `text-[…]` literal, because both move with the zoom — a 300px card over a 20px strip
            of 9px type is a card that has outgrown its label, and the strip has to be tall
            enough to hold whatever type it is given or the gem clips. */}
        <span
          style={{ height: captionHeight, fontSize: captionText }}
          className="flex items-center gap-[calc(0.375rem*var(--mark-scale,1))] font-mono text-dim"
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
      <span
        style={{ bottom: captionHeight }}
        className="absolute inset-x-0 px-[calc(0.25rem*var(--mark-scale,1))]"
      >
        <DeckCardControls card={card} actions={actions} className={REVEALED_ON_CARD} />
      </span>
    </li>
  );
}
