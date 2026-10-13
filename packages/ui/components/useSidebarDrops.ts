import { useCallback, type RefObject } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { readCards, readDragData, type DragPayload } from "@/features/decks/dnd";
import { useDeck } from "@/features/decks/useDeck";
import { useDndDragging, useDndDropTarget } from "@/lib/dndTarget";
import { ipc, ipcError } from "@/lib/ipc";
import { notify } from "@/lib/notifications";
import { useAppStore } from "@/lib/store";
import { refreshCardSearches } from "@/lib/searchMarks";

/** What the Decks entry says while it cannot take a card, on the one gesture that asks. */
const NO_OPEN_DECK = "Open a deck to drop cards into it";

/** The two sidebar entries a card can be let go on. The collection is deliberately not one:
 *  `collection_add` carries a finish, a condition and a language that a drop cannot answer,
 *  and a drop that invented "NM nonfoil" would write facts the reader never said. */
export type SidebarTargetId = "decks" | "wishlist";

/** One entry, as the sidebar draws it and as the drop target asks it. */
export interface SidebarDrop {
  /** Whether a card in the air can land here at all — `canDrop`, and the ring. */
  eligible: boolean;
  /** Why it cannot, for the entry's own tooltip while a card is in the air. `null` when it
   *  can: an entry that is working says so by lighting up, not in words. */
  inertReason: string | null;
  /** Write them — **every card of the gesture in one call**, so the drop answers with one
   *  toast rather than one per card. Only ever called with payloads {@link readCards} returned
   *  and this entry accepted, so it needs no guard of its own beyond the open deck's id. */
  onDrop: (payloads: readonly DragPayload[]) => void;
}

/**
 * The toast a drop answers with: the card by name when it was one, a count when it was a set.
 * `where` is already worded — `“Burn”`, `the open deck`, `the wishlist`.
 */
export function dropReceipt(added: number, payloads: readonly DragPayload[], where: string) {
  const what =
    payloads.length === 1 && added === 1
      ? `“${payloads[0].name}”`
      : `${added} ${added === 1 ? "card" : "cards"}`;
  return `Added ${what} to ${where}`;
}

/**
 * Write every card of one drop, then say once what happened — **one gesture, one toast**, however
 * many cards it carried. All landed: a receipt. Some refused: one warning, `Added 47 of 50 cards
 * to …`, carrying the **first** refusal (a deck deleted under the drop refuses every card in the
 * same words, so one is the sentence). None landed: the refusal, as an error.
 *
 * `mutateAsync` rather than `mutate`, because `mutate`'s per-call callbacks fire for the
 * **latest** call only, and a multi-card drop reported on its last card alone (`cardMenu.tsx`'s
 * deck queue learnt the same in issue #954). The writes go out together, as they always have from
 * here; only the reporting waits for all of them.
 */
async function writeAndReport(
  payloads: readonly DragPayload[],
  write: (payload: DragPayload) => Promise<unknown>,
  where: string,
) {
  const settled = await Promise.allSettled(payloads.map(write));
  const added = settled.filter((s) => s.status === "fulfilled").length;
  const refused = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (refused === undefined) notify.success(dropReceipt(added, payloads, where));
  else if (added === 0)
    notify.error(`Couldn't add to ${where}`, { body: ipcError(refused.reason) });
  else {
    notify.warning(`Added ${added} of ${payloads.length} cards to ${where}`, {
      body: ipcError(refused.reason),
    });
  }
}

/**
 * The sidebar's two drop targets: what they accept, what they write, and what they say
 * afterwards.
 *
 * **Every payload the app drags names a card**, so both entries take all three kinds — a
 * search tile, a collection row, a wish, a printings row, a panel tile, and a deck row. What
 * differs is the write, not the acceptance: a deck row dropped on Wishlist is a wish for that
 * printing, exactly as a search tile is.
 *
 * **The deck write is `useDeck`'s, mounted whole, exactly as {@link useSwapFromPane} mounts it
 * for the card pane** — the second surface outside the editor to reach a deck write, and the
 * same answer for the same reasons. The query it brings along is the `["decks", "detail", id]`
 * the editor is already reading (a deck can only be open with an editor mounted, and TanStack
 * shares a query's cache between observers), so it costs no `deck_get` and hands back the
 * deck's *name* for the sentence below. And the refusal rule that carries a GONE from here back
 * to the editor's columns lives on the mutation's single definition rather than on this call
 * site: two definitions would be two places to keep one rule.
 *
 * What this surface owns is the **reporting** — which is why the sentences are said here, at
 * the gesture, rather than folded into the definition. A drop reports what the reader dropped;
 * the write and its refusal rule belong to the deck.
 *
 * **The report is a toast** (`@/lib/notifications`). It used to be a line under the entry that
 * cleared itself after four seconds or on the next pickup — a hand-rolled toast in all but name,
 * squeezed into a 183px column (a panel beside the rail when it was collapsed). A drop is a
 * deliberate write to a list on another page, so it gets the app's receipt, and a refusal gets
 * the app's refusal; both are then in the inbox for a reader who looked away.
 *
 * `null` mounts an idle mutation and a query that asks for nothing, the shape the gallery's
 * `useDeck(null)` already has.
 */
