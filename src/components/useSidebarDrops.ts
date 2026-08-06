import { useCallback, useEffect, useState } from "react";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { useMutation } from "@tanstack/react-query";
import { readDragData, type DragPayload } from "@/features/decks/dnd";
import { deckDetailKey } from "@/features/decks/useDeck";
import { ipc, ipcError, type DeckDetail } from "@/lib/ipc";
import { queryClient } from "@/lib/query";
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
export const NO_OPEN_DECK = "Open a deck to drop cards into it";

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
 * The mutations are defined here rather than reached for from `useDeck`, and the module's own
 * `queryClient` is passed to both rather than taken from a provider. Two reasons, and they are
 * the shell's, not this hook's: `AppShell` renders in its own tests with no provider around it
 * (`useSyncInvalidation` made the same call for the same reason), and a mutation observer here
 * is a mutation observer the deck editor cannot see — TanStack shares a query's cache between
 * observers and a mutation's state with nobody. That second one is why the deck write
 * invalidates `["decks"]` **on its refusal too**: a press against a deck another view has
 * deleted answers `GONE`, and the editor's own refused-write family (`DeckEditor`'s `lastOfAny`)
 * would never hear about it. `useDeck`'s `swapPrinting` carries the same rule for the same
 * reason, from the card pane.
 */
export function useSidebarDrops() {
  const openDeckId = useAppStore((s) => s.openDeckId);
  /** A card is in the air somewhere in the window — what raises the ring. */
  const [dragging, setDragging] = useState(false);
  /** The one sentence the sidebar is saying, and which entry is saying it. One at a time,
   *  because one drop happens at a time. */
  const [report, setReport] = useState<{ at: SidebarTargetId; text: string } | null>(null);

  const addToDeck = useMutation(
    {
      // `main`, and one copy: the docked panel's Add button's write. A sidebar entry is a
      // destination rather than a form, and the deck's own columns are where a reader who
      // means the sideboard drops a card.
      mutationFn: ({ deckId, cardId }: { deckId: number; cardId: string; deckName: string }) =>
        ipc.deckAddCard(deckId, cardId, "main", 1),
      onSuccess: (_change, { deckName }) => {
        // `allocate_deck` runs inside the add's transaction, so every `ownedQuantity` in the
        // open deck may have moved — the whole root, exactly as the editor's writes take.
        void queryClient.invalidateQueries({ queryKey: ["decks"] });
        setReport({ at: "decks", text: `Added to ${deckName}.` });
      },
      onError: (error) => {
        void queryClient.invalidateQueries({ queryKey: ["decks"] });
        setReport({ at: "decks", text: ipcError(error) });
      },
    },
    queryClient,
  );

  const addWish = useMutation(
    {
      // The printing that was dragged, pinned — the reader was looking at *this* one — and no
      // finish, which is the wishlist's own default and the only honest answer a drop has.
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
    },
    queryClient,
  );

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

  const writeToDeck = addToDeck.mutate;
  const dropOnDecks = useCallback(
    (payload: DragPayload) => {
      // Unreachable: the entry refuses the drop with no deck open. A fence rather than a path,
      // and the alternative is `deck_add_card` addressed to deck `null`.
      if (openDeckId === null) return;
      writeToDeck({
        deckId: openDeckId,
        cardId: payload.cardId,
        // Read out of the editor's own cached deck, at the moment it is needed rather than
        // watched: a deck can only be open with its editor mounted, so the read that filled
        // this has already happened. The fallback is the sliver where it has not — the drop
        // still writes, and the sentence says what it can.
        deckName:
          queryClient.getQueryData<DeckDetail | null>(deckDetailKey(openDeckId))?.deck.name ??
          "the open deck",
      });
    },
    [openDeckId, writeToDeck],
  );

  const writeWish = addWish.mutate;
  const dropOnWishlist = useCallback(
    (payload: DragPayload) => writeWish(payload.cardId),
    [writeWish],
  );

  return {
    /** True while a card this app dragged is in the air — what puts the ring up. */
    dragging,
    decks: {
      eligible: openDeckId !== null,
      inertReason: NO_OPEN_DECK,
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
