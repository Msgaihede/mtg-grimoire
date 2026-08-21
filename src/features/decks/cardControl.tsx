/**
 * A deck card drawn as a **control**: how its focus is shown, what it is called, what can be
 * done to it, and how it is picked up and put down.
 *
 * Four surfaces make a card into a control — the stack, the table, the text columns and the
 * grid — and every one of them had grown its own copy of the focus recipe and the accessible
 * name. That is the duplication `CardMarks.tsx` was created to end, and the name is worse than
 * a duplicated class list: it is a *contract* that `views/views.test.tsx` asserts across all
 * of them, so four copies is four chances for one surface to quietly stop saying what a card
 * is.
 *
 * ## Why the editing controls live here too
 *
 * A deck card can be stepped, dragged and dropped on, and **all four views owe the reader all
 * three**. Written per view that is four steppers whose "zero removes the row" rule has to
 * agree, four drag payloads that have to carry the same three fields, and four drop targets
 * that have to refuse the same drops. Written once it is one rule with four call sites. The
 * views keep what genuinely differs — where a control is *placed* — because that is the whole
 * difference between a table and a wall of card faces.
 *
 * **Moving a card between piles is a drag and nothing else** (changed 2026-08-14). Every card
 * used to carry a `Move…` `<select>` beside its stepper; it was removed whole, and a different
 * control for it is expected later. What that costs today is stated on
 * {@link DeckCardControls}, because it is a real cost rather than a tidy-up.
 *
 * **Everything here is opt-in.** A view given no {@link DeckCardActions} draws exactly what it
 * drew before: a labelled button and nothing else. That is what lets a story or a test mount a
 * view without a deck behind it, and it is why adding these changed no existing view test.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { QuantityStepper } from "@/components/QuantityStepper";
import { FINISH_LABEL, playedFinish } from "@/lib/finish";
import type { ImageVariant } from "@/lib/images";
import type { DeckCard } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { THEORY_MATCH_LABEL } from "./CardMarks";
import {
  cardDraggable,
  deckCardSlot,
  DECK_CARD_ATTR,
  dropWrite,
  readDragData,
  type DeckWrite,
} from "./dnd";

/**
 * The image variant a deck card draws: **the whole card**, not the art crop.
 *
 * One constant because two surfaces draw one object — `CardStack` and `views/GridView` — and
 * because a third thing has to agree with them: `images::DECK_PREWARM` warms exactly this
 * variant, and warming the wrong one is invisible (the pre-warm reports every deck card as
 * warmed and the builder then fetches every tile cold). It is `display`, which is what
 * `WALL_CARD_VARIANT` and `COLLECTION_PREWARM` are, so a card that is both owned and in a deck
 * is one cache key rather than two.
 *
 * **It was `grid`, and the argument for that was measured at one zoom stop on one monitor.** It
 * ran: at the stack's 210px and the grid tile's 150px, 488px of width is already a 2× downscale,
 * so `display` would be 672 for no visible gain. Both figures are sizes at **100% zoom** — the
 * reader can take either to 2× on `cardZoom`'s ladder, and a CSS pixel is not a device pixel on
 * a scaled display. A 210px stack card at 2× on a monitor at 125% scaling is 525 device pixels
 * asking a 488px source, and at 200% scaling it is 840. That is the blur, and it is why a
 * variant chosen against a tile's *base* width is the wrong measurement to have taken.
 *
 * Still its own literal rather than an alias of `WALL_CARD_VARIANT`, for the reason the two
 * pre-warm constants stay two: they answer two questions, and a deck surface that wanted a
 * different picture again should be able to move without dragging every wall with it.
 *
 * The surfaces that draw a **cover** stay on `art` and are not this — a cover is 626×457 by
 * construction, because `images::encode_cover` re-encodes a user's own file to that exact shape so
 * the two kinds are interchangeable in one tile.
 */
export const DECK_CARD_VARIANT: ImageVariant = "display";

/**
 * **Picked**: this is the card the detail pane is open on.
 *
 * `ring-2 ring-accent`, which is `components/CardArt`'s `selected` recipe character for
 * character — the deck editor is answering the same question the search wall answers, and a
 * reader who has learned "gold ring means the pane is about this one" on one wall must not have
 * to learn a second vocabulary two clicks away. Gold means *state* as a ring and *focus* as an
 * outline everywhere in this app; this is the ring.
 *
 * It goes on the card's outermost element rather than on its face, so it stands **outside** the
 * card's own border and is never confused with the destructive edge a rule break draws.
 */
export const SELECTED_CARD = "ring-2 ring-accent";

/**
 * How a card says it is the picked one, for anything that has to find it **after the fact**.
 *
 * `CardStack`'s `STACK_OPEN_ATTR` one floor over, for its reason and with the same two readers:
 * a test, and `scripts/cdp.mjs --probe` in the shipped window. The mark itself is a class, and a
 * class is a *recipe* — a test that asserted `ring-accent` would go red the day the ring became
 * an outline, which is a change to how this looks and not to what it means. This is what it
 * means, and it is what `views/views.test.tsx` sweeps all four views for.
 *
 * On the same element as the visual mark in each view, which is the card's body in three of them
 * and the row in the table.
 */