export function useSidebarDrops() {
  const openDeckId = useAppStore((s) => s.openDeckId);
  const queryClient = useQueryClient();
  const deck = useDeck(openDeckId);
  /**
   * A card is in the air somewhere in the window — what raises the ring. `dragend` fires for a
   * cancelled drag as well as a completed one, so the ring stands down on Escape without this
   * hearing a keypress; a drag this app did not put in the air reads as `null` and raises none.
   */
  const dragging = useDndDragging(readDragData) !== null;

  const addWish = useMutation({
    // The printing that was dragged, pinned — the reader was looking at *this* one — and no
    // finish, which is the wishlist's own default and the only honest answer a drop has.
    //
    // Defined here where the deck's write is borrowed, because there is nothing to borrow: the
    // wishlist's own view owns a stepper and a removal, and the quick-add's is inside the
    // popup that asks for a finish. This is the first write that adds a wish from a gesture.
    mutationFn: (cardId: string) => ipc.wishlistAdd({ cardId, quantity: 1 }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
      // A result row draws `wishlisted`, so the heart on every printing of this card has
      // just changed. No `["collection"]`: a wish moves no copies.
      void refreshCardSearches(queryClient);
    },
    // No invalidation on the way out, where the deck's write has one: a refused wish wrote
    // nothing and deleted nothing, so there is no list on screen that has gone wrong. The
    // refusal is said by the drop that asked (`writeAndReport`).
  });

  const writeToDeck = deck.addCard.mutateAsync;
  // Whatever the shared read last answered. `useSwapFromPane` reads `deckGone` off the same
  // query for the same reason: with an editor open there is always an answer here.
  const deckName = deck.deck?.name;
  const dropOnDecks = useCallback(
    (payloads: readonly DragPayload[]) => {
      // Unreachable: the entry refuses the drop with no deck open. A fence rather than a path,
      // and the alternative is `deck_add_card` addressed to deck `null` (which `opened` throws
      // on, into a mutation state nothing here draws).
      if (openDeckId === null) return;
      // The fallback is the sliver where the editor's read has not landed yet — the drop
      // still writes, and the sentence says what it can.
      const where = deckName === undefined ? "the open deck" : `“${deckName}”`;
      void writeAndReport(
        payloads,
        (payload) =>
          writeToDeck(
            // **One copy, and the pile is whatever the payload knows.** A sidebar entry is a
            // destination rather than a form: it is a nav item several views away from the deck,
            // so for a card off a wall there is no column here a reader could have pointed at. So
            // that card names no category and lands where **the deck** says its adds land —
            // `deckDefault`, the setting the editor's own Add button honours (issue #693) — and
            // on a deck left on Auto it rides its **type line** instead, which `useDeck`'s
            // `addCard` files through `autoCategoryFor` — a Ramp artifact dropped here lands
            // under Artifact, found or created. The line comes from the payload rather than a
            // lookup, which is what keeps this a gesture and not a query: every source that
            // carries a `"card"` has it in hand when it registers its draggable (`dnd.ts`).
            // `null` — an orphaned collection row whose printing has left `cards` — files under
            // `Uncategorized`.
            //
            // **A card dragged out of the open deck keeps its own category**, because it has
            // one: `fromCategoryId` is a pile of *this* deck (a deck card exists only while its
            // editor is mounted), so the rule that a drag names its own destination holds here
            // too. It used to land in a found-or-created "Main deck" instead, which quietly moved
            // a Sideboard card's extra copy into the main deck.
            payload.kind === "deck-card"
              ? { cardId: payload.cardId, categoryId: payload.fromCategoryId, quantity: 1 }
              : {
                  cardId: payload.cardId,
                  deckDefault: true,
                  typeLine: payload.typeLine,
                  quantity: 1,
                },
          ),
        where,
      );
    },
    [openDeckId, writeToDeck, deckName],
  );

  const writeWish = addWish.mutateAsync;
  const dropOnWishlist = useCallback(
    (payloads: readonly DragPayload[]) =>
      void writeAndReport(payloads, (payload) => writeWish(payload.cardId), "the wishlist"),
    [writeWish],
  );

  const noDeck = openDeckId === null;
  return {
    /** True while a card this app dragged is in the air — what puts the ring up. */
    dragging,
    decks: {
      eligible: !noDeck,
      inertReason: noDeck ? NO_OPEN_DECK : null,
      onDrop: dropOnDecks,
    } satisfies SidebarDrop,
    wishlist: {
      // From anywhere, always: a shopping list needs nothing on screen to be added to.
      eligible: true,
      inertReason: null,
      onDrop: dropOnWishlist,
    } satisfies SidebarDrop,
  };
}

