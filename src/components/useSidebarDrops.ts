import { useCallback, useEffect, useState } from "react";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { readDragData, type DragPayload } from "@/features/decks/dnd";
import { useDeck } from "@/features/decks/useDeck";
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
  // is picked up. `onDrop` fires for a cancelled drag as well as a completed one — the platform
  // ends both the same way — so the ring stands down on Escape without this hearing a keypress.
  useEffect(
    () =>
      monitorForElements({
        canMonitor: ({ source }) => readDragData(source.data) !== null,
        onDragStart: () => {
          setDragging(true);
          setReport(null);
        },
        onDrop: () => setDragging(false),
      }),
    [],
  );

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
        // **No category, and one copy.** A sidebar entry is a destination rather than a form: it
        // is a nav item several views away from the deck, so there is no column here for a
        // reader to have pointed at, and the deck's own columns are where somebody who means
        // the sideboard drops a card. Omitting `categoryId` is what says that — `deck_add_card`
        // then takes a *name* to find or create, and `useDeck`'s `DEFAULT_CATEGORY_NAME` is the
        // one it sends: the v8 migration's own word for the pile it filed every legacy main-deck
        // row into, so a deck that predates categories and one made since agree about where a
        // plain add goes.
        //
        // A placeholder for the rule that is coming, not a decision made here: the spec's answer
        // is `autoCategoryFor` — one TypeScript rule reading a card's type line and naming the
        // pile it belongs in — and it is a later task's. When it lands, the name this hook sends
        // changes on `useDeck`'s single definition and this call site does not move.
        { cardId: payload.cardId, quantity: 1 },
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