export const SELECTED_ATTR = "data-deck-card-selected";

/** What a picked card spreads, and nothing at all when it is not picked — an attribute that is
 *  present-or-absent rather than `"true"`/`"false"`, so a query for it needs no value. */
export function deckCardSelectedProps(selected: boolean) {
  return selected ? { [SELECTED_ATTR]: "" } : {};
}

/**
 * The same question for the landed mark: which cards are inside their five seconds.
 *
 * It sits on {@link LandedMark} itself rather than on the card, because the mark is what an
 * expiry removes — so `[data-deck-landed]` answers "is it still saying so" rather than "was it
 * added at some point", which is the only version of the question worth asking.
 */
export const LANDED_ATTR = "data-deck-landed";

/**
 * The same fact on a **line** rather than on a card face — `TextView`'s 22px rows.
 *
 * A 2px ring around a 22px row is a box drawn around a word, so the weight comes down and the
 * surface comes up: the row lifts to `bg-surface` (which is what its own hover does, so the
 * picked row reads as permanently hovered) with a hairline of gold on it. `ring-inset`, because
 * the rows are flush against one another and an outset ring is drawn over its neighbours.
 *
 * `TableView` is deliberately **not** here: `VirtualTable` already owns what a picked row looks
 * like across all three tables in the app (`bg-surface text-text`, a quiet surface rather than
 * gold — forty rows are on screen and the one being read is already beside the pane), and this
 * editor is not the place to make one table disagree with the other two.
 */
export const SELECTED_ROW = "bg-surface ring-1 ring-inset ring-accent";

/**
 * **Landed**: how long a card the reader has just added goes on saying so.
 *
 * Five seconds, because the gesture that adds a card happens in the docked search panel and the
 * card lands somewhere in a deck the reader is not looking at — the mark has to survive the trip
 * their eye makes from one to the other, twice, with a moment to be sure at the end of it.
 *
 * **It was ten until 2026-08-15**, and it was halved by the same change that made the mark gold
 * and gave it a glow. The two are one decision: ten seconds was buying a *quiet* mark the time it
 * needed to be found, and a mark that is found at a glance does not need that time. Ten seconds of
 * a mark this loud is the app still pointing at a card long after the reader has moved on.
 *
 * **This number is also in `src/index.css`**, as `--animate-card-landed`'s duration, and the two
 * halves are genuinely two consumers rather than a copy: the stylesheet fades the mark and this
 * unmounts it. `cardControl.test.ts` reads the stylesheet and fails if they drift. It is not in
 * `src/lib/motion.ts` and must not be moved there — that module is a three-tier scale capped at
 * 260ms and `motion.test.ts` enforces the cap, correctly, because everything in it is a
 * *transition*. This is a mark that decays, which is a different kind of thing.
 */
export const LANDED_MS = 5_000;

/**
 * The mark itself: a gold wash, a gold hairline and a glow inside the card's edge, fading to
 * nothing over {@link LANDED_MS}.
 *
 * ## Why it is gold, and how it stays apart from the other three golds
 *
 * It was `--color-text` — parchment — until 2026-08-15, on the argument that gold was already
 * taken three times over on this one surface: focus, {@link SELECTED_CARD}, and both halves of
 * the drop affordance (`lib/dropMarks`' `DROP_RING`/`DROP_OVER`). The argument was sound about the
 * colour and wrong about the outcome. Parchment is the app's *text* colour, which means it is
 * the colour of nearly everything on screen already, so the mark read as a card that had gone
 * slightly pale — and a mark whose whole job is to be found across a deck the reader is not
 * looking at cannot be the quietest thing they are looking at. Driven in the real window, it was
 * missed.
 *
 * What keeps it apart from the other three is **shape and place**, which is the axis they were
 * always distinguished on and is stronger than hue: every one of them is a *line around the
 * outside* of a box — a ring on the card, a ring on the pile — and this is a **filled face**,
 * washed and lit from its own rim inward. A picked card wears a gold ring around an unwashed
 * card; a card that has just landed is gold all the way through and wears no ring; a pile being
 * dropped into is ringed while the cards inside it are untouched. The two can be true at once and
 * still read as two facts. Red stays the rule break's, and green would be a five-colour token
 * spent on something that is not mana, which the visual direction forbids in as many words.
 *
 * ## The glow is `inset`, and that is a clipping fact rather than a preference
 *
 * The mark is drawn inside the card's **face**, which is `overflow-hidden` in `CardStack` (it is
 * what clips the picture's corners). Anything painted outside the mark's border box — a plain
 * `box-shadow`, a `drop-shadow()` filter — is therefore clipped away in the stack view and drawn
 * in the other three, which is a mark that looks like two different marks depending on which
 * view the reader left the deck in. An inset shadow is painted *by* this element inside its own
 * box, so it survives every clip, and it lands the light exactly where this mark needs it: along
 * the top edge, which is the 34px of itself a card in the middle of a pile still shows.
 *
 * ## Why it is a border and not a ring
 *
 * The mark has to be legible **from the middle of a stack**, where a card shows only the 34px of
 * its own printed title bar that its successor has not painted over. An outset ring is drawn on
 * the card's outside edge, where the next card covers three of its four sides; a border on an
 * `inset-0` overlay is drawn *inside* the face, so what survives into that strip is a bright
 * hairline across the card's top and 34px down each side, with the wash lighting the strip
 * between them. That is the difference between "somewhere in this pile" and "this one".
 *
 * `aria-hidden`, and it is decoration in the strict sense: an add is a write the reader just
 * made, the deck's own list is what confirms it, and nothing here says anything a screen reader
 * has not already been told by the button that made it.
 *
 * **Re-mount it to replay it.** A CSS animation runs once per element, so a second add of a card
 * that is still glowing has to be a different element — the caller passes the nonce it was given
 * as `key`. See `DeckEditor`'s `useRecentAdds`.
 *
 * **The corner is the caller's**, and it is square here rather than inherited: `rounded-[inherit]`
 * emits **no rule at all** — Tailwind validates an arbitrary `rounded-*` as a length and drops a
 * bare keyword — so the mark would have had square corners crossing a rounded card with nothing
 * going red. Every surface knows the radius of the box it lays this over, so it passes it.
 */
