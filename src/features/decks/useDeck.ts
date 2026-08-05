import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, type DeckCard, type DeckZone } from "@/lib/ipc";

/** Stable identity for "no cards" — an unloaded deck and a deck that is gone both read this,
 *  and the editor's `useMemo`s key off it. */
const NONE: readonly DeckCard[] = [];

/** One zone slot, as every write here addresses it: by what it *is*, never by the
 *  `deck_cards.id` the answer carries. A stale row id is the difference between emptying the
 *  slot the reader pressed and emptying one somebody else already refilled. */
interface Slot {
  cardId: string;
  zone: DeckZone;
}

/**
 * The open deck's id, or a refusal.
 *
 * Every write below is reachable only from an editor, which is only mounted for a deck that
 * is open — so this throw is a fence rather than a path. It throws instead of silently doing
 * nothing because a mutation that resolves without writing is a stepper that looks like it
 * worked, and the rejection lands in the mutation's error state, which the editor already
 * renders.
 */
function opened(id: number | null): number {
  if (id === null) throw new Error("No deck is open.");
  return id;
}

/**
 * One deck, everything in it, and every write that changes what is in it.
 *
 * **One query, not three.** The editor, the mana curve and the legality panel all read
 * `deck_get`, because they are asking the same question — *what is in this deck* — and a
 * screen that drew a curve from one query, a legality panel from another and an owned badge
 * from a third is a screen whose three answers can disagree.
 *
 * `id` is nullable because the gallery is the same view: Decks mounts this hook whether or
 * not a deck is open, and a query that fired anyway would ask the backend for deck `null`
 * on every gallery render.
 */
export function useDeck(id: number | null) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["decks", "detail", id],
    queryFn: () => ipc.deckGet(opened(id)),
    enabled: id !== null,
  });

  /**
   * Every zone write reallocates — `allocate_deck` runs inside the same transaction — so the
   * whole `["decks"]` root, not this one detail: every `ownedQuantity` in the deck may have
   * moved, and the gallery tile's `cardCount` and `updatedAt` with them.
   *
   * The wishlist is **not** invalidated here, and that is a decision rather than an
   * omission: a zone write moves `deck_allocations` and nothing else, while a wish's
   * `ownedQuantity` is summed from `collection_entries`. Only `missingToWishlist` — the one
   * command that actually writes wishes — takes `["wishlist"]` with it.
   */
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["decks"] });

  /**
   * Put copies into a zone: the drag-in and the click-to-add write.
   *
   * **Not the stepper's** — see {@link useDeck}'s `setQuantity`. This one reads `cards` to
   * denormalize the printing onto the row it inserts, so it refuses a card the database does
   * not have.
   */
  const addCard = useMutation({
    mutationFn: ({ cardId, zone, quantity }: Slot & { quantity: number }) =>
      ipc.deckAddCard(opened(id), cardId, zone, quantity),
    onSuccess: invalidate,
  });

  /**
   * An absolute quantity — **the stepper's write, and the one a stepper must use**.
   *
   * `deckAddCard` sums and this one replaces, which is the obvious difference and not the
   * load-bearing one. The load-bearing one is that `add_card` looks the printing up in
   * `cards` first and therefore *refuses an orphaned row*, while this one addresses the slot
   * that is already there and asks `cards` nothing. The one deck card whose printing has
   * left the database is exactly the one a reader needs to be able to step down and out — so
   * a stepper built on `+1`/`−1` deltas through `deckAddCard` would be broken on precisely
   * the rows that most need fixing.
   *
   * `0` removes the row (the wishlist's asymmetry, for the wishlist's reason: a zone slot
   * holds an intention and nothing else). A negative number is refused by the backend rather
   * than clamped, which matters more here rather than less — in a module where zero deletes,
   * treating `-1` as close enough would let arithmetic that went wrong upstream destroy a row.
   */
  const setQuantity = useMutation({
    mutationFn: ({ cardId, zone, quantity }: Slot & { quantity: number }) =>
      ipc.deckSetCardQuantity(opened(id), cardId, zone, quantity),
    onSuccess: invalidate,
  });

  /** Move every copy from one zone to another. A claim released or made even though nothing
   *  was added or removed — `maybe` reserves nothing — so it invalidates like the rest. */
  const moveCard = useMutation({
    mutationFn: ({ cardId, from, to }: { cardId: string; from: DeckZone; to: DeckZone }) =>
      ipc.deckMoveCard(opened(id), cardId, from, to),
    onSuccess: invalidate,
  });

  /**
   * Everything this deck is short of, onto the wishlist. Answers how many wishes were
   * touched.
   *
   * The one write here that reaches outside decks, so it is the one that takes `["wishlist"]`
   * with it — and it takes `["decks"]` too, because it reallocates before it counts.
   */
  const missingToWishlist = useMutation({
    mutationFn: () => ipc.deckMissingToWishlist(opened(id)),
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
    },
  });

  return {
    query,
    /** The gallery's row for this deck, or `null` — both while it is loading and when the id
     *  names a deck another view has since deleted. */
    deck: query.data?.deck ?? null,
    /** Every card, in zone-priority order (`commander`, `main`, `side`, `companion`,
     *  `maybe`), then by the name the row carries, then by row id. */
    cards: query.data?.cards ?? NONE,
    addCard,
    setQuantity,
    moveCard,
    missingToWishlist,
  };
}

/** The whole of what the editor consumes, named so the view and the hook agree. */
export type Deck = ReturnType<typeof useDeck>;
