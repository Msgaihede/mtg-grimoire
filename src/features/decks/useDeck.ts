import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ipc,
  type DeckCard,
  type DeckCategory,
  type DeckDetail,
  type DeckFinish,
  type DeckPatch,
  type DeckTag,
  type DeckVariant,
  type DeckViewState,
} from "@/lib/ipc";
import { useAppStore, type PaneDeckContext } from "@/lib/store";
import { useDeckWriteRoots } from "@/lib/useDeckDrivenCollection";
import { useMarketplace } from "@/lib/useMarketplace";
import { autoCategoryFor } from "./autoCategory";

/**
 * What a re-file did — the quick zones' `Auto` for a card already in the deck.
 *
 * `moved: false` is an **answer**, not a failure: the rule either could not place the card
 * (`UNCATEGORIZED`) or named the pile it is already in. `category` is the word the rule
 * produced in every case, so a caller can say which it was; `categoryId` is `null` unless
 * something actually moved, because it exists to be handed the caret.
 */
export interface RefileResult {
  moved: boolean;
  category: string;
  categoryId: number | null;
}

/** Stable identity for "no cards" — an unloaded deck and a deck that is gone both read this,
 *  and the editor's `useMemo`s key off it. */
const NONE: readonly DeckCard[] = [];

/** The same, for the two lists a deck read now also answers with. */
const NO_CATEGORIES: readonly DeckCategory[] = [];
const NO_TAGS: readonly DeckTag[] = [];

/**
 * The variant every surface that has no opinion reads.
 *
 * Schema v8 gave every deck two lists — `live`, what is sleeved up, and `theory`, what it is
 * being built toward — and this is the one the app meant by "the deck" before the column
 * existed. It is a **default argument** rather than a constant now: a caller with a Live/Theory
 * control passes what the reader chose, and a caller that has none (the sidebar's drop target,
 * the card pane) gets the deck as it stands.
 *
 * Exported so every deck hook in this folder defaults to the same word from the same place.
 */
export const DEFAULT_VARIANT: DeckVariant = "live";

/**
 * What an add is filed under when the caller names no category.
 *
 * `deck_add_card` takes either an explicit `categoryId` — a drop onto a column the reader
 * pointed at — or a **name** to find-or-create. The surfaces that have no column to point at
 * (the docked panel's Add button, the sidebar's Decks drop target) send a name, and this is
 * that name: the v8 migration's own word for the pile it put every legacy main-deck row in, so
 * a deck that predates categories and one made since agree about where a plain add goes.
 *
 * **A fence now rather than the usual answer.** `autoCategoryFor` files an add that names no
 * category (see {@link useDeck}'s `addCard`), and every surface in the app hands this hook a
 * type line to file by — so this word is what is left for a caller that has neither a category
 * nor a type line, which is a shape the app does not currently produce. It is kept because the
 * alternative is filing such a card under `UNCATEGORIZED`, and "the caller told us nothing" and
 * "the card's type line is unrecognised" are different states that should not land in one pile.
 *
 * Exported for two readers: `useDeckMeta` has to know which piles are *nobody's choice* before
 * it is allowed to empty them, and a second copy of this string there would be a second place
 * to keep one word.
 */
export const DEFAULT_CATEGORY_NAME = "Main deck";

/** One category slot, as every write here addresses it: by what it *is*, never by the
 *  `deck_cards.id` the answer carries. A stale row id is the difference between emptying the
 *  slot the reader pressed and emptying one somebody else already refilled.
 *
 *  The **variant** is the third part of the slot and is not a field here: it is the hook's, and
 *  it is in the query key — see {@link useDeck}. */
interface Slot {
  cardId: string;
  categoryId: number;
  /**
   * Which object the row plays — the fifth part of the grain, since schema v18.
   *
   * **Required rather than optional, deliberately.** A pile can hold the regular copy and the
   * foil as two rows, and a caller that had not thought about which one it means would address
   * the regular one by default and step the wrong card. Optional would have compiled at every
   * existing call site and been wrong at half of them.
   */
  finish: DeckFinish;
}

