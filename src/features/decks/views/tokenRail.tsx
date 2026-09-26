/**
 * Where the deck's **Tokens & Emblems** pile sits in the right-hand rail, and the gesture that
 * moves it there (spec §3.4, the reader's own ask: *"the tokens stack should be draggable to
 * reorder in the right hand rail"*).
 *
 * ## Why this is not a category, and not `categoryDrag.ts`
 *
 * The pile looks like a railed pile — a heading, a grip, a stack under it — and it is moved by the
 * same two gestures a railed pile is: its heading dragged by the grip, or the grip's two arrow
 * keys. What it is **not** is a category, and every difference below follows from that.
 *
 * * **It is stored as an index, never as an anchor.** `decks.token_rail_index` is *the number of
 *   rail piles drawn above it*, `-1` for last. An anchor — "under the Sideboard" — would be a
 *   category id on a synced row, which needs the sync's `sync_uid` translation, and switching the
 *   anchor pile on would take it out of the rail and send the tokens to the bottom for a reason
 *   the reader cannot see. A count needs neither. What a count costs is that a rail which shrank
 *   no longer has the slot, and {@link tokenRailSlot} answers that the only way that never loses
 *   the pile: it draws last.
 * * **It is in no run.** A category's grip steps within the run it is drawn in (`reorderIds`,
 *   issue #508) and its write is two ids. The token pile is in neither of the rail's two runs —
 *   it is not in the deck at all — so its `n of N` counts *every* rail pile plus itself, it may go
 *   between the Sideboard and a switched-off pile of the reader's own, and its write is one number.
 * * **It has a mark of its own.** {@link TOKEN_PILE_DRAG} is not `categoryDrag.ts`'s mark and not
 *   `dnd.ts`'s, and each reader refuses the other two: the pile let go on a rail pile can never
 *   land as a category reorder or as a card, and a category let go on the token pile has nothing
 *   to land on — the pile registers no category target, so the drop is refused by construction.
 *
 * What the pile *shares* with a railed category is everything about how the gesture feels, and it
 * is copied rather than re-decided: the heading is the drag source and the grip only says where a
 * press may start ({@link useTokenPileDragSource}), a drop lands the pile **where the target pile
 * is** ({@link useTokenPileDrop}), and the grip answers the same two keys with the same
 * `preventDefault` handshake against `StackView`'s own arrows ({@link TokenPileGrip}).
 *
 * **Only Stacks draws the gesture.** Grid and Text spend the index as *order* — the pile's place
 * among the rail's piles — and Table does not spend it at all: its token section is a list after
 * the virtualised table, with no place among the bands to take.
 *
 * **A `.tsx` for one button.** The rest of this module is arithmetic and two hooks, and the grip
 * was first spelled with `createElement` in a `.ts` — `transfer/import/destinations/deckInto.ts`'
 * arrangement. `react-hooks/refs` cannot see through that call: a `ref` prop handed to a function
 * reads to it as a ref read during render, where the same prop on a JSX `<button>` — which is
 * exactly `CategoryGrip`'s — is the ordinary thing it is.
 */