export function LandedMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      {...{ [LANDED_ATTR]: "" }}
      className={cn(
        // Over the whole card and hittable by nothing: the card under it is a button, and a
        // mark that swallowed a press for five seconds would be worse than no mark at all.
        "pointer-events-none absolute inset-0",
        // **Top-weighted, and that is the reveal strip's doing rather than taste.** A flat wash
        // strong enough to find in a 34px strip is a wash that floods the open card, and one
        // gentle enough for the open card is invisible in the strip — measured both ways in
        // Storybook over CDP (2026-08-14). The gradient answers both: 40 % where the strip is,
        // 12 % by the card's foot. It is the same trade `CARD_MARKS_STRIP`'s own scrim makes one
        // element away, which is the precedent for spending a gradient here at all. The two
        // percentages are a little over the parchment version's 35/10 because gold sits at 0.75
        // lightness against parchment's 0.93 — the same alpha is less light on the card.
        "border-2 border-accent bg-gradient-to-b from-accent/40 to-accent/12",
        // The glow, and every part of this is load-bearing. `inset` for the clipping reason in
        // the doc above. No offset, because the light is the card's own edge rather than
        // something above it. A blur far wider than the spread, so the band falls off into the
        // art instead of drawing a second border inside the first. `color-mix` rather than the
        // bare token, because a full-strength gold at this radius is a lamp — and rather than a
        // `/60` opacity modifier, which Tailwind offers on colour utilities and not inside an
        // arbitrary shadow value.
        "shadow-[inset_0_0_26px_4px_color-mix(in_oklab,var(--color-accent)_60%,transparent)]",
        // `animate-none` under reduced motion leaves the mark at full strength for its five
        // seconds and then takes it away with the element — the information survives, only the
        // fade goes. Nothing here moves, so there is nothing else to reduce.
        "animate-card-landed motion-reduce:animate-none",
        className,
      )}
    />
  );
}

/**
 * How a card says "the click that landed in here was on **me**", for a listener that is nowhere
 * near it.
 *
 * The editor clears the selection on a click that missed every card ({@link keepsSelection}),
 * and it listens at the top of the view because the alternative is a handler on every gap
 * between every pile. A card is mostly a `<button>` and a button is easy to recognise — but not
 * all of it is: the stack card's data line stands *outside* its button (it is announced text
 * rather than a mark, which is the whole reason it is out there), and the grid tile's control
 * bar is a positioned span with padding around its stepper. Clicking either of those is clicking
 * the card, and a rule built out of `button` alone would deselect it.
 *
 * So the card's outermost element says so. It is a second attribute rather than {@link
 * DECK_CARD_ATTR} moved outward, because that one is the *caret's* way home and has to stay on
 * the focusable element; these are two questions with two answers that happen to be about one
 * card.
 */
export const CARD_BODY_ATTR = "data-deck-card-body";

/** What a card's outermost element spreads to be one. See {@link CARD_BODY_ATTR}. */
export function deckCardBodyProps() {
  return { [CARD_BODY_ATTR]: "" };
}

/**
 * Everything a click can land on inside the deck editor without meaning "I am done with that
 * card".
 *
 * A card ({@link CARD_BODY_ATTR}), a table row (which is the table's card), and anything the
 * reader is *operating* — a control, a field, an option, a modal. What is left over is the
 * desk: the gap between two piles, a group's padding, the blank under a short column. That is
 * what a reader clicks when they mean nothing at all, and it is the one gesture this app has
 * for putting a card down.
 */
const KEEPS_SELECTION = [
  `[${CARD_BODY_ATTR}]`,
  '[role="row"]',
  '[role="option"]',
  '[role="listbox"]',
  '[role="dialog"]',
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "label",
].join(", ");

