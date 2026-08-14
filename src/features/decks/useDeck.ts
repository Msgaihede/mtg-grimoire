import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ipc,
  type DeckCard,
  type DeckCategory,
  type DeckDetail,
  type DeckPatch,
  type DeckTag,
  type DeckVariant,
  type DeckViewState,
} from "@/lib/ipc";
import type { PaneDeckContext } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { autoCategoryFor } from "./autoCategory";

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
 * alternative is filing such a card under `Uncategorised`, and "the caller told us nothing" and
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
   * The slot is `(cardId, categoryId, variant)`, which is `DECK_CARD_GRAIN` minus the deck the
   * hook already is. The variant clause is belt and braces — the key scopes this cache to one
   * list already — and it is written out because the grain is four things and a reader
   * checking this against the schema should find all four.
   *
   * A slot the cache does not hold is left alone rather than added: this patches what is on
   * screen, and inventing a row the read never answered is how an optimistic update starts
   * telling the reader about cards that are not in the deck.
   */
  const patchSlot = (slot: Slot, next: ((card: DeckCard) => DeckCard) | null) => {
    queryClient.setQueryData<DeckDetail | null>(detailKey, (data) => {
      if (!data) return data;
      const at = (c: DeckCard) =>
        c.cardId === slot.cardId && c.categoryId === slot.categoryId && c.variant === variant;
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
   * The wishlist is **not** invalidated here, and that is a decision rather than an
   * omission: a card write moves `deck_allocations` and nothing else, while a wish's
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
   * layout with no bucket word — answers `Uncategorised` whatever the tags said.
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
      quantity,
    }: {
      cardId: string;
      categoryId?: number | null;
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
      return ipc.deckAddCard(deckId, cardId, categoryId, categoryName, variant, quantity);
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
    mutationFn: ({ cardId, categoryId, quantity }: Slot & { quantity: number }) =>
      ipc.deckSetCardQuantity(opened(id), cardId, categoryId, variant, quantity),
    onMutate: async ({ cardId, categoryId, quantity }) => {
      await queryClient.cancelQueries({ queryKey: detailKey });
      const saved = queryClient.getQueryData<DeckDetail | null>(detailKey);
      // Zero takes the row out at the press rather than at the answer: it is what the write
      // means, and a row sitting at `0` for a round trip is a state this table never has.
      patchSlot({ cardId, categoryId }, quantity === 0 ? null : (card) => ({ ...card, quantity }));
      return saved;
    },
    onError: (_error, _slot, saved) => {
      if (saved !== undefined) queryClient.setQueryData(detailKey, saved);
      invalidate();
    },
    onSuccess: (change, { cardId, categoryId }) => {
      // The answer, not the guess: the backend clamps and canonicalises, and this is the
      // number it actually stored.
      patchSlot(
        { cardId, categoryId },
        change.removed ? null : (card) => ({ ...card, quantity: change.quantity }),
      );
      invalidate();
    },
  });

  /** Move every copy from one category to another. A claim released or made even though
   *  nothing was added or removed — an inactive category reserves nothing — so it invalidates
   *  like the rest. */
  const moveCard = useMutation({
    mutationFn: ({ cardId, from, to }: { cardId: string; from: number; to: number }) =>
      ipc.deckMoveCard(opened(id), cardId, from, to, variant),
    onSuccess: invalidate,
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
    }: {
      fromCardId: string;
      toCardId: string;
      categoryId: number;
    }) => ipc.deckSwapPrinting(opened(id), fromCardId, toCardId, categoryId, variant),
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
    mutationFn: ({ cardId, categoryId, tagId }: Slot & { tagId: number | null }) =>
      ipc.deckCardSetTag(opened(id), cardId, categoryId, variant, tagId),
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
    moveCard,
    swapPrinting,
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
