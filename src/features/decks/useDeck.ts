import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, type DeckCard, type DeckDetail, type DeckPatch, type DeckZone } from "@/lib/ipc";
import type { PaneDeckContext } from "@/lib/store";

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

  const detailKey = ["decks", "detail", id];

  const query = useQuery({
    queryKey: detailKey,
    queryFn: () => ipc.deckGet(opened(id)),
    enabled: id !== null,
  });

  /**
   * Rewrite one zone slot in the cached answer, or drop it — addressed by the slot rather
   * than by `deck_cards.id`, like every write here.
   *
   * A slot the cache does not hold is left alone rather than added: this patches what is on
   * screen, and inventing a row the read never answered is how an optimistic update starts
   * telling the reader about cards that are not in the deck.
   */
  const patchSlot = (slot: Slot, next: ((card: DeckCard) => DeckCard) | null) => {
    queryClient.setQueryData<DeckDetail | null>(detailKey, (data) => {
      if (!data) return data;
      const at = (c: DeckCard) => c.cardId === slot.cardId && c.zone === slot.zone;
      if (!data.cards.some(at)) return data;
      return {
        ...data,
        cards:
          next === null
            ? data.cards.filter((c) => !at(c))
            : data.cards.map((c) => (at(c) ? next(c) : c)),
      };
    });
  };

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
   * The deck itself: its name, its format, its cover, whether it is built.
   *
   * `useDecks.update`, narrowed to the deck that is open — it takes a patch and no id,
   * because an editor has exactly one deck and cannot be given the wrong one. Both write the
   * same command and both invalidate the same `["decks"]` root, so the gallery's tile and
   * this header can never disagree about a name; what this one buys is an editor that does
   * not have to mount the gallery's list query to rename the deck it is showing.
   *
   * `isBuilt` is the field with a consequence outside this deck: sending it reallocates in
   * the same transaction, and every *other* deck's `ownedQuantity` may move with it — which
   * the shared root already covers.
   */
  const update = useMutation({
    mutationFn: (patch: DeckPatch) => ipc.deckUpdate(opened(id), patch),
    onSuccess: invalidate,
  });

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
   *
   * **Optimistic on the slot's own number and nothing else** — the third copy of a fix this
   * codebase has now made three times (`CollectionPage`, `WishlistPage`, here), because the
   * stepper is controlled by the cache: hold `+` on a 4-of and every press before the first
   * answer reads 4 and sends 5, so three presses land on 5. Cancel first, or an in-flight
   * read of the old deck lands on top of the guess; roll back on a refusal, because zero
   * *removes* here and a refused removal that stayed removed would be a card silently gone.
   */
  const setQuantity = useMutation({
    mutationFn: ({ cardId, zone, quantity }: Slot & { quantity: number }) =>
      ipc.deckSetCardQuantity(opened(id), cardId, zone, quantity),
    onMutate: async ({ cardId, zone, quantity }) => {
      await queryClient.cancelQueries({ queryKey: detailKey });
      const saved = queryClient.getQueryData<DeckDetail | null>(detailKey);
      // Zero takes the row out at the press rather than at the answer: it is what the write
      // means, and a row sitting at `0` for a round trip is a state this table never has.
      patchSlot({ cardId, zone }, quantity === 0 ? null : (card) => ({ ...card, quantity }));
      return saved;
    },
    onError: (_error, _slot, saved) => {
      if (saved !== undefined) queryClient.setQueryData(detailKey, saved);
      invalidate();
    },
    onSuccess: (change, { cardId, zone }) => {
      // The answer, not the guess: the backend clamps and canonicalises, and this is the
      // number it actually stored.
      patchSlot(
        { cardId, zone },
        change.removed ? null : (card) => ({ ...card, quantity: change.quantity }),
      );
      invalidate();
    },
  });

  /** Move every copy from one zone to another. A claim released or made even though nothing
   *  was added or removed — `maybe` reserves nothing — so it invalidates like the rest. */
  const moveCard = useMutation({
    mutationFn: ({ cardId, from, to }: { cardId: string; from: DeckZone; to: DeckZone }) =>
      ipc.deckMoveCard(opened(id), cardId, from, to),
    onSuccess: invalidate,
  });

  /**
   * Swap a deck card to another printing of the same card — the card pane's "Use this
   * printing", pressed from outside this editor.
   *
   * **No optimistic patch**, where the stepper above has one, and it is the fold that decides
   * it: a zone holds a printing at most once, so a swap onto a printing the zone already has
   * turns two rows into one. Guessing that would mean deleting a line and growing another
   * before knowing whether the write went through — and the one number a reader would check
   * afterwards is precisely the one only the server can compute. So the guess is not worth the
   * beat it saves: the row keeps saying what the last read said until the next one lands.
   *
   * `["decks"]` like every zone write, for the same reason: `allocate_deck` runs inside the
   * swap's transaction, and the allocator takes the exact printing first — so the copies this
   * deck reserves can change even though its counts did not.
   *
   * **And `["decks"]` again when it is refused, which no other write here does.** The reason is
   * where this one is pressed: the control is on the card pane's printings rows, and the pane
   * is a *sibling* of the editor under `App`, so it mounts its own observer through
   * {@link useSwapFromPane}. TanStack shares a query's cache between observers and a mutation's
   * state with nobody — two `useMutation` calls on this definition are two error states — so
   * the editor's copy stays idle however the pane's ends, and the editor's refused-write family
   * (`DeckEditor`'s `lastOfAny`) cannot see the failure at all. Every refusal here is either a
   * busy database or a deck that has been deleted (`touch_deck` answers GONE), and the second
   * one must not leave the zone columns painting a deck that is not there. Invalidating on the
   * way out is that family's rule, moved onto the one definition every observer shares: the
   * refetch reaches the editor whoever pressed the button.
   */
  const swapPrinting = useMutation({
    mutationFn: ({
      fromCardId,
      toCardId,
      zone,
    }: {
      fromCardId: string;
      toCardId: string;
      zone: DeckZone;
    }) => ipc.deckSwapPrinting(opened(id), fromCardId, toCardId, zone),
    onSuccess: invalidate,
    onError: invalidate,
  });

  /**
   * Everything this deck is short of, onto the wishlist. Answers how many wishes were
   * touched.
   *
   * The one write here that reaches outside decks, so it is the one that takes `["wishlist"]`
   * with it — and it takes `["decks"]` too, because it reallocates before it counts.
   *
   * And the **search**, which draws what this just changed. `missing_to_wishlist` writes
   * through `add_wish` with an `oracleId` and no printing — "any printing", because a
   * shopping list is not a printing preference — and `CardSummary.wishlisted` is an `EXISTS`
   * that matches an unpinned wish against `c.oracle_id`. So one press turns the heart on for
   * *every* printing of every card the deck was short of, and a search left on screen behind
   * it is visibly wrong rather than stale in a field nothing draws. The same key the quick-add
   * and the wishlist's own writes take, for the same reason.
   */
  const missingToWishlist = useMutation({
    mutationFn: () => ipc.deckMissingToWishlist(opened(id)),
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
      void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
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
    update,
    addCard,
    setQuantity,
    moveCard,
    swapPrinting,
    missingToWishlist,
  };
}