/**
 * Whether a click that reached the editor's root landed on something that keeps the selection.
 *
 * `closest` rather than a comparison, because the target is whatever leaf the pointer was over
 * — the glyph inside a button, the truncated span inside a row — and the question is always
 * about the thing that leaf belongs to.
 */
export function keepsSelection(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(KEEPS_SELECTION) !== null;
}

/**
 * What a deck card's control is called.
 *
 * It begins with the card's **name**, which is the visible label — WCAG 2.5.3 asks that of any
 * control whose label is drawn on it — and then says, in the order a reader would want them,
 * everything the surface shows as a mark rather than as a word.
 *
 * **This is the whole of what a keyboard reader gets, and that is why it is one function.** An
 * `aria-label` *replaces* an element's content for naming purposes, so every `sr-only` span
 * inside one of these buttons is announced to nobody: the tag chip, the `GC` badge, the
 * `RULE BREAK` mark, the theory tick and the red shortage figure are all decoration once the
 * button is named, and each of them is a fact somebody needs. They are said here instead, once,
 * so no surface can be the one that forgets.
 *
 * The shortage is included even on the two surfaces that have no room to draw it. A name is
 * what a reader gets *instead of* the visual scan, not a transcript of it — one name carrying
 * every fact beats three that each omit a different one.
 */
