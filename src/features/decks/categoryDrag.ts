/**
 * Moving a **category** past its neighbours — the gesture, spelled once for the two surfaces
 * that offer it.
 *
 * `dnd.ts` is the other drag in this feature and the two must never be mistaken for each other:
 * that one carries a **card** between piles, this one carries a **pile** past other piles. Each
 * reader refuses anything without its own mark, so a pile picked up on the desk can never be
 * dropped into a column as if it were a card, and a card dragged off the search wall can never
 * land on a category heading as if it were a reorder.
 *
 * **Two surfaces, one vocabulary**: `CategoriesDialog`'s list of rows, where a pile is the
 * subject, and `StackView`'s flowing piles, where a pile is a column of cards the reader is
 * looking at. They draw completely differently and mean exactly the same write — one that used
 * a mark of its own would be a second gesture wearing the first one's clothes.
 *
 * **The write is `deck_category_reorder`, which takes _every_ id and writes `sort_order` from
 * position.** That is why {@link movedTo} answers a whole list rather than a from/to pair, and it
 * is the reason a view can never do this arithmetic for itself: what a view holds is the piles it
 * happens to be drawing — the flow, with the rail taken out and the empty auto piles never built
 * — and the command needs the deck's whole list. See {@link useCategoryReorderDrop}'s note on
 * addressing a move by **ids**.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  dropTargetForElements,
  draggable,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";

/**
 * The mark that says a drag is a category being moved, and nothing else.
 *
 * A key of its own rather than `dnd.ts`'s — see this module's header. `readDragData` refuses
 * anything without *its* mark and this refuses anything without this one, so the two gestures
 * are fenced off from each other at both ends rather than by which surface is on screen.
 */
const CATEGORY_MARK = "mtg-grimoire/category-order";

export function categoryDragData(id: number): Record<string, unknown> {
  return { [CATEGORY_MARK]: true, categoryId: id };
}

/** The category a drag is carrying, or `null` for every other drag in the window. Field by
 *  field, like `dnd.ts`'s reader: the library's store is untyped by construction, because every
 *  `draggable` in the window writes into it. */