/**
 * Move the card pane's context onto the finish a row has just been set to.
 *
 * **A deck row is addressed by `(deck, category, card, variant, finish)`**, and `set_card_finish`
 * changes the fifth part — so a context left pointing at the finish that was *left* names a row
 * that no longer exists. Three things break at once when it does, and all three were reported as
 * one on 2026-08-18: the editor's `selectedSlot` matches nothing, so the picked card is silently
 * unpicked while the pane stays open beside it; `CardDetailPane`'s `deckControlFor` finds no
 * control to hand the caret back to on close; and the pane's own foil button sends
 * `null → null` on its next press, which the backend refuses as `SAME_FINISH` — a toggle that
 * could be pressed once and never pressed back.
 *
 * `swapPrinting` met exactly this one axis over and answered it the same way, with
 * `openCardFromDeck({ ...deckRow, cardId })` — the store action is both "which card is open" and
 * "which row it came from" in one write. This is that, for the finish.
 *
 * **It lives on the mutation rather than at a call site**, which is the one design decision
 * here: two surfaces press this write — the deck card menu's `Set as foil` and the pane's own
 * button — and a rule about what a write does to the address it wrote is not something two
 * callers should have to remember separately. `swapPrinting`'s re-anchor is at its call site
 * because the pane is its only presser and it carries a `handover` only the pane can build.
 *
 * **Only the row that was written**, hence the whole address is compared: a reader can have the
 * pane open on one row and right-click another, and a card open from a different deck, a
 * different pile or the other variant must not be dragged along. Nothing to move is the common
 * case — most finish writes happen with no pane open at all.
 *
 * The **fold** needs no arm of its own: setting a row to a finish the pile already holds turns
 * two rows into one, and the surviving row is the one at `to`. That is where the context lands
 * either way.
 */
function reanchorPane(
  /** The row the write named — `useDeck`'s own `id` and `variant`, and the mutation's {@link Slot}.
   *  A `null` id is a hook nothing can write through, and equals no context's `deckId`. */
  wrote: Slot & { deckId: number | null; variant: DeckVariant },
  to: DeckFinish,
) {
  const { paneDeckContext: pane, openCardFromDeck } = useAppStore.getState();
  if (
    pane === null ||
    pane.deckId !== wrote.deckId ||
    pane.variant !== wrote.variant ||
    pane.categoryId !== wrote.categoryId ||
    pane.cardId !== wrote.cardId ||
    pane.finish !== wrote.finish
  ) {
    return;
  }
  openCardFromDeck({ ...pane, finish: to });
}

/**
 * The open deck's id, or a refusal.
 *
 * Every write below is reachable only from an editor, which is only mounted for a deck that
 * is open — so this throw is a fence rather than a path. It throws instead of silently doing
 * nothing because a mutation that resolves without writing is a stepper that looks like it
 * worked, and the rejection lands in the mutation's error state, which the editor already
 * renders.
 *
 * Exported because every deck hook in this folder takes a nullable id for the same reason —
 * the view mounts whether or not a deck is open — and one fence is one sentence to keep.
 */
export function opened(id: number | null): number {
  if (id === null) throw new Error("No deck is open.");
  return id;
}

/**
 * What one printing *does*, for the rule that files it — or nothing at all.
 *
 * `oracle_tags_for_printings` over a single id, which is the shape every add here has: the
 * reader pressed Add or dropped one card. The list command exists for the importer, which asks
 * about a hundred lines at once.
 *
 * **Matched back by `cardId`, never by position.** The command drops blank and duplicate ids,
 * so its answer can be shorter than the request — `answers[0]` is right for one id and wrong
 * the first time anything here asks about two.
 *
 * **A tag read that fails is not an add that fails, and this `catch` is load-bearing rather
 * than defensive.** An empty slug list is `autoCategoryFor`'s supported floor — it is what the
 * whole app does before the taxonomy has ever been downloaded — so a database that is busy, a
 * command that is missing or a rejection nobody predicted costs the reader a *worse pile* and
 * never the card. **Do not turn this into a rethrow.** Filing Swords to Plowshares under
 * Instant is a category the reader can drag; a refused add is a card they have to notice is
 * absent.
 */