/**
 * One navigation entry as a place to let a card go — the registration, and the two facts the
 * entry draws itself from.
 *
 * **It is here rather than in `AppShell`'s `NavItem`, because it is a rule about the drag rather
 * than about the row.** `NavItem` decides what the rail's entry looks like — a full-width button
 * with a left-anchored icon, a tooltip while the rail is collapsed — and this decides what a card
 * in the air may do to it. Keeping the two apart is what lets the row be redrawn without the
 * drag's reasoning moving with it.
 *
 * **Every card the drag is carrying** (issue #214) — `readCards`, which answers with one payload
 * for an ordinary drag, several for a multi-select one, and `null` for a drag this app did not put
 * in the air. The entry's own rule is asked once for the whole gesture: both entries take every
 * kind of card payload, so "may this land here" has never been a per-card question.
 *
 * No `getData`: what a drop writes is decided by the entry, and the entry is already here. An
 * entry that cannot take a card never accepts one — so `over` is only ever true for a drop that
 * will happen. `useDndDropTarget` reads `canDrop` and `onDrop` through a ref of its own, which is
 * what keeps the registration standing while the shell re-renders mid-drag: the shell re-renders
 * the moment a card is picked up — that is what raises the ring — and a drop target that
 * unregisters mid-drag is a drop that never arrives.
 *
 * **The entries a card cannot land on (`drop === null`) register a droppable too and refuse every
 * payload**, which costs a registry entry and nothing else: `computeCollisions` skips a droppable
 * whose `accepts()` is false before it measures it. Registering all of them is what keeps the
 * target set from changing shape mid-drag.
 */
export function useSidebarDropTarget({
  ref,
  drop,
  dragging,
}: {
  /** The element a card is let go on — the whole entry, never something smaller inside it. */
  ref: RefObject<HTMLElement | null>;
  /** What a drop here would mean, or `null` for the entries a card cannot land on. */
  drop: SidebarDrop | null;
  /** A card is in the air somewhere in the window — the only time an entry is anything but a
   *  link. */
  dragging: boolean;
}): {
  /** The card is over *this* entry: which one of the ringed set is about to take it. */
  over: boolean;
  /** This entry would take the card being carried — what raises the ring. */
  eligible: boolean;
  /** This entry takes cards, but not this one, and not now — what the refusal is drawn from. */
  inert: boolean;
} {
  const { over } = useDndDropTarget({
    ref,
    read: readCards,
    canDrop: () => drop?.eligible === true,
    // The whole gesture in one call, so a picked set dropped here is one write-and-report rather
    // than one toast per card.
    onDrop: (payloads) => drop?.onDrop(payloads),
    // **Over only while the pointer is inside the entry.** dnd-kit's default detector falls back
    // to the carried card's whole rectangle when the pointer is in no target, and the rail sits
    // flush against the left edge of every page — so a card held on the wall's first tile column
    // overlapped the Wishlist entry, lit it for the whole hold, and the release added a wish at
    // the wishlist root (Folder Shelves live re-check, new finding 1). An entry is somewhere a card
    // is let go on purpose; the deck editor's own piles, zones and tray keep the default.
    pointerOnly: true,
  });

  return {
    over,
    eligible: drop !== null && dragging && drop.eligible,
    inert: drop !== null && dragging && !drop.eligible,
  };
}