export function readCategoryDrag(data: Record<string, unknown>): number | null {
  if (data[CATEGORY_MARK] !== true) return null;
  const id = data.categoryId;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * One id moved to one position — the whole of what a reorder is, as a pure function.
 *
 * `deck_category_reorder` takes **every** id and writes `sortOrder` from position, so a move is
 * expressed as the list it produces rather than as a from/to pair. Total: an id the list does
 * not hold, and a position off either end, both answer a copy of the list they were given
 * rather than throwing — a reorder that raced a delete still lands somewhere sensible.
 */
export function movedTo(ids: readonly number[], id: number, to: number): number[] {
  const next = [...ids];
  const from = next.indexOf(id);
  if (from < 0) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  if (from === target) return next;
  next.splice(from, 1);
  next.splice(target, 0, id);
  return next;
}

/**
 * A pile as a place another pile can be dropped — the mirror of `cardControl.tsx`'s
 * `useCategoryDrop`, for the other drag.
 *
 * Deliberately the same shape (`{ attach, over, eligible }`) and the same two-flag argument:
 * `eligible` is "a pile is in the air and this one is somewhere it could go", `over` is "and it
 * is this one". Without the first, a pile picked up in a fifteen-category deck lights nothing
 * until the pointer happens to cross a target.
 *
 * **A move is addressed by two ids, never by an index**, which is what the `onMove` signature is
 * about. The piles a view is drawing are a *subset* of the deck's categories — `splitRail` takes
 * the Sideboard and the Maybeboard out, and `drawsWhenEmpty` never builds the empty auto piles —
 * so a position in the flow is not a position in the list the command is sent. Only the editor
 * holds both, so this says which pile moved and which pile's place it is taking, and lets the
 * editor resolve them.
 *
 * **Landing "where this one is" rather than before or after it** is `CategoriesDialog`'s rule,
 * kept because it is also what the arrow keys mean: one step further along is the same move,
 * and an edge-detection hitbox would be a second, quietly different answer for the mouse.
 *
 * **A monitor per pile**, for `useCategoryDrop`'s reason: pdnd asks it at `dragstart` and at
 * `drop` and never per pointer move, and one monitor at the top of the view would have to drill
 * the flag down through the group component anyway. `canMonitor` refuses every card drag, so
 * dragging a card through the deck costs this nothing at all — no `dragstart`, no re-render.
 */
export function useCategoryReorderDrop(
  categoryId: number | null,
  onMove?: (categoryId: number, targetId: number) => void,
) {
  const [over, setOver] = useState(false);
  const [eligible, setEligible] = useState(false);
  const enabled = categoryId !== null && onMove !== undefined;

  useEffect(() => {
    if (categoryId === null || !onMove) return;
    return monitorForElements({
      // The same question `canDrop` asks below, so "eligible" means this pile really would take
      // *this* drag — a pile dragged over itself lights nothing.
      canMonitor: ({ source }) => {
        const dragged = readCategoryDrag(source.data);
        return dragged !== null && dragged !== categoryId;
      },
      onDragStart: () => setEligible(true),
      // Fires for a cancelled drag as well as a completed one, so the ring stands down on
      // Escape without this hearing a keypress.
      onDrop: () => {
        setEligible(false);
        setOver(false);
      },
    });
  }, [categoryId, onMove]);

  // `attach` rather than `ref` — React's ref lint reads a hook result called `ref` as a ref
  // object and flags every read beside it as a ref access during render. `useCategoryDrop`
  // carries the same name for the same reason.
  const attach = useCallback(
    (element: HTMLElement | null) => {
      if (!element || categoryId === null || !onMove) return;
      return dropTargetForElements({
        element,
        // Asked twice, like every drop target here: once so a drop that would mean nothing
        // never lights up, and again on the drop itself, because the two questions can be a
        // second apart and only the second one writes.
        canDrop: ({ source }) => {
          const dragged = readCategoryDrag(source.data);
          return dragged !== null && dragged !== categoryId;
        },
        onDragEnter: () => setOver(true),
        onDragLeave: () => setOver(false),
        onDrop: ({ source }) => {
          setOver(false);
          const dragged = readCategoryDrag(source.data);
          if (dragged !== null && dragged !== categoryId) onMove(dragged, categoryId);
        },
      });
    },
    [categoryId, onMove],
  );

  return { attach, over: over && enabled, eligible: eligible && enabled };
}

/**
 * A pile as something that can be picked up: **the heading is the drag source and the grip
 * inside it is the only place a press may start**.
 *
 * `CategoriesDialog`'s arrangement exactly — a `mousedown` remembered in the **capture** phase,
 * so a control that stops the press cannot hide it from this, and `canDrag` reading the flag at
 * `dragstart`, which is handed the pointer's *coordinates* rather than what it pressed.
 *
 * **The reason is the drag preview, and it is a choice rather than a constraint.** Registering the
 * grip `<button>` itself works — measured in the shipped window on 2026-08-17, a pdnd `draggable`
 * on the button starts a real Chromium drag — and it is the simpler code by a wide margin. What it
 * hands the reader is a 14px ghost of the glyph they grabbed, on a gesture that moves a whole
 * column across the desk; every other drag in this app previews the thing being moved (a card
 * previews the card, the dialog's row previews the row). The heading is the smallest box that says
 * which pile is in the air: its name and its two numbers.
 *
 * (**That measurement replaced the opposite claim, which is why it is written down.** The first
 * live attempt failed with *"the browser never started a drag"* and read exactly like Chromium
 * refusing a form control. It was not: the pile being aimed at was **scrolled out of the editor's
 * own scroller**, so the coordinates `getBoundingClientRect` answered with landed on `<main>` and
 * the press never reached the grip. `elementFromPoint` at the rect's centre is the cheap check,
 * and a CDP drag pass owes it before concluding anything about a source.)
 *
 * **The heading rather than the whole section**, which is the one place this parts company with
 * the dialog: a pile is 300–1 500px tall, so dragging the section would hand back the preview
 * problem an order of magnitude worse. It also keeps this gesture and the card drags underneath it
 * in two disjoint subtrees, so neither `canDrag` is ever asked about the other's press.
 *
 * Both callbacks are stable, which matters twice: React 19 takes what a ref callback returns as
 * its cleanup, so a new function each render would unregister and re-register the draggable on
 * every re-render of the deck — including the ones a drag it started is causing.
 */
export function useCategoryDragSource(id: number | null) {
  const handleRef = useRef<HTMLElement | null>(null);

  const attachHandle = useCallback((element: HTMLElement | null) => {
    handleRef.current = element;
    return () => {
      handleRef.current = null;
    };
  }, []);

  const attachSource = useCallback(
    (element: HTMLElement | null) => {
      if (!element || id === null) return;
      let fromHandle = false;
      const press = (event: Event) => {
        fromHandle =
          event.target instanceof Node && handleRef.current?.contains(event.target) === true;
      };
      element.addEventListener("mousedown", press, true);
      const stop = draggable({
        element,
        canDrag: () => fromHandle,
        getInitialData: () => categoryDragData(id),
      });
      return () => {
        element.removeEventListener("mousedown", press, true);
        stop();
      };
    },
    [id],
  );

  return { attachSource, attachHandle };
}