async function oracleTagsFor(cardId: string): Promise<readonly string[]> {
  try {
    const answers = await ipc.oracleTagsForPrintings([cardId]);
    return answers.find((entry) => entry.cardId === cardId)?.slugs ?? [];
  } catch {
    return [];
  }
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
 *
 * **Switching variant is a query-key change, not a refetch.** `["decks", "detail", id,
 * variant, marketplace]`, so Live and Theory are two cached answers rather than one that is
 * thrown away and re-read every time the reader flips the switch — flipping back is instant,
 * and each list keeps its own freshness. It also means the optimistic patch below is
 * addressing the right list by construction: the cache it writes into holds one variant's
 * cards and no other.
 *
 * **The marketplace is in the key for a different reason, and it is not free.** `deck_get`
 * prices every row and every category heading with it, so two marketplaces are two answers —
 * switching re-reads the deck. That is the trade the singular-price shape makes deliberately:
 * one number per row rather than one per marketplace per row. The read is local SQLite over a
 * deck-sized list, and flipping back finds the previous answer still cached.
 */
export function useDeck(id: number | null, variant: DeckVariant = DEFAULT_VARIANT) {
  const queryClient = useQueryClient();
  // Read here rather than passed in: every caller of this hook would otherwise have to thread
  // it through, and one that forgot would silently read a deck priced at the default while the
  // heading beside it named something else.
  const { marketplace } = useMarketplace();

  const detailKey = ["decks", "detail", id, variant, marketplace.id];

  const query = useQuery({
    queryKey: detailKey,
    queryFn: () => ipc.deckGet(opened(id), variant, marketplace.id),
    enabled: id !== null,
  });

  /**
   * Rewrite one category slot in the cached answer, or drop it — addressed by the slot rather
   * than by `deck_cards.id`, like every write here.
   *
   * The slot is `(cardId, categoryId, variant, finish)`, which is `DECK_CARD_GRAIN` minus the
   * deck the hook already is. The variant clause is belt and braces — the key scopes this cache
   * to one list already — and it is written out because the grain is five things and a reader
   * checking this against the schema should find all five.
   *
   * **The finish clause is not belt and braces**, and it is the one to get right: without it a
   * stepper on the foil row patches the regular row too, so the reader watches both change and
   * one of them snap back when the read lands.
   *
   * A slot the cache does not hold is left alone rather than added: this patches what is on
   * screen, and inventing a row the read never answered is how an optimistic update starts
   * telling the reader about cards that are not in the deck.
   */
  const patchSlot = (slot: Slot, next: ((card: DeckCard) => DeckCard) | null) => {
    queryClient.setQueryData<DeckDetail | null>(detailKey, (data) => {
      if (!data) return data;
      const at = (c: DeckCard) =>
        c.cardId === slot.cardId &&
        c.categoryId === slot.categoryId &&
        c.variant === variant &&
        c.finish === slot.finish;
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
   * Every card write reallocates — `allocate_deck` runs inside the same transaction — so the
   * whole `["decks"]` root, not this one detail: every `ownedQuantity` in the deck may have
   * moved, and the gallery tile's `cardCount` and `updatedAt` with them.
   *
   * **And, while the collection is derived, everything else the reader owns** —
   * {@link useDeckWriteRoots} is the list and the gate. A `variant: 'live'` row *is* a
   * collection row in that mode, so adding two copies here adds two copies to the collection
   * page, to the search wall's owned counts and to the have/want on the wishlist. Nothing
   * mounts those queries afresh on a navigation (`src/lib/query.ts` sets `staleTime: 30_000`,
   * so a cached answer is *fresh* and mounting it does not refetch), which makes invalidation
   * the only thing that tells them. The worst case is the deck editor's own docked search
   * panel: its `OwnedBadge` is drawn from `["cards", "search"]` a few hundred pixels from the
   * card being added, and a mounted query with nothing to invalidate it has no refetch trigger
   * at all — the two would disagree about one card indefinitely.
   *
   * **In the hand-kept mode the list is `["decks"]` alone, which is what it always was.** The
   * gate is additive: a card write there moves `deck_allocations` and nothing else, and a wish's
   * `ownedQuantity` is summed from `collection_entries` — true in that mode and, since the
   * setting shipped, *only* in that mode, which is why the wishlist is now in the derived list.
   * `missingToWishlist` still takes `["wishlist"]` in both, because it is the one command here
   * that actually writes wishes.
   */
  const writeRoots = useDeckWriteRoots();
  const invalidate = () => {
    for (const queryKey of writeRoots) void queryClient.invalidateQueries({ queryKey });
  };

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
   * Remember how the reader is looking at this deck — the tab, the `Group by`, the `Sort` —
   * so that closing it and opening it again puts them back where they were.
   *
   * **The one write here that does not invalidate, and that is the interesting part.** The
   * editor is already showing what the reader picked: this write does not produce the state on
   * screen, it only makes it survive the deck being closed, so there is nothing to re-read and
   * nothing waiting on the answer. Invalidating would refetch the deck row and hand the editor
   * back a `lastVariant`/`lastGroupBy`/`lastSortBy` — the three fields the editor *restores
   * from* — a beat after the press, which is how a second press made in that beat gets undone
   * by the first one's echo. Not invalidating is also what stops the round trip from looping at
   * all: the row's triple changes only when the deck is genuinely re-read, and re-applying the
   * reader's own stored choice is a no-op.
   *
   * **Its failure is silent by design.** Nothing the reader asked for has failed — the tab they
   * pressed is the tab they are on — and the cost of a lost write is a deck that reopens on its
   * old tab. A banner for that would be an app apologising for its own bookkeeping, so this
   * mutation is deliberately not in `DeckEditor`'s refused-write family either: that list is
   * **writes to what is in the deck**, and this one changes no card.
   */
  const rememberView = useMutation({
    mutationFn: (viewState: DeckViewState) => ipc.deckSetViewState(opened(id), viewState),
  });

  /**
   * Put copies into a category: the drag-in and the click-to-add write.
   *
   * **Not the stepper's** — see {@link useDeck}'s `setQuantity`. This one reads `cards` to
   * denormalize the printing onto the row it inserts, so it refuses a card the database does
   * not have.
   *
   * **`categoryId` is what a drop onto a column sends; a caller with none is filed by what the
   * card does, and by what it is where that is unknown.** Pointing at a column *is* naming a
   * category, so every drag overrides the rule by construction and nothing here has to know a
   * gesture from a press. A caller with no column — the panel's Add button under `Auto`, the
   * toolbar quick add, the sidebar's Decks entry — passes `typeLine` instead, and
   * `autoCategoryFor` names the pile for `deck_add_card` to find or create.
   *
   * **The rule is applied here, on this one definition, and the card's Oracle tags are read
   * here too.** `autoCategoryFor` stays a single rule in TypeScript (CLAUDE.md's boundary —
   * Rust supplies facts, TS draws conclusions) and a call site that computed the *name* would
   * be a second place to keep it. What changed when the tags arrived is where the facts come
   * from: the type line still travels in the payload, and the slugs cannot.
   *
   * **Why they cannot travel.** The four drag sources build their payload out of the list row
   * under the cursor — `{ kind: "card", cardId, name, typeLine }` — and no list DTO in this app
   * carries a slug list: `CardSummary`, `CollectionRow` and `WishRow` say what a card *is*,
   * never what it does. Putting the tags on them would mean expanding the taxonomy for every
   * row of a wall of search results to serve the one row somebody eventually drags.
   *
   * So this pays **one extra round trip to local SQLite**, on a deliberate act by the reader —
   * a press or a drop, one card, {@link oracleTagsFor} over a single id — and only in the arm
   * that has no category *and* has a type line. The comment that stood here promised no add
   * would pay one; that promise is spent, knowingly, and what it buys is a decklist filed by
   * function rather than by card type. Neither of the other two arms asks anything: a drop onto
   * a column has already been told where the card goes, and a caller that named neither is not
   * asking to have it filed at all.
   *
   * **A tag read that fails never fails the add** — see {@link oracleTagsFor}. The card lands in
   * its type-line pile, which is where every card landed before the taxonomy existed.
   *
   * So: the card id and the type line come in, the name goes out, and `null` — an orphan, or a
   * layout with no bucket word — answers `UNCATEGORIZED` whatever the tags said.
   *
   * With neither, {@link DEFAULT_CATEGORY_NAME}. No surface in the app sends neither today.
   *
   * **`["decks"]` again when it is refused**, which it shares with `swapPrinting` below and for
   * that rule's reason: this definition has a second call site outside the editor. The sidebar's
   * Decks entry is a drop target from any view (`useSidebarDrops`), and TanStack shares a
   * query's cache between observers and a mutation's state with nobody — so a press made there
   * lands in *that* observer's error state and the editor's refused-write family
   * (`DeckEditor`'s `lastOfAny`) stays idle. Every refusal here is either a busy database or a
   * deck that has been deleted (`touch_deck` answers GONE), and the second must not leave the
   * zone columns painting a deck that is not there. The refetch reaches the editor whoever
   * pressed, because `["decks"]` is a prefix of the detail key it is reading.
   *
   * It costs the editor's *own* refused adds a second, forced re-read — `lastOfAny` fires one
   * too. Task 4 accepted exactly that for `swapPrinting`: a refusal is rare, and a dead deck
   * left painted is not a cost that trades against it.
   */
  const addCard = useMutation({
    mutationFn: async ({
      cardId,
      categoryId = null,
      typeLine,
      finish = null,
      quantity,
    }: {
      cardId: string;
      categoryId?: number | null;
      /**
       * Which object to add — the regular copy unless a caller says otherwise.
       *
       * **Optional here and required on {@link Slot}, and the asymmetry is the honest one.** An
       * add coming off a search wall, a drag or the quick-add field is a card being put into a
       * deck, and the regular copy is what that means until the reader says which one they have;
       * `deckSetCardFinish` is where the finish is the subject. A *write to an existing row*
       * has no such default — the row is already one or the other, and guessing would step the
       * wrong one.
       */
      finish?: DeckFinish;
      /** The card's own `type_line`, for the caller that named no category — the **fallback**
       *  half of the rule now that the tags are read here rather than passed in. `null` is a
       *  card whose printing has left `cards`; **absent** is a caller with nothing to say, which
       *  is not the same thing and is the one arm that consults nothing — see
       *  {@link DEFAULT_CATEGORY_NAME}. */
      typeLine?: string | null;
      quantity: number;
    }) => {
      // Before anything is asked about the card: a write with no deck open is refused here and
      // not one round trip later.
      const deckId = opened(id);
      // The `await` sits inside the one arm that needs it, so the other two cost exactly what
      // they always did — a named category and a caller with nothing to say each make one IPC
      // call in total. A land still pays the read: the Land pin lives inside `autoCategoryFor`,
      // and short-circuiting it here would be a second copy of that rule.
      const categoryName =
        categoryId !== null
          ? null
          : typeLine === undefined
            ? DEFAULT_CATEGORY_NAME
            : autoCategoryFor({ typeLine, oracleTags: await oracleTagsFor(cardId) });
      return ipc.deckAddCard(deckId, cardId, categoryId, categoryName, variant, finish, quantity);
    },
    onSuccess: invalidate,
    onError: invalidate,
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
   * `0` removes the row (the wishlist's asymmetry, for the wishlist's reason: a category slot
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
    mutationFn: ({ cardId, categoryId, finish, quantity }: Slot & { quantity: number }) =>
      ipc.deckSetCardQuantity(opened(id), cardId, categoryId, variant, finish, quantity),
    onMutate: async ({ cardId, categoryId, finish, quantity }) => {
      await queryClient.cancelQueries({ queryKey: detailKey });
      const saved = queryClient.getQueryData<DeckDetail | null>(detailKey);
      // Zero takes the row out at the press rather than at the answer: it is what the write
      // means, and a row sitting at `0` for a round trip is a state this table never has.
      patchSlot(
        { cardId, categoryId, finish },
        quantity === 0 ? null : (card) => ({ ...card, quantity }),
      );
      return saved;
    },
    onError: (_error, _slot, saved) => {
      if (saved !== undefined) queryClient.setQueryData(detailKey, saved);
      invalidate();
    },
    onSuccess: (change, { cardId, categoryId, finish }) => {
      // The answer, not the guess: the backend clamps and canonicalises, and this is the
      // number it actually stored.
      patchSlot(
        { cardId, categoryId, finish },
        change.removed ? null : (card) => ({ ...card, quantity: change.quantity }),
      );
      invalidate();
    },
  });

  /**
   * Empty one category of this variant — a pile's right-click **Clear stack**.
   *
   * **One command, not a `setQuantity(…, 0)` per row**, and the reason is the one that made
   * `deck_import_commit` a command: the rows are all in hand here, so the loop would compile —
   * and it would be one transaction, one allocator run and one `["decks"]` invalidation *per
   * card*, with the deck re-read forty times while the reader watches. It would also be forty
   * history rows for one press, and any one of them could be refused halfway leaving the pile
   * half-empty with no way to say so.
   *
   * **No optimistic patch**, unlike the stepper beside it. The stepper is optimistic because it
   * is *held down* — a controlled control read back from the cache mid-press sends the same
   * number twice — and nothing here repeats: this is one press behind a confirmation, and the
   * beat it would save is a beat the reader spends reading the dialog closing. Guessing would
   * also mean deleting a whole column from the cache before knowing the write landed, which is
   * exactly the shape the stepper's rollback comment calls a card silently gone.
   *
   * Answers the copies removed, which is what the confirmation counted.
   */
  const clearCategory = useMutation({
    mutationFn: (categoryId: number) => ipc.deckCategoryClear(opened(id), categoryId, variant),
    onSuccess: invalidate,
  });

  /** Move every copy from one category to another. A claim released or made even though
   *  nothing was added or removed — an inactive category reserves nothing — so it invalidates
   *  like the rest. */
  const moveCard = useMutation({
    mutationFn: ({
      cardId,
      from,
      to,
      finish,
    }: {
      cardId: string;
      from: number;
      to: number;
      /** Addresses the row and is carried across, never written: moving the foil copy to
       *  another pile leaves it the foil copy. */
      finish: DeckFinish;
    }) => ipc.deckMoveCard(opened(id), cardId, from, to, null, variant, finish),
    onSuccess: invalidate,
  });

  /**
   * Change **which object** a row plays — the deck card menu's `Set as foil` and the card
   * pane's own button.
   *
   * **No optimistic patch, deliberately**, and for a sharper reason than `clearCategory`'s: the
   * write **folds**. Setting a row to a finish the pile already holds turns two rows into one
   * with a quantity this side has not computed, so a guess would be right only when the pile
   * held no row of the target finish — which is the common case, which is what would make the
   * other one a bug nobody reproduces.
   */
  const setCardFinish = useMutation({
    mutationFn: ({ cardId, categoryId, finish, to }: Slot & { to: DeckFinish }) =>
      ipc.deckSetCardFinish(opened(id), cardId, categoryId, variant, finish, to),
    onSuccess: (_result, { cardId, categoryId, finish, to }) => {
      reanchorPane({ deckId: id, variant, cardId, categoryId, finish }, to);
      invalidate();
    },
  });

  /**
   * Re-file a card the deck already holds by what it *does* — the quick zones' `Auto` for a card
   * dragged off the desk.
   *
   * **`addCard`'s auto arm read backwards, and deliberately the same three steps in the same
   * order**: the card's Oracle tags, then `autoCategoryFor`, then a command that finds-or-creates
   * the pile that names. One rule, applied at two entrances — a card filed on the way *in* and
   * the same card filed again later must not disagree about where it belongs, and two spellings
   * of the rule is how they would.
   *
   * **The pile is resolved in Rust, in the move's own transaction**, rather than by a
   * `deckCategoryList` + `deckCategoryCreate` pair out here. Three things follow from that and
   * each is why: a pile the app invents comes out `origin: 'auto'`, so `drawsWhenEmpty` takes it
   * off the desk once its last card leaves — `deckCategoryCreate` writes `'user'` and would leave
   * a column nobody asked for standing for ever; the create and the move are one transaction, so
   * a refused move cannot strand an empty pile; and it is one round trip rather than three.
   *
   * **One outcome writes nothing, and it is an answer rather than a failure**: a card already in
   * the pile the rule names is already filed. It does not reach IPC at all — the comparison is
   * against the row's own `categoryName`, which the caller is holding — so the common "press it
   * again" costs a tag read and nothing else.
   *
   * **There were two until 2026-08-16.** A card the rule could not place (`UNCATEGORIZED` —
   * an orphan, or a layout with no bucket word) used to stay put as well; it is filed into that
   * pile now, like any other answer. See the site.
   *
   * `categoryId` is `null` on both of those, and it is what the caller hands the caret to: there
   * is nowhere to send it when nothing moved.
   */
  const refileCard = useMutation({
    mutationFn: async ({
      cardId,
      from,
      typeLine,
      categoryName,
      finish,
    }: {
      cardId: string;
      /** The pile the card is in now — the slot the move leaves. */
      from: number;
      /** Which of the pile's two rows of this printing is being re-filed. Carried across by the
       *  move, never written: filing a card by what it does says nothing about what it is. */
      finish: DeckFinish;
      /** The row's own type line. `null` is a real value and files the card under
       *  `UNCATEGORIZED`, which is a destination like any other. */
      typeLine: string | null;
      /** What the card's current pile is called, so "already filed" is answered without a round
       *  trip. The row carries it denormalized for exactly this kind of reason. */
      categoryName: string;
    }): Promise<RefileResult> => {
      // The one read, and it cannot fail the re-file: `oracleTagsFor` catches and answers `[]`,
      // which is `autoCategoryFor`'s supported floor and files by type line instead.
      const target = autoCategoryFor({ typeLine, oracleTags: await oracleTagsFor(cardId) });
      // **No arm for `UNCATEGORIZED`**, and its absence is the 2026-08-16 change. It used
      // to return here unmoved, on the argument that moving a card out of a pile somebody chose
      // into the bin is a downgrade dressed as tidying. That reasoning was about the *bulk*
      // press, where it still holds and still runs (`useDeckMeta.autoCategorise`); here the
      // reader has picked up one card and pointed at `Auto`, and answering "no" to a question
      // they asked deliberately is the worse half of the trade. `Uncategorized` is a pile like
      // any other — `origin: 'auto'`, gone with its last card — so the card lands somewhere it
      // can be seen and dragged out of, rather than staying put with a sentence.
      if (target === categoryName) return { moved: false, category: target, categoryId: null };
      const categoryId = await ipc.deckMoveCard(
        opened(id),
        cardId,
        from,
        null,
        target,
        variant,
        finish,
      );
      return { moved: true, category: target, categoryId };
    },
    // **Only when something moved.** The two no-op answers touched no row, so re-reading the
    // deck for them would be a round trip and a re-render for a press that changed nothing —
    // and "press it again" is the common case this path is built for.
    onSuccess: (result) => {
      if (result.moved) invalidate();
    },
  });

  /**
   * Swap a deck card to another printing of the same card — the card pane's "Use this
   * printing", pressed from outside this editor.
   *
   * **No optimistic patch**, where the stepper above has one, and it is the fold that decides
   * it: a category holds a printing at most once per variant, so a swap onto a printing it
   * already has turns two rows into one. Guessing that would mean deleting a line and growing
   * another before knowing whether the write went through — and the one number a reader would
   * check afterwards is precisely the one only the server can compute. So the guess is not
   * worth the beat it saves: the row keeps saying what the last read said until the next one
   * lands.
   *
   * `["decks"]` like every card write, for the same reason: `allocate_deck` runs inside the
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
   * one must not leave the category columns painting a deck that is not there. Invalidating on
   * the way out is that family's rule, moved onto the one definition every observer shares:
   * the refetch reaches the editor whoever pressed the button.
   */
  const swapPrinting = useMutation({
    mutationFn: ({
      fromCardId,
      toCardId,
      categoryId,
      finish,
    }: {
      fromCardId: string;
      toCardId: string;
      categoryId: number;
      /** Addresses the row and travels with it: the foil copy of the old printing becomes the
       *  foil copy of the new one. The reader is choosing a printing, not an object. */
      finish: DeckFinish;
    }) => ipc.deckSwapPrinting(opened(id), fromCardId, toCardId, categoryId, variant, finish),
    onSuccess: invalidate,
    onError: invalidate,
  });

  /**
   * Everything this deck is short of, onto the wishlist. Answers how many wishes were
   * touched.
   *
   * The one write here that reaches outside decks **in either mode**, so it is the one that
   * takes `["wishlist"]` with it unconditionally — and it takes `["decks"]` too, because it
   * reallocates before it counts. While the collection is derived every write in this file
   * reaches outside decks and {@link useDeckWriteRoots} already carries the wishlist; the two
   * extra keys here are what the hand-kept mode is owed, and firing one twice is a no-op
   * against a single invalidation pass.
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

  /**
   * Put the deck's one tag on a card, or take it off with `tagId: null`.
   *
   * A **card** write, addressed by the same slot as the stepper and the move — which is why it
   * lives here rather than in `useDeckMeta` beside the tag CRUD. The label is per-deck data; a
   * card *wearing* one is a fact about a row of `deck_cards`, and a stale editor pointing at a
   * row that has since moved, folded or been stepped to zero is answered in words.
   *
   * **No optimistic patch, and no reallocation to wait for.** A tag changes what a row is
   * *called* and nothing about what is in the deck — the backend does not run the allocator for
   * it — so there is no number on screen that this could get wrong for a beat. It still takes
   * the `["decks"]` root on the way out, because the tag counts on every `DeckTag` row moved.
   */
  const setTag = useMutation({
    mutationFn: ({ cardId, categoryId, finish, tagId }: Slot & { tagId: number | null }) =>
      ipc.deckCardSetTag(opened(id), cardId, categoryId, variant, finish, tagId),
    onSuccess: invalidate,
    onError: invalidate,
  });

  return {
    query,
    /** The gallery's row for this deck, or `null` — both while it is loading and when the id
     *  names a deck another view has since deleted. */
    deck: query.data?.deck ?? null,
    /** Every card of the variant this hook was opened on, in category `sortOrder`, then by the
     *  name the row carries, then by row id. */
    cards: query.data?.cards ?? NONE,
    /** **Every** category of the deck in `sortOrder`, empty and inactive ones included — the
     *  editor's columns are this list, not the categories that happen to hold a card. The list
     *  is the same in both variants; only the counts on each row are scoped. */
    categories: query.data?.categories ?? NO_CATEGORIES,
    /** Every tag of the deck, alphabetically — the palette a row's label is drawn from. */
    tags: query.data?.tags ?? NO_TAGS,
    /** Which of the two lists this hook is reading and writing. Handed back so a caller that
     *  took the default does not have to know what it was. */
    variant,
    update,
    /** How the deck is being *looked at*, stored. Not a write to what is in the deck — see the
     *  mutation's own doc, and `DeckEditor`'s `newest([...])`, which this is not in. */
    rememberView,
    addCard,
    setQuantity,
    clearCategory,
    moveCard,
    refileCard,
    swapPrinting,
    setCardFinish,
    setTag,
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
 * along is the same `["decks", "detail", id, variant]` the editor is already reading, and
 * TanStack shares a query's cache between observers — so with an editor open this costs no
 * `deck_get` at all (the app's `staleTime` is 30 s), and with the context set from a deck the
 * reader is looking at there is always an editor open. A second definition of the mutation
 * would cost more than the query does: the refusal rule that carries a pane-fired GONE back to
 * the editor lives on the definition, and two definitions are two places to keep it.
 *
 * **`variant` is a parameter with a `live` default, and the default is a known gap.**
 * {@link PaneDeckContext} does not carry a variant — it names a deck, a category and a
 * printing — so a pane opened from a **Theory** row and left to the default addresses the
 * `live` list. Two ways that goes wrong: the swap is refused, because
 * `(deck, card, category, variant)` matches no row; or, when the same printing sits in the
 * same category of *both* lists, it swaps the live row while the reader is looking at the
 * theory one. Closing it properly is a field on the store's context, which is the writer's to
 * add; until then the caller passes what the editor is showing, and this shares the editor's
 * cache only when the two agree.
 */
export function useSwapFromPane(
  context: PaneDeckContext | null,
  variant: DeckVariant = DEFAULT_VARIANT,
) {
  const deck = useDeck(context?.deckId ?? null, variant);
  return {
    swap: deck.swapPrinting,
    /**
     * The pane's foil button, for a card that **is** a row of the open deck.
     *
     * Handed over from the same hook mount as the swap rather than a second one, for the reason
     * that mount exists at all: `useDeck` is a live `deck_get`, and two of them would be two
     * reads of one deck. The pane presses this where it presses the swap — on the reader's own
     * copy — and where there is no deck row it draws a view toggle instead and presses nothing.
     */
    setCardFinish: deck.setCardFinish,
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
