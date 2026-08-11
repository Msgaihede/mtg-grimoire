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
 * A deck card can be stepped, moved, dragged and dropped on, and **all four views owe the
 * reader all four**. Written per view that is four steppers whose "zero removes the row" rule
 * has to agree, four drag payloads that have to carry the same three fields, and four drop
 * targets that have to refuse the same drops. Written once it is one rule with four call
 * sites. The views keep what genuinely differs — where a control is *placed* — because that is
 * the whole difference between a table and a wall of card faces.
 *
 * **Everything here is opt-in.** A view given no {@link DeckCardActions} draws exactly what it
 * drew before: a labelled button and nothing else. That is what lets a story or a test mount a
 * view without a deck behind it, and it is why adding these changed no existing view test.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { QuantityStepper } from "@/components/QuantityStepper";
import type { DeckCard, DeckCategory } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import {
  cardDraggable,
  deckCardSlot,
  DECK_CARD_ATTR,
  dropWrite,
  readDragData,
  type DeckWrite,
} from "./dnd";

/**
 * Keyboard focus, in the shape the rest of the app uses: a gold outline standing off the
 * control's edge, never a ring — a ring means "state" everywhere else here.
 *
 * For a control with room around it. A control that **fills** a clipped box wants
 * {@link FOCUS_INSET} instead.
 */
export const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * The same outline, drawn **inside** the control's own edge.
 *
 * The offset is negative for exactly `VirtualTable`'s reason, one floor down: an outline
 * standing 2px *off* a control that fills an `overflow-hidden` box is painted entirely in the
 * clipped region and is never seen at all. A card in the stack and a tile in the grid are both
 * that shape — the button is the whole card, and the card clips its own corners — so a
 * positive offset there is not a smaller ring, it is **no focus indicator**, which is a WCAG
 * 2.4.7 failure and invisible to anyone testing with a mouse.
 *
 * `deck cards keep their focus outline inside the box that clips them` sweeps for it.
 */
export const FOCUS_INSET =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

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
 * `RULE BREAK` mark and the red shortage figure are all decoration once the button is named,
 * and each of them is a fact somebody needs. They are said here instead, once, so no surface
 * can be the one that forgets.
 *
 * The shortage is included even on the two surfaces that have no room to draw it. A name is
 * what a reader gets *instead of* the visual scan, not a transcript of it — one name carrying
 * every fact beats three that each omit a different one.
 */
export function deckCardName(card: DeckCard, ruleBreakText: string | null): string {
  // The allocator claims no copy for an inactive category, so every card in one reads 0 owned
  // by construction — announcing a shortage there would report one the reader does not have.
  const short = card.categoryActive && card.ownedQuantity < card.quantity;
  return [
    card.name,
    card.quantity > 1 ? `${card.quantity} copies` : null,
    short ? `you own ${card.ownedQuantity} of ${card.quantity}` : null,
    card.tagName,
    card.gameChanger === true ? "game changer" : null,
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
  return { [DECK_CARD_ATTR]: deckCardSlot(card.categoryId, card.cardId) };
}

/**
 * What a view can do to a card, handed down from the editor — or `undefined`, which is a view
 * with nothing but an `onSelect`.
 *
 * Every field is optional on its own, so a surface can be given the stepper without the move
 * or the drop without the drag, and none of the four views has to know which it got.
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
  /** Every copy, into another category. */
  move?: (card: DeckCard, to: number) => void;
  /** Where a card may go. The card's own category is dropped from the list here, which is the
   *  one exclusion no caller can get right for it. */
  moveTargets?: readonly DeckCategory[];
  /**
   * What a drop on a group writes. `dnd.ts` decided *what* a drop means and refused the ones
   * that mean nothing; this is handed the answer.
   *
   * Its presence is also what makes cards **draggable**: a deck that can be dropped into is a
   * deck that can be picked up out of, and the two halves of a move-by-drag are never useful
   * apart.
   */
  drop?: (write: DeckWrite) => void;
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
 * single target over the whole view would land every drop in whatever the "Add to" select
 * happened to say, which is a silent difference between the drag and the button beside it.
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
 * this one" — the sidebar's pair (`AppShell`'s `DROP_RING` / `DROP_OVER`) said on the four
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
 * The controls a card carries: how many copies, and where they go.
 *
 * **Not a popup, and deliberately not the row menu it replaces.** The old menu was a custom
 * anchored layer, which made it a sixth `"inner"` peer in the editor's Escape union and gave it
 * a z-index, a focus hand-back and a click-away boundary to get right. A native `<select>` is
 * none of those things: the browser draws it in its own layer, it needs no rung, and it is
 * reachable by keyboard, by pointer and by voice without this app writing a line of it.
 *
 * `null` when there is nothing to offer, so a view can render this unconditionally and a view
 * with no actions grows no empty box.
 */
export function DeckCardControls({
  card,
  actions,
  className,
}: {
  card: DeckCard;
  actions?: DeckCardActions;
  className?: string;
}) {
  const setQuantity = actions?.setQuantity;
  const move = actions?.move;
  const targets = (actions?.moveTargets ?? []).filter((c) => c.id !== card.categoryId);
  if (!setQuantity && !(move && targets.length > 0)) return null;

  return (
    // `data-no-drag` on the wrapper rather than on each control: `cardDraggable` asks
    // `closest()`, so one mark covers the buttons, and `input`/`select` are excluded by tag
    // anyway. Without it a press on `−` plus five pixels of travel is a drag of the whole card.
    <span
      data-no-drag=""
      className={cn("flex flex-wrap items-center justify-center gap-1", className)}
    >
      {setQuantity && (
        <QuantityStepper
          size="xs"
          // Inside a card frame and inside a grid tile, both of which clip their own corners.
          focus="inset"
          value={card.quantity}
          // The floor is zero and zero is a real press: it is how a deck card leaves, and the
          // only way a reader can take one out with the keyboard.
          min={0}
          label={`Copies of ${card.name} in ${card.categoryName}`}
          onChange={(quantity) => setQuantity(card, quantity)}
        />
      )}
      {move && targets.length > 0 && (
        <select
          // Named by the **slot** and not by the card: the same printing sits in two categories
          // often enough, and two controls called "Move Sol Ring" are two a screen reader — and
          // a test — cannot tell apart.
          aria-label={`Move ${card.name} out of ${card.categoryName}`}
          // Always the placeholder: this select is a *verb*, not a field holding the card's
          // category. Leaving the last choice selected would make it read as though the card
          // were already there, and would make picking the same target twice a no-op.
          value=""
          onChange={(e) => {
            const to = Number(e.target.value);
            if (to) move(card, to);
          }}
          className={cn(
            "h-5 max-w-24 rounded-md border border-border bg-surface px-1 text-[0.625rem] text-dim",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            FOCUS_INSET,
          )}
        >
          <option value="">Move…</option>
          {targets.map((category) => (
            <option key={category.id} value={String(category.id)}>
              {category.name}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}

/**
 * How the controls are revealed on the three views that draw a card as a *picture*.
 *
 * They sit over the card rather than in it, which is the whole reason `CardStack`'s geometry
 * survived them: an absolutely positioned bar takes no height, so a card is still 312px, a
 * stack is still `34n + 286`, and the no-reflow property stays a fact about arithmetic rather
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