/** The whole of what the editor consumes, named so the view and the hook agree. */
export type Deck = ReturnType<typeof useDeck>;

/**
 * The printing swap, for the surface that presses it: the card pane's printings rows.
 *
 * The pane is not inside the editor — it is docked beside whatever view is up — so it cannot
 * be handed the editor's `Deck`. What it has instead is the store's {@link PaneDeckContext},
 * which names the deck row the open card came from, and this turns that into the one write it
 * offers. `null` — a card opened from anywhere but a deck row — mounts an idle mutation and a
 * query that asks for nothing, exactly as the gallery's `useDeck(null)` does.
 *
 * **The whole hook, deliberately, rather than a mutation defined here.** The query it brings
 * along is the same `["decks", "detail", id]` the editor is already reading, and TanStack
 * shares a query's cache between observers — so with an editor open this costs no `deck_get`
 * at all (the app's `staleTime` is 30 s), and with the context set from a deck the reader is
 * looking at there is always an editor open. A second definition of the mutation would cost
 * more than the query does: the refusal rule that carries a pane-fired GONE back to the editor
 * lives on the definition, and two definitions are two places to keep it.
 */
export function useSwapFromPane(context: PaneDeckContext | null) {
  const deck = useDeck(context?.deckId ?? null);
  return {
    swap: deck.swapPrinting,
    /**
     * The read succeeded and answered nothing: another view has deleted this deck.
     *
     * `DeckEditor`'s `gone`, from the query the two of them share — which is the point of
     * mounting the whole hook. It lets the pane stop offering a write the deck can only refuse,
     * so the two surfaces agree *before* the press rather than after it. Loading is not gone.
     */
    deckGone:
      context !== null && !deck.query.isPending && !deck.query.isError && deck.query.data === null,
  };
}