export function deckCardName(
  card: DeckCard,
  ruleBreakText: string | null,
  /** Whether the deck's plan also asks for this row — `theoryMatch.ts`'s answer, and `false` for
   *  every card of a deck that keeps no plan. The mark itself is `TheoryMatchMark`, which is a
   *  tick and therefore says nothing at all to a reader who cannot see it. */
  inTheory = false,
): string {
  // The allocator claims no copy for an inactive category, so every card in one reads 0 owned
  // by construction — announcing a shortage there would report one the reader does not have.
  const short = card.categoryActive && card.ownedQuantity < card.quantity;
  // Which object this row plays. Three of the four views draw it as `FoilOverlay`'s chip and
  // the text columns as a glyph, and on every one of them it is decoration once the button is
  // named — so this is where it is said. `null` for the regular copy, which is the finish a
  // card is assumed to be and the one that needs no word.
  const finish = playedFinish(card.finish, card.finishes);
  return [
    card.name,
    card.quantity > 1 ? `${card.quantity} copies` : null,
    short ? `you own ${card.ownedQuantity} of ${card.quantity}` : null,
    finish === null ? null : FINISH_LABEL[finish].toLowerCase(),
    card.tagName,
    card.gameChanger === true ? "game changer" : null,
    // Before the rule break, because it is the milder fact and this list runs from what the card
    // *is* to what is wrong with it — and lowercased like every other clause here, since the
    // constant is written as a tooltip (a fragment on its own) and this is a sentence.
    inTheory ? THEORY_MATCH_LABEL.toLowerCase() : null,
    ruleBreakText === null ? null : `rule break: ${ruleBreakText}`,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
}

/**
 * What a card's own control spreads so the card pane can find it again.
 *
 * The pane is not in the deck's tree and owns none of its elements — and least of all this one,
 * whose whole story is that a printing swap replaces it: the card it was drawn from is deleted
 * and the new printing's card is a different React key, so a ref taken when the pane opened
 * points at something unmounted by the time Escape is pressed. A slot is a question the DOM can
 * answer after the fact, and `dnd.ts` owns both ends of the spelling.
 *
 * It goes on the **focusable** element — the card's own button, or the table row — because what
 * the pane does with it is hand the caret back.
 *
 * Stamped whether or not the card has any actions: opening a card from a deck is what puts the
 * swap on offer, and that is true of a view drawn read-only.
 */
export function deckCardProps(card: DeckCard) {
  return { [DECK_CARD_ATTR]: deckCardSlot(card.categoryId, card.cardId, card.finish) };
}

/**
 * What a view can do to a card, handed down from the editor — or `undefined`, which is a view
 * with nothing but an `onSelect`.
 *
 * Every field is optional on its own, so a surface can be given the stepper without the drop,
 * and none of the four views has to know which it got.
 */
export interface DeckCardActions {
  /**
   * An **absolute** quantity, and `0` removes the row.
   *
   * Absolute rather than a `+1`/`−1` delta, and the reason is in `useDeck.ts` and is
   * load-bearing: `deck_add_card` looks the printing up in `cards` and therefore **refuses an
   * orphaned row**, while `deck_set_card_quantity` addresses the slot that is already there
   * and asks `cards` nothing. The one card in a deck whose printing has left the database is
   * exactly the one a reader most needs to be able to step down and out, so a stepper built on
   * deltas through the add path is broken on precisely the rows that most need fixing.
   */
  setQuantity?: (card: DeckCard, quantity: number) => void;
  /**
   * What a drop on a group writes. `dnd.ts` decided *what* a drop means and refused the ones
   * that mean nothing; this is handed the answer.
   *
   * Its presence is also what makes cards **draggable**: a deck that can be dropped into is a
   * deck that can be picked up out of, and the two halves of a move-by-drag are never useful
   * apart.
   */
  drop?: (write: DeckWrite) => void;
  /**
   * What this card offers on a right-click — **the handlers already built**, never a list of
   * rows.
   *
   * It travels in this bag rather than as a fifth prop on each view for the reason the bag
   * exists at all: it goes three components deep — the view, the group, the card — and a bag
   * passed on whole cannot be passed on incompletely. And it is the *handlers* rather than the
   * items because only `DeckEditor` knows what a deck card's menu offers: the deck's
   * categories, its format spec and its tags are three facts no view has, and four views
   * assembling them would be four copies of one rule.
   *
   * Absent is a view with no menu — a story, a read-only mount — and the reader gets the app's
   * plain suppression. Read on render rather than registered, so nothing is torn down when it
   * changes.
   */
  menu?: (card: DeckCard) => DeckCardMenuHandlers;
  /**
   * What a **pile** offers on a right-click, by category id — the heading's menu, where a card's
   * is `menu` above.
   *
   * It is in this bag beside `drop`, which is also a pile's affordance rather than a card's, and
   * for the same reason `drop` is: it travels view → group and a bag passed on whole cannot be
   * passed on incompletely.
   *
   * **A derived group has none**, and the view says so by passing `null` — nothing can be
   * renamed, switched off or deleted about "Mana value 3", and `categoryId` is `null` for
   * exactly those groups.
   */
  categoryMenu?: (categoryId: number) => DeckCardMenuHandlers | undefined;
  /**
   * The inline rename field for the pile the reader is renaming, or `null` for every other pile.
   *
   * **A node rather than a callback**, because the field is one element with one piece of state
   * and four views must not each build their own — the editor owns which pile is being renamed
   * and what a save writes, and hands the whole control down. It is the same shape
   * `GroupHeader`'s own `actions` prop takes and for the same reason.
   */
  renameCategory?: (categoryId: number | null) => ReactNode;
  /**
   * Put the pile `categoryId` where the pile `targetId` is — the reader dragging a column of
   * their deck past another one.
   *
   * **Two ids and never an index**, which is the whole reason this member exists rather than a
   * view calling `reorderCategories` for itself. `deck_category_reorder` writes `sort_order`
   * from position over **every** category of the deck, and the piles a view is drawing are a
   * subset of that list: `splitRail` takes the Sideboard and the Maybeboard out, and
   * `drawsWhenEmpty` never builds the empty auto ones. So a position in the flow is not a
   * position in the list the command is sent, and only the editor holds both.
   *
   * **Absent is the off switch, and the editor uses it.** It hands this down only while the deck
   * is grouped by category: under Mana value or Type the headings on the desk are buckets rather
   * than piles, so there is no order of the reader's to change. A view draws no grip without it.
   */
  moveCategory?: (categoryId: number, targetId: number) => void;
}

/** The rename field for this pile, or nothing — `null` is a derived heading, which is not a
 *  category and cannot be renamed. Spelled once so four views do not each guard it. */
export function deckGroupRename(
  categoryId: number | null,
  actions?: DeckCardActions,
): ReactNode {
  return categoryId === null ? null : actions?.renameCategory?.(categoryId);
}

/**
 * The two handlers a card element spreads to offer a menu, and both are owed.
 *
 * `onContextMenu` is the pointer's way in. `onKeyDown` is Shift+F10 and the ContextMenu key,
 * and it is **not** an optional extra here: the per-card `Move…` select was removed on
 * 2026-08-14 and there has been no keyboard path to moving a card since ({@link
 * DeckCardControls} records the cost). This menu is that path, so a menu only a mouse could
 * open would restore nothing.
 *
 * They go on the element carrying {@link deckCardProps} or on its box — a keydown from the
 * card's own button bubbles either way, and `menuKey` anchors the panel at the element it is
 * attached to.
 */
export interface DeckCardMenuHandlers {
  onContextMenu: (e: ReactMouseEvent) => void;
  onKeyDown: (e: ReactKeyboardEvent) => void;
}

/**
 * A card's menu handlers **and the tab index that makes the caret's way back land** — spread
 * onto whichever element a view calls the card. `{}` rather than `undefined`, so a view can
 * spread it unconditionally and a view with no menu grows no attribute.
 *
 * ## `tabIndex: -1` is not tidiness, it is the other half of the menu
 *
 * `useContextMenu`'s `menu`/`menuKey` take the **element the handler is attached to** as the
 * panel's `opener`, and `ContextMenu` hands the caret back to it twice: once when a row is
 * chosen and once when Escape closes the menu. **`focus()` on an element with no `tabindex` is
 * a no-op**, so without this the caret would land nowhere at all and the next Tab would restart
 * from the top of the document — the failure `DecksPage.tsx` already writes down at its own
 * `menu()` call site, arriving here by a different route.
 *
 * It bites hardest on the affordance this menu exists to restore. The per-card `Move…` select
 * was removed on 2026-08-14 and took the only keyboard path to moving a card with it; Shift+F10
 * → `Move to` is the replacement, and a route that ends with the reader's place lost is not one.
 *
 * **`-1`, so nothing becomes a tab stop.** A deck of a hundred cards must not grow a hundred
 * presses on the way to anything, and every one of these elements already contains the card's
 * own button, which is the real stop. It is the same arrangement `deckGroupProps` gives a pile:
 * a place focus can be *put*, never one Tab travels through.
 *
 * The table needs none of this and is not a caller: `VirtualTable` gives its rows `tabIndex: 0`
 * already, because there the row *is* the control.
 */
export function deckCardMenuProps(
  card: DeckCard,
  actions?: DeckCardActions,
): Partial<DeckCardMenuHandlers> & { tabIndex?: -1 } {
  const handlers = actions?.menu?.(card);
  return handlers === undefined ? {} : { ...handlers, tabIndex: -1 };
}

/**
 * A **pile's** menu handlers, for the element a view calls the group — or nothing, for a derived
 * heading and for a view that was given no menu.
 *
 * **The handlers go on the view's own group element and never on `GroupHeader`, and that is a
 * layer decision rather than a preference.** `CategoriesDialog` draws that same component in
 * every one of its rows, *inside* a `Dialog` — which is `LAYER.overlay`, 45, over a scrim.
 * `ContextMenu` draws at `LAYER.popup`, 30. (Named rather than spelled as classes: Tailwind's
 * scanner reads a comment as eagerly as code, so a bare utility written here is a rule the build
 * emits — which is why `layers.test.ts` sweeps prose too, and why it went red for this comment.)
 * So a right-click wired onto the shared
 * header would open a menu **behind the dialog's own scrim**: invisible, unreachable, and
 * nothing would go red, because a z-index is not something jsdom has an opinion about.
 * `layers.ts` names that exact overlap as the one that must not exist ("a right-clickable
 * surface placed inside a scrimmed dialog would be the real overlap … and there is none
 * today"), and this is what keeps that sentence true. **Do not tidy these onto `GroupHeader`.**
 *
 * No `tabIndex` here, unlike {@link deckCardMenuProps}: every group element already carries one
 * from {@link deckGroupProps}, because the editor hands the caret to a pile when a card leaves
 * it. The seam was prepared for a caret before it had a menu.
 */
export function deckGroupMenuProps(
  categoryId: number | null,
  actions?: DeckCardActions,
): Partial<DeckCardMenuHandlers> {
  if (categoryId === null) return {};
  return actions?.categoryMenu?.(categoryId) ?? {};
}

/**
 * How a group says which category it is, for anything that has to find one **after the fact**.
 *
 * The editor hands the caret to a group when a card leaves one under it — a stepper reaching
 * zero, or a move landing somewhere else — and the group it wants is usually not the one the
 * press was made in, so a ref chain would have to run from the editor through a view into a
 * `map`. An attribute is a question the DOM can answer from anywhere, which is `DECK_CARD_ATTR`'s
 * own argument one floor down. The value is the `deck_categories.id`, as a string.
 *
 * Only a **category** group carries one: a derived heading ("Mana value 3") is not a place, so
 * nothing can be dropped into it and nothing can be handed to it.
 */
export const DECK_GROUP_ATTR = "data-deck-group";

/** What a group element spreads to be one: the attribute above, and a tab stop the editor can
 *  put the caret on without it joining the Tab order. */
export function deckGroupProps(categoryId: number | null) {
  return categoryId === null ? {} : { [DECK_GROUP_ATTR]: String(categoryId), tabIndex: -1 };
}

/** Hand the caret to a category's group, if one is drawn. The editor's hand-off, spelled once
 *  so the lookup and the attribute above cannot drift. */
export function focusDeckGroup(categoryId: number): boolean {
  const group = document.querySelector<HTMLElement>(`[${DECK_GROUP_ATTR}="${categoryId}"]`);
  group?.focus();
  return group !== null;
}

/**
 * A deck card as a drag source — the registration, and nothing about where it may land.
 *
 * A ref callback rather than an effect, because the element is the view's and this module owns
 * none of it. React 19 calls the function it returns as the cleanup, which is exactly the shape
 * `cardDraggable` already answers in.
 *
 * **The card is read through a ref, kept up to date in an effect.** `cardDraggable` takes
 * `payload` as a *function* precisely so a card renumbered since it mounted still carries what
 * it is now — and the alternative, putting `card` in the dependency list, would tear the
 * registration down and build it again every time the deck's query answered. A query that
 * settled mid-drag would then take the drag with it.
 *
 * The effect rather than a write during render, which is what React's own lint asks for and is
 * safe here for a reason worth stating: the payload is read at `dragstart`, and a drag cannot
 * begin before the paint the effect runs after.
 */
export function useDeckCardDrag(card: DeckCard, enabled: boolean) {
  const latest = useRef(card);
  useEffect(() => {
    latest.current = card;
  }, [card]);

  return useCallback(
    (element: HTMLElement | null) => {
      if (!element || !enabled) return;
      return cardDraggable({
        element,
        payload: () => ({
          kind: "deck-card",
          cardId: latest.current.cardId,
          name: latest.current.name,
          fromCategoryId: latest.current.categoryId,
          finish: latest.current.finish,
        }),
      });
    },
    [enabled],
  );
}

/**
 * A group as a drop target: **the category you let go over is the one that takes the card.**
 *
 * That is what the old zone columns did and it is the whole point of a per-group target — a
 * single target over the whole view would land every drop in whatever the deck's default
 * category happened to be, which is a silent difference between the drag and the button beside
 * it.
 *
 * `categoryId: null` registers nothing, and that is `grouping.ts`'s rule rather than a special
 * case here: a derived group is a heading and no more, so there is nothing for a card to be
 * dropped *into*. The same is true of the `over` flag, so a derived heading never lights up.
 *
 * `onDrop` is a dependency of the registration, so hand it a stable function or every render
 * re-registers — the editor's `applyDrop` is a `useCallback` over three `mutate`s for exactly
 * this reason.
 *
 * ## Two flags, because a drop target has two things to say
 *
 * `eligible` is "a card is in the air and this pile could take it" and `over` is "and it is
 * this one" — the sidebar's pair (`lib/dropMarks`' `DROP_RING` / `DROP_OVER`) said on the four
 * surfaces a reader actually drags between. Without the first, a card picked up in a fifteen-
 * category deck lights nothing at all until the pointer happens to cross a target, so the
 * reader has to hunt for the gesture's own affordance.
 *
 * **A monitor per group rather than one per view**, which is the trade worth naming: a deck has
 * a dozen categories, so a dozen registrations — but pdnd only asks them at `dragstart` and at
 * `drop`, never per pointer move. The alternative is one monitor at the top of each view and
 * the flag drilled down through four different group components, which is four places for the
 * four views to disagree again. `canMonitor` is `canDrop`'s own question, so "eligible" means
 * this pile really would take *this* card and not merely that something is being dragged.
 */
export function useCategoryDrop(categoryId: number | null, onDrop?: (write: DeckWrite) => void) {
  const [over, setOver] = useState(false);
  const [eligible, setEligible] = useState(false);
  const enabled = categoryId !== null && onDrop !== undefined;

  useEffect(() => {
    if (categoryId === null || !onDrop) return;
    return monitorForElements({
      canMonitor: ({ source }) => {
        const payload = readDragData(source.data);
        return payload !== null && dropWrite(payload, { kind: "category", categoryId }) !== null;
      },
      onDragStart: () => setEligible(true),
      // Fires for a cancelled drag as well as a completed one — the platform ends both the same
      // way — so the ring stands down on Escape without this hearing a keypress.
      onDrop: () => {
        setEligible(false);
        setOver(false);
      },
    });
  }, [categoryId, onDrop]);

  // Named `attach` rather than `ref`, which is not fussiness: React's ref lint reads a hook
  // result called `ref` as a ref object and flags every read of the value beside it as a ref
  // access during render. It is a callback the caller hands to `ref=`, not a ref.
  const attach = useCallback(
    (element: HTMLElement | null) => {
      if (!element || categoryId === null || !onDrop) return;
      // The rule, asked twice: once in `canDrop`, so a drop that would mean nothing never
      // lights up and never accepts the card, and again on the drop itself, because the two
      // questions can be a second apart and only the second one writes.
      const writeFor = (data: Record<string, unknown>) => {
        const payload = readDragData(data);
        return payload && dropWrite(payload, { kind: "category", categoryId });
      };
      return dropTargetForElements({
        element,
        canDrop: ({ source }) => writeFor(source.data) !== null,
        onDragEnter: () => setOver(true),
        onDragLeave: () => setOver(false),
        onDrop: ({ source }) => {
          setOver(false);
          const write = writeFor(source.data);
          if (write) onDrop(write);
        },
      });
    },
    [categoryId, onDrop],
  );

  return { attach, over: over && enabled, eligible: eligible && enabled };
}

/**
 * The controls a card carries: **how many copies, and that is now all of it.**
 *
 * It used to carry a second control beside the stepper — a native `Move…` `<select>` listing
 * every other category of the deck — and that was removed whole on 2026-08-14. Two things it was
 * load-bearing for were written down here so that whatever replaced it would be measured against
 * them rather than against a blank page. **Its replacement is the card's right-click `Move to`
 * (`deckCardMenu.tsx`), landed later the same day, and it closes both:**
 *
 * - **It was the only keyboard path to moving a card.** A drag is not one, so this mattered:
 *   stepping a card to zero and adding it again elsewhere is a different write and loses the
 *   slot. **Shift+F10 → `Move to`** is a keyboard path again, which is why
 *   {@link deckCardMenuProps} carries a `tabIndex` and why `menuKey` is not an optional extra on
 *   these surfaces.
 * - **It was the only way to reach an empty category**, and that hole closed from both ends. A
 *   pile the reader made draws empty now (`drawsWhenEmpty`) and is therefore its own drop target,
 *   which covers the classes a reader files into deliberately; **the pile with no drag route is
 *   an `origin = 'auto'` one that has gone empty**, since nobody asked for it and it goes with
 *   its last card. `Move to` is built from the deck's `categories` rather than from the drawn
 *   groups — the same choice the old select made — so it lists that pile too. What is left of
 *   the hole is a *drag* that cannot reach one heading, not a reader who cannot get there.
 *
 * `null` when there is nothing to offer, so a view can render this unconditionally and a view
 * with no actions grows no empty box.
 */
export function DeckCardControls({
  card,
  actions,
  layout = "row",
  className,
}: {
  card: DeckCard;
  actions?: DeckCardActions;
  /**
   * How the controls are arranged, which is a question about the **space** they are given
   * rather than about how they should look.
   *
   * `row` is a wide, short one — a table cell, a text line, the foot of a 150px grid tile —
   * and wraps when it runs out. `card-column` is the deck stack's: a column standing in the
   * right margin of a 210px card face, over the illustration, where the one dimension going
   * spare is the vertical one. It is also the only layout drawn on art, so it is the only one
   * whose buttons carry a backing.
   */
  layout?: "row" | "card-column";
  className?: string;
}) {
  const setQuantity = actions?.setQuantity;
  if (!setQuantity) return null;
  const column = layout === "card-column";

  const stepper = (
    <QuantityStepper
      size={column ? "card" : "xs"}
      orientation={column ? "vertical" : "horizontal"}
      tone={column ? "art" : "panel"}
      // Inside a card frame and inside a grid tile, both of which clip their own corners.
      focus="inset"
      value={card.quantity}
      // The floor is zero and zero is a real press: it is how a deck card leaves, and the
      // only way a reader can take one out with the keyboard.
      min={0}
      label={`Copies of ${card.name} in ${card.categoryName}`}
      onChange={(quantity) => setQuantity(card, quantity)}
    />
  );

  return (
    // `data-no-drag` on the wrapper rather than on each control: `cardDraggable` asks
    // `closest()`, so one mark covers the buttons, and `input` is excluded by tag anyway.
    // Without it a press on `−` plus five pixels of travel is a drag of the whole card.
    //
    // **A wrapper around one control, and it stays a wrapper.** It is what carries
    // `data-no-drag` and the caller's placement class, and it is where the second control goes
    // back when a move affordance returns — `items-end` in the column layout is the card
    // margin's right edge, which is a fact about the margin rather than about how many
    // controls happen to be standing in it.
    <span
      data-no-drag=""
      className={cn(
        "flex gap-1",
        column ? "flex-col items-end" : "flex-wrap items-center justify-center",
        className,
      )}
    >
      {stepper}
    </span>
  );
}

/**
 * How the controls are revealed on the three views that draw a card as a *picture*.
 *
 * They sit over the card rather than in it, which is the whole reason `CardStack`'s geometry
 * survived them: an absolutely positioned bar takes no height, so a card is still 319px, a
 * stack is still `34n + 293`, and the no-reflow property stays a fact about arithmetic rather
 * than a thing to be careful about.
 *
 * **`opacity`, never `hidden`.** `display: none` takes an element out of the tab order, so a
 * bar revealed by `group-focus-within` could never be focused into and would be unreachable by
 * keyboard forever — the reveal would be waiting for a focus that its own reveal was hiding.
 * At `opacity-0` the controls are still focusable, and the card lifts on `focus-within` at the
 * same moment, so the caret arrives on something the reader can see.
 */
export const REVEALED_ON_CARD = cn(
  "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
  "transition-opacity duration-150 motion-reduce:transition-none",
);

/**
 * The same reveal for the deck stack, driven by **which card is open** rather than by the
 * pointer being anywhere on this one.
 *
 * `group-hover:` is the wrong question in a stack and was quietly answering it wrong. A
 * collapsed card is overlapped by its successor by all but its 34px reveal strip, so hovering
 * that strip revealed a control bar drawn hundreds of pixels below it — behind three other
 * cards, at full opacity, painted over by every one of them. The controls belong to the card
 * the reader has settled on, which is exactly what `CardStack`'s flip-through already knows.
 *
 * **`opacity`, never `hidden`**, for {@link REVEALED_ON_CARD}'s reason and it is sharper here:
 * the caret opens a card the moment it lands on it, so a stepper that did not exist until the
 * card opened would be a tab stop that appears in the middle of the Tab that was looking for
 * it. At `opacity-0` it is a stable stop, and focusing it opens the card under it.
 */
export function revealedWhenOpen(open: boolean): string {
  return cn(
    // `ease-enter` rather than the default `standard`, which is the canvas's own curve and the
    // right one by `lib/motion.ts`'s rule: these controls are *arriving*, not travelling
    // between two positions they occupy either way. `REVEALED_ON_CARD` keeps the default
    // because its reveal is a pointer sweeping on and off rather than a card committing.
    "transition-opacity duration-150 ease-enter motion-reduce:transition-none",
    open ? "opacity-100" : "opacity-0",
  );
}
