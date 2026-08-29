import { useCallback, useEffect, useState, type RefObject } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { readCards, readDragData, type DragPayload } from "@/features/decks/dnd";
import { useDeck } from "@/features/decks/useDeck";
import { dndManager } from "@/lib/dndManager";
import { useDndDropTarget } from "@/lib/dndTarget";
import { ipc, ipcError } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";

/**
 * How long a drop's sentence stays up when nothing takes it down first.
 *
 * A timer, where almost nothing else in this app has one — and it is allowed here because it
 * is not a transition: the line appears and disappears instantly, and this only decides *when*
 * a sentence about something that already happened stops being news. Picking up the next card
 * clears it sooner, which is the case that actually happens.
 */
export const REPORT_MS = 4000;

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
  /** What just happened here, for the entry's live region, or `null`. */
  report: string | null;
  /** Write it. Only ever called with a payload {@link readDragData} returned and this entry
   *  accepted, so it needs no guard of its own beyond the open deck's id. */
  onDrop: (payload: DragPayload) => void;
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
 * What this surface owns is the **reporting** — which is why the sentences are attached as
 * per-call callbacks on `mutate` rather than folded into the definition. A drop reports where
 * the reader dropped it; the write and its refusal rule belong to the deck.
 *
 * `null` mounts an idle mutation and a query that asks for nothing, the shape the gallery's
 * `useDeck(null)` already has.
 */
export function useSidebarDrops() {
  const openDeckId = useAppStore((s) => s.openDeckId);
  const queryClient = useQueryClient();
  const deck = useDeck(openDeckId);
  /** A card is in the air somewhere in the window — what raises the ring. */
  const [dragging, setDragging] = useState(false);
  /** The one sentence the sidebar is saying, and which entry is saying it. One at a time,
   *  because one drop happens at a time. */
  const [report, setReport] = useState<{ at: SidebarTargetId; text: string } | null>(null);

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
      void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
      setReport({ at: "wishlist", text: "Added to wishlist." });
    },
    // No invalidation on the way out, where the deck's write has one: a refused wish wrote
    // nothing and deleted nothing, so there is no list on screen that has gone wrong.
    onError: (error) => setReport({ at: "wishlist", text: ipcError(error) }),
  });

  // A card in the air anywhere in the window, and the last sentence taken down as the next one
  // is picked up. `dragend` fires for a cancelled drag as well as a completed one — the library
  // ends both the same way — so the ring stands down on Escape without this hearing a keypress.
  //
  // **The manager's own listener rather than `useDndDragging`**, and the reason is the second
  // write: picking a card up clears whatever the last drop said, and that is a fact about the
  // *event* rather than about the payload. Derived from a `dragging` flag it would have to be a
  // `setState` inside an effect keyed on that flag, which is the shape `no-setState-in-an-effect`
  // exists to keep out — and two subscriptions where one says both things.
  useEffect(() => {
    const off = [
      dndManager.monitor.addEventListener("dragstart", ({ operation }) => {
        if (!operation.source || readDragData(operation.source.data) === null) return;
        setDragging(true);
        setReport(null);
      }),
      dndManager.monitor.addEventListener("dragend", () => setDragging(false)),
    ];
    return () => {
      for (const stop of off) stop();
    };
  }, []);

  // …and the other half of "whichever comes first". Keyed on the report object rather than on
  // its text, so a second identical sentence restarts the clock instead of inheriting what was
  // left of the first one's.
  useEffect(() => {
    if (report === null) return;
    const timer = setTimeout(() => setReport(null), REPORT_MS);
    return () => clearTimeout(timer);
  }, [report]);

  const writeToDeck = deck.addCard.mutate;
  // Whatever the shared read last answered. `useSwapFromPane` reads `deckGone` off the same
  // query for the same reason: with an editor open there is always an answer here.
  const deckName = deck.deck?.name;
  const dropOnDecks = useCallback(
    (payload: DragPayload) => {
      // Unreachable: the entry refuses the drop with no deck open. A fence rather than a path,
      // and the alternative is `deck_add_card` addressed to deck `null` (which `opened` throws
      // on, into a mutation state nothing here draws).
      if (openDeckId === null) return;
      writeToDeck(
        // **One copy, and the pile is whatever the payload knows.** A sidebar entry is a
        // destination rather than a form: it is a nav item several views away from the deck, so
        // for a card off a wall there is no column here a reader could have pointed at, and the
        // deck's own columns are where somebody who means the sideboard drops one. So that card
        // names no category and rides its **type line** instead, which `useDeck`'s `addCard`
        // files through `autoCategoryFor` — a Ramp artifact dropped here lands under Artifact,
        // found or created. The line comes from the payload rather than a lookup, which is what
        // keeps this a gesture and not a query: every source that carries a `"card"` has it in
        // hand when it registers its draggable (`dnd.ts`). `null` — an orphaned collection row
        // whose printing has left `cards` — files under `Uncategorized`.
        //
        // **A card dragged out of the open deck keeps its own category**, because it has one:
        // `fromCategoryId` is a pile of *this* deck (a deck card exists only while its editor is
        // mounted), so the rule that a drag names its own destination holds here too. It used to
        // land in a found-or-created "Main deck" instead, which quietly moved a Sideboard card's
        // extra copy into the main deck.
        payload.kind === "deck-card"
          ? { cardId: payload.cardId, categoryId: payload.fromCategoryId, quantity: 1 }
          : { cardId: payload.cardId, typeLine: payload.typeLine, quantity: 1 },
        {
          // The fallback is the sliver where the editor's read has not landed yet — the drop
          // still writes, and the sentence says what it can.
          onSuccess: () =>
            setReport({ at: "decks", text: `Added to ${deckName ?? "the open deck"}.` }),
          onError: (error) => setReport({ at: "decks", text: ipcError(error) }),
        },
      );
    },
    [openDeckId, writeToDeck, deckName],
  );

  const writeWish = addWish.mutate;
  const dropOnWishlist = useCallback(
    (payload: DragPayload) => writeWish(payload.cardId),
    [writeWish],
  );

  const noDeck = openDeckId === null;
  return {
    /** True while a card this app dragged is in the air — what puts the ring up. */
    dragging,
    decks: {
      eligible: !noDeck,
      inertReason: noDeck ? NO_OPEN_DECK : null,
      report: report?.at === "decks" ? report.text : null,
      onDrop: dropOnDecks,
    } satisfies SidebarDrop,
    wishlist: {
      // From anywhere, always: a shopping list needs nothing on screen to be added to.
      eligible: true,
      inertReason: null,
      report: report?.at === "wishlist" ? report.text : null,
      onDrop: dropOnWishlist,
    } satisfies SidebarDrop,
  };
}

/**
 * One navigation entry as a place to let a card go — the registration, and the two facts the
 * entry draws itself from.
 *
 * **It is here rather than in either drawing of navigation, because there are two of them now.**
 * `AppShell`'s `NavItem` is the rail's row and `BottomTabBar`'s tab is the phone's, and they are
 * two drawings rather than one component with a flag — a rail entry is a full-width button with a
 * left-anchored icon and a tab is a square with its word under the glyph. What they must *not*
 * be is two registrations, because everything below is a rule about the drag rather than about
 * the row, and a second copy of it would be a second place for the rule to move.
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
    onDrop: (payloads) => {
      for (const payload of payloads) drop?.onDrop(payload);
    },
  });

  return {
    over,
    eligible: drop !== null && dragging && drop.eligible,
    inert: drop !== null && dragging && !drop.eligible,
  };
}