import { useCallback, useState, type JSX } from "react";
import { PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";
import { GripVertical } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { dndDraggable, useDndDropTarget, useDndTargetRef } from "@/lib/dndTarget";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { TOKENS_HEADING } from "../DeckTokensPanel";

/**
 * Where the pile sits among `railLength` rail piles: `stored` when it is a slot the rail has,
 * else `railLength` (last). `-1` is last by definition.
 *
 * **Anything that is not a whole number in `[0, railLength]` is last**, and that is one rule
 * rather than three: `-1` (the column's default and what a move to the end writes), an index the
 * rail has since lost (the reader put the pile at 3, then switched two piles back on — review
 * focus 2), and a `NaN` or a fraction that no write of this app produces but a synced row from a
 * build that does not know the column could. Last is where every deck's pile was before the
 * column existed, so it is the one answer that is never a surprise.
 */
export function tokenRailSlot(stored: number, railLength: number): number {
  return Number.isInteger(stored) && stored >= 0 && stored <= railLength ? stored : railLength;
}

/**
 * The value to store for slot `slot` of a rail of `railLength`: `-1` for the last slot.
 *
 * **Last is stored as `-1` and never as the length**, so the pile *stays* last: a pile switched
 * on or off later changes the rail's length, and a stored `2` on a rail that grew to three would
 * leave the tokens above the newcomer, which is not where the reader put them.
 */
export function storedRailIndex(slot: number, railLength: number): number {
  return slot >= railLength ? -1 : slot;
}

/**
 * `items` with `pile` inserted at `slot`.
 *
 * Total in the same way {@link tokenRailSlot} is — a slot the list does not have puts the pile
 * last — because a view draws what this answers and a pile that went missing is the one bug the
 * index must never be able to cause.
 */
export function withTokenPile<T, P>(items: readonly T[], slot: number, pile: P): (T | P)[] {
  const at = tokenRailSlot(slot, items.length);
  return [...items.slice(0, at), pile, ...items.slice(at)];
}

/**
 * What a view inserts into its rail to say "the token pile goes here" — one sentinel for the three
 * views that place the pile, so `item === TOKEN_ITEM` is the whole of how each tells it from a
 * pile of the deck.
 */
export const TOKEN_ITEM: unique symbol = Symbol("token pile");

/**
 * The mark that says a drag is the token pile being moved, and nothing else.
 *
 * A key of its own for this module's header's reason: `readCategoryDrag` and `dnd.ts`'s readers
 * refuse anything without *their* marks, and {@link isTokenPileDrag} refuses anything without this
 * one, so the three gestures are fenced off from each other at every end.
 */
export const TOKEN_PILE_DRAG = "mtg-grimoire/token-pile";

/** The token pile's drag payload — a mark and nothing else, since there is one pile to carry. */
export function tokenPileDragData(): Record<string, unknown> {
  return { [TOKEN_PILE_DRAG]: true };
}

/** Whether a drag is the token pile. The library's store is untyped by construction — every
 *  draggable in the window writes into it — so this reads the one field and trusts nothing else. */
export function isTokenPileDrag(data: Record<string, unknown>): boolean {
  return data[TOKEN_PILE_DRAG] === true;
}

/** {@link isTokenPileDrag} in the shape `useDndDropTarget` reads: the payload, or `null` for every
 *  other drag in the window. */
function readTokenPileDrag(data: Record<string, unknown>): true | null {
  return isTokenPileDrag(data) ? true : null;
}

/**
 * A rail pile's acceptance of the token pile, landing it at `slot` — `useCategoryReorderDrop`'s
 * shape (`{ attach, over, eligible }`) and its two flags, for the other gesture.
 *
 * **`slot` is the place the pile takes when it is let go here, and it is this pile's own index in
 * the rail as drawn — the token pile counted.** That is `CategoriesDialog`'s *land where this one
 * is*, which is also what the arrow keys mean: a rail pile above the tokens is at its own rail
 * index, so the tokens take that slot and go above it; one below is one further along for the
 * tokens standing in front of it, so the tokens go under it. The last pile is therefore how a drag
 * reaches the last slot, and no drop onto a rail pile ever lands the pile where it already is.
 *
 * `null` is the off switch — every pile the host has not offered the gesture on, the flow and the
 * command zone included, which never accept the pile. `onMove` gets the slot and the caller turns
 * it into what is stored ({@link storedRailIndex}).
 */
export function useTokenPileDrop(
  slot: number | null,
  onMove?: (slot: number) => void,
): { attach: (el: HTMLElement | null) => () => void; over: boolean; eligible: boolean } {
  const enabled = slot !== null && onMove !== undefined;
  // `attach`, not `ref`, for `useCategoryReorderDrop`'s reason — React's ref lint reads a hook
  // result called `ref` as a ref object. {@link useDndTargetRef} has why the element is state.
  const { ref, attach } = useDndTargetRef();
  // The token pile is never a target of its own drag (it registers none), so there is no "dropped
  // on itself" to refuse here, and no run to scope by: any rail pile may take it.
  const canDrop = useCallback(() => slot !== null, [slot]);
  const onDrop = useCallback(() => {
    if (slot !== null) onMove?.(slot);
  }, [slot, onMove]);
  const { armed, over } = useDndDropTarget({ ref, read: readTokenPileDrag, canDrop, onDrop });

  return { attach, over: over && enabled, eligible: armed && enabled };
}

/**
 * The pile's own drag source — `useCategoryDragSource`'s shape, with the token payload.
 *
 * **The heading is what is dragged and the grip is where the press must start**, for that hook's
 * reason verbatim: what travels under the pointer is the pile's name and its two figures, never a
 * 14px ghost of the glyph. The grip is dnd-kit's own `handle`, held as **state** so the source is
 * registered only once the grip exists — a source with no declared handle would drag from anywhere
 * on the heading.
 *
 * **The 5px threshold is put back by hand, and the source carries only the pointer's sensor**, both
 * for `useCategoryDragSource`'s reasons: a declared handle switches dnd-kit's default activation
 * constraints off (a plain click on the grip would become a zero-pixel move), and a per-source
 * `sensors` list replaces the manager's, which keeps `KeyboardSensor` — and so Space — off the one
 * button that already answers the arrow keys itself.
 *
 * `enabled` false registers nothing, which is the host offering no move.
 */
export function useTokenPileDragSource(enabled: boolean): {
  attachSource: (el: HTMLElement | null) => void | (() => void);
  attachHandle: (el: HTMLElement | null) => () => void;
} {
  const [handle, setHandle] = useState<HTMLElement | null>(null);

  const attachHandle = useCallback((element: HTMLElement | null) => {
    setHandle(element);
    return () => setHandle(null);
  }, []);

  const attachSource = useCallback(
    (element: HTMLElement | null) => {
      if (!element || !enabled || !handle) return;
      return dndDraggable({
        element,
        handle,
        data: tokenPileDragData,
        sensors: [
          PointerSensor.configure({
            activationConstraints: [new PointerActivationConstraints.Distance({ value: 5 })],
          }),
        ],
      });
    },
    [enabled, handle],
  );

  return { attachSource, attachHandle };
}

/**
 * How a test — or a live pass — finds a pile's grip, the token pile's included. An attribute
 * rather than a role, because every one of these is a `button` with an accessible name of its own
 * and the sweep that wants them all wants "the piles that can be moved" rather than any particular
 * name.
 *
 * **Declared here and re-exported by `StackView.tsx`**, whose `CategoryGrip` is the other carrier:
 * both grips wear it, and this module cannot import the view that places the pile without the two
 * importing each other. The value keeps its old spelling because it is what every probe already
 * reads. `deckGroupProps`' `DECK_GROUP_ATTR` and `STACK_ATTR` are the same idea for the same
 * reason.
 */
export const GRIP_ATTR = "data-category-grip";

/**
 * The grip the token pile is picked up by — **and the whole of the keyboard's way to move it.**
 *
 * `StackView`'s `CategoryGrip`, copied rather than shared because what it steps through is not a
 * run of ids: the same `GripVertical` button, the same {@link GRIP_ATTR}, the same `FOCUS`, the
 * same tooltip, and the same two keys meaning "one place earlier" and "one place later". `ref` is
 * {@link useTokenPileDragSource}'s `attachHandle`, which is how the source knows the press was
 * this one.
 *
 * **Both arrows call `preventDefault()`, the dead ends included, and that is the handshake.**
 * `StackView`'s root binds the same two keys to moving the caret between cards and returns early
 * on `defaultPrevented`; a grip at slot 0 whose ArrowLeft sent nothing *and* left the press
 * unclaimed is where the arrows would quietly start meaning something else. Stepping past either
 * end sends nothing — a write that changes nothing is still a round trip and a history line.
 *
 * The accessible name says where the pile is, `CategoryGrip`'s rule: `n of N` counts every rail
 * pile and the tokens themselves, which is every place the pile can be.
 */
export function TokenPileGrip({
  ref,
  slot,
  railLength,
  onMove,
}: {
  ref: (el: HTMLElement | null) => void;
  /** Where the pile is now — {@link tokenRailSlot}'s answer, never the stored value. */
  slot: number;
  /** How many rail piles there are besides the tokens. */
  railLength: number;
  /** A step to slot `to`, in `[0, railLength]`. The caller stores it ({@link storedRailIndex}). */
  onMove: (slot: number) => void;
}): JSX.Element {
  const tip = useTooltip();
  const step = (to: number) => {
    if (to >= 0 && to <= railLength) onMove(to);
  };

  return (
    <button
      ref={ref}
      type="button"
      {...{ [GRIP_ATTR]: "" }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          step(slot - 1);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          step(slot + 1);
        }
      }}
      aria-label={`Move ${TOKENS_HEADING}, ${slot + 1} of ${railLength + 1}`}
      {...tip("Drag to reorder, or press the left and right arrow keys")}
      className={cn(
        "shrink-0 cursor-grab rounded-sm text-dim",
        "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
        FOCUS,
      )}
    >
      <GripVertical className="size-3.5" aria-hidden="true" />
    </button>
  );
}
