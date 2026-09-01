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
  type MoveOutcome,
} from "@/lib/ipc";
import { useAppStore, type PaneDeckContext } from "@/lib/store";
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
 * The `deck_cards` row a decrease is being taken *out of* — the one thing a slot cannot say.
 *
 * `deck_cards.id` is what {@link ipc.deckToCollection} addresses, and it is the only deck
 * command in the app that does; every other one takes the grain, which is why nothing else here
 * carries an id. `quantity` is what the row holds **now**, because the command takes a *delta*
 * where the stepper states an absolute.
 *
 * **Supplied by the caller rather than read from the cache, and that is not a preference.**
 * TanStack runs `onMutate` before `mutationFn`, and `onMutate` here removes the row
 * optimistically — so by the time the write runs, the cache no longer holds the row it would
 * have to read. The caller has it in hand: every removal in this editor starts from a
 * {@link DeckCard} or from a slot it looks up in the list it is drawing.
 *
 * Absent means "route this the old way": a theory list, a caller that could not find the row
 * (a drag can outlive the list it started in), or an *increase*.
 */
export interface CutFrom {
  deckCardId: number;
  quantity: number;
}

/**
 * What the quantity write answers, whichever command it actually sent.
 *
 * The first two fields are `EntryChange`'s and are about the **deck list**. `outcome` is about
 * the **collection** and is `null` for every write that did not touch it — a theory row, an
 * increase, a caller with no {@link CutFrom}. A caller reading `outcome.quantity` is asking how
 * many copies landed on the reader's desk, which is not the number it asked to remove and is
 * `0` for a card the reader never owned.
 */
export interface QuantityResult {
  quantity: number;
  removed: boolean;
  outcome: MoveOutcome | null;
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
   * The whole `["decks"]` root, not this one detail: a card write can move every
   * `ownedQuantity` in the deck, and the gallery tile's `cardCount` and `updatedAt` with them.
   *
   * **And, for most writes, nothing wider than that.** Owned/missing is a sum over the rows
   * sitting in this deck's collection group, so a write that only changes the *list* — an add, a
   * move between piles, a finish, a tag — provably leaves `collection_entries` where it was, and
   * firing the collection's root as well would be a refetch per press of the stepper that can
   * only answer what is already on screen. `missingToWishlist` takes `["wishlist"]` on top,
   * because it is the one command here that actually writes wishes.
   *
   * **{@link invalidateCollection} is the exception and it is a real one**, so read that one
   * before adding a write to this file: since schema v25 a cut on the live list *moves a
   * collection row*, and this invalidation cannot see that.
   */
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["decks"] });
  };

  /**
   * The collection's root as well — for the one write here that files copies somewhere else.
   *
   * Cutting a card from a **live** list takes the copies the deck's group was holding and files
   * them into `Recently removed`, in the same transaction as the `deck_cards` write. That is a
   * row leaving one folder and often *merging into another and being deleted*, which is exactly
   * the shape PR 2 shipped a ghost row for: the collection's list, its summary, both folder
   * cards and the folder tree are all now wrong, and the deck root reaches none of them.
   *
   * **Three writes here call it, and each is as precise as its own answer allows.** All three
   * only *move* a row between folders, so the total the reader owns cannot have changed — which is
   * why this is narrower than `query.ts`'s `OWNED_WRITE_KEYS` rather than a smaller version of it. The
   * one write in this hook that could create a binder row went with the `own` add on 2026-08-25;
   * see the note where its invalidation stood.
   *
   * The **cut** is called only when the outcome says copies actually moved: a deck card nobody
   * owned answers `quantity: 0` and `entryId: null` — nothing in any folder was behind it, so
   * nothing in the collection changed and a refetch could only re-answer what is on screen. The
   * arguments that went in cannot tell the two apart; only {@link MoveOutcome} can.
   *
   * The **clear** ({@link clearCategory}) is the second, and it cannot be that precise:
   * `deck_category_clear` answers the copies it took out of `deck_cards` — `sum(quantity)`,
   * counted before the DELETE — never the copies that reached a folder, so a pile of cards the
   * reader never owned reads the same as one they did. What it can say is when nothing moved
   * *for certain* — a `theory` clear (a plan holds no cards, and the backend's release is
   * fenced on `live`) and a clear that emptied nothing at all — and it is gated on both. The remaining over-fire is one refetch against a ghost row, which is the
   * right way round.
   *
   * The **whole-list clear** ({@link clearDeck}) is the third and is imprecise in exactly the
   * same way, one grain wider: `deck_clear` answers the copies it took out of `deck_cards`,
   * never the copies that reached `Recently removed`, so a deck of cards nobody owned reads the
   * same as a deck of cards they did. The gate is therefore the same two certainties and no
   * more — a `theory` clear moves nothing (the backend's release is fenced on `live`), and a
   * clear that answered `0` emptied nothing to move — and it is deliberately **not** written as
   * a claim that a positive answer means copies changed folders. It only means they might have.
   */
  const invalidateCollection = () => {
    void queryClient.invalidateQueries({ queryKey: ["collection"] });
  };

  /*
   * **`invalidateOwnedWrite` stood here for the `own` add and is deleted with it** (2026-08-25).
   *
   * It fired all four of `query.ts`'s `OWNED_WRITE_KEYS`, because that arm could *record* a copy the
   * reader had never written down — `collection_add` creates a row, so `CardSummary
   * .ownedQuantity` moved from 0 to N on the very tile the press was made on. No write left in
   * this hook can do that: an add writes `deck_cards`, and every other write here moves copies
   * that already exist, which {@link invalidateCollection} covers. The constant is still shared
   * with the import's owned half, which makes the same change from the other side of the app.
   */

  /**
   * The deck itself: its name, its format, its cover, whether it is archived.
   *
   * `useDecks.update`, narrowed to the deck that is open — it takes a patch and no id,
   * because an editor has exactly one deck and cannot be given the wrong one. Both write the
   * same command and both invalidate the same `["decks"]` root, so the gallery's tile and
   * this header can never disagree about a name; what this one buys is an editor that does
   * not have to mount the gallery's list query to rename the deck it is showing.
   *
   * **A patch that moves the theory switch drops the deck's *unwatched* lists as well, and that
   * is not tidying.** Every field of the deck row is cached once per variant — see the key — so
   * `theory_enabled` has one value in the database and up to two in this cache, and an
   * invalidation only refetches what somebody is looking at. The other list keeps its old row
   * until something mounts it, and then serves it **stale before the refetch lands**: a reader
   * who switches the plan back on and presses `Theory` in the same second reads a row that still
   * says the deck keeps no plan, so `DeckEditor`'s clamp takes them straight back to `Actual` and
   * the press appears to do nothing. Dropping the entry makes that beat a *read* rather than a
   * wrong answer — `isPending`, no row, and neither the restore nor the clamp acts on one.
   *
   * `type: "inactive"` is the whole of the care needed: the list on screen has an observer, so it
   * is left alone and refreshed by the invalidation below in the ordinary way, and no surface
   * flashes its loading state for a switch it was not showing. This is the *write* end of the
   * same fact `DeckEditor`'s restore marker guards at the read end — that one has to hold anyway,
   * since a sync from another device can cross the two rows with no press here at all.
   */
  const update = useMutation({
    mutationFn: (patch: DeckPatch) => ipc.deckUpdate(opened(id), patch),
    onSuccess: (_deck, patch) => {
      if (patch.theoryEnabled !== undefined) {
        queryClient.removeQueries({ queryKey: ["decks", "detail", id], type: "inactive" });
      }
      invalidate();
    },
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

  /*
   * **`addOwnedCopies` stood here from 2026-08-23 to 2026-08-25 and is deleted with the
   * own/need pair that was its only way in.**
   *
   * It was {@link addCard}'s `owned` arm: read the card's oracle id, hunt the binder for a copy
   * no deck was holding (`chooseFreeCopy`, in the deleted allocator's own preference order),
   * record one on the spot if there was none, and move it into this deck's group — three local
   * round trips on a deliberate press, ending in the same `collection_to_deck` the Collection
   * Search tab presses.
   *
   * **The tab is the better entrance to that write and is why this is a deletion rather than a
   * relocation.** This path was silent: it chose a copy for the reader out of rows they were not
   * looking at, and where it found none it filed a *new* collection row for a card they had only
   * searched for. The tab searches the copies they actually hold, shows which one a press would
   * take, and confirms by name before taking one another deck is holding. What is lost is a
   * one-click "I own this" from a wall of Scryfall printings, which is exactly the click whose
   * silence was the problem.
   */

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
      /*
       * **An `owned` field stood here from 2026-08-23 to 2026-08-25**, set by the docked panel's
       * own/need pair, and every add in this app now means what an absent one always meant: the
       * deck holds a card nothing in the collection backs, so the row reads as *missing* — which
       * is what the deck→wishlist sweep is built on. Putting a copy the reader owns into a deck
       * is `collection_to_deck`, which the Collection Search tab presses.
       */
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
    // **{@link invalidate} for every add, on success and on refusal alike.** This write touches
    // `deck_cards` and nothing else, so the deck root is the whole of what moved — the wider
    // `query.ts`'s `OWNED_WRITE_KEYS` set was the deleted `own` arm's, which took a row out of the
    // binder as well, and firing it here would be three refetches per press that can only
    // re-answer what is already on screen.
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
   *
   * ## A decrease on the **live** list is a different command
   *
   * Since schema v25 a deck holds a card because a collection row sits in that deck's group, so
   * cutting one has to put the copies somewhere: `deck_to_collection` files them into
   * `Recently removed` and decrements the `deck_cards` row **in the same transaction**. It
   * replaces `deckSetCardQuantity` for that press rather than joining it — sending both would
   * take the copies off the list twice — and it is the write that makes
   * {@link CUT_CARDS_NOTE}, the standing sentence at the foot of the deck, true.
   *
   * **Three things decide which command goes**, all of them cheap and all of them necessary: the
   * list has to be `live` (a plan holds no cards, and the backend refuses a theory row outright,
   * so the UI must not ask); the quantity has to be going *down* (an increase moves no copies —
   * putting a card *into* a deck is `collectionToDeck`, the Collection Search tab's write, which
   * is the next PR); and the caller has to have supplied {@link CutFrom}, because the command
   * addresses `deck_cards.id` and takes a delta while a stepper states an absolute.
   *
   * **The answer is a {@link QuantityResult} and its `outcome` is load-bearing**, not a
   * courtesy: a cut of a card the reader never owned moves nothing at all, and only the outcome
   * can tell that from a cut that emptied a folder — see {@link invalidateCollection}.
   */
  const setQuantity = useMutation({
    mutationFn: async ({
      cardId,
      categoryId,
      finish,
      quantity,
      held,
    }: Slot & { quantity: number; held?: CutFrom }): Promise<QuantityResult> => {
      if (variant === "live" && held !== undefined && quantity < held.quantity) {
        // The cut, and **instead of** `deckSetCardQuantity` rather than beside it: the command
        // decrements the `deck_cards` row itself, so sending both would take the copies off the
        // list twice. What it buys is the other half — the copies the group was holding are
        // filed into `Recently removed` in the same transaction.
        const outcome = await ipc.deckToCollection(held.deckCardId, held.quantity - quantity);
        return { quantity, removed: quantity === 0, outcome };
      }
      const change = await ipc.deckSetCardQuantity(
        opened(id),
        cardId,
        categoryId,
        variant,
        finish,
        quantity,
      );
      return { quantity: change.quantity, removed: change.removed, outcome: null };
    },
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
    onSuccess: (result, { cardId, categoryId, finish }) => {
      // The answer, not the guess: the backend clamps and canonicalises, and this is the
      // number it actually stored.
      patchSlot(
        { cardId, categoryId, finish },
        result.removed ? null : (card) => ({ ...card, quantity: result.quantity }),
      );
      invalidate();
      // **The outcome, not the argument.** A cut of a card nobody owned moves nothing, and
      // refetching the collection for it would answer exactly what is already on screen — see
      // {@link invalidateCollection}, which is where the ghost row this guards against is
      // written down.
      if (result.outcome !== null && result.outcome.quantity > 0) invalidateCollection();
    },
  });

  /**
   * Empty one category of this variant — a pile's right-click **Clear stack**.
   *
   * **One command, not a `setQuantity(…, 0)` per row**, and the reason is the one that made
   * `deck_import_commit` a command: the rows are all in hand here, so the loop would compile —
   * and it would be one transaction and one `["decks"]` invalidation *per card*, with the deck
   * re-read forty times while the reader watches. It would also be forty history rows for one
   * press, and any one of them could be refused halfway leaving the pile half-empty with no way
   * to say so.
   *
   * **On the live list it is a collection write too**, and the second one in this file:
   * `deck::clear_category` releases every `live` row's backing copies into `Recently removed`
   * before the `DELETE`, through the same walk the cut goes through. See
   * {@link invalidateCollection} for what it costs to miss that, and for why the two gates below
   * are the whole of what this press can honestly say.
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
    onSuccess: (cleared) => {
      invalidate();
      if (variant === "live" && cleared > 0) invalidateCollection();
    },
  });

  /**
   * Empty **one whole list** of this deck — Deck settings' **Clear live list…** and
   * **Clear theory list…** — and answer the copies
   * it removed.
   *
   * {@link clearCategory} one grain wider, and every argument on that mutation applies here more
   * strongly rather than differently: one command instead of a clear per pile, which would be a
   * transaction, a history row and a `["decks"]` invalidation per column while the reader
   * watches; and **no optimistic patch**, because this is one press behind a confirmation and
   * guessing would delete every column from the cache before knowing the write landed. The
   * piles themselves survive — `deck_categories` is untouched, so the desk the reader arranged
   * is still there once the cards are gone.
   *
   * **The variant is a mutation argument, and it is the one thing in this hook that does not use
   * the hook's own {@link variant}.** That is a fact about the caller rather than a style
   * choice: `DeckSettingsDialog` mounts `useDeck(deckId)` — no second argument, so the hook is
   * reading the **live** list — and one of the two presses it draws clears the *theory* list. A
   * `clearDeck` that read `variant` would answer "cleared the theory list" while having emptied
   * the deck the reader actually owns, silently and behind a confirmation that said otherwise.
   * So the caller says which list every time and this mutation never guesses.
   *
   * **On the live list it is a collection write too** — `live` rows release their backing copies
   * into `Recently removed` — and the gate below is {@link invalidateCollection}'s, character
   * for character `clearCategory`'s and for the identical reason: the command answers copies
   * removed from `deck_cards`, never copies that reached a folder, so `theory` and a clear that
   * answered `0` are the only two cases it can rule out for certain.
   */
  const clearDeck = useMutation({
    mutationFn: (target: DeckVariant) => ipc.deckClear(opened(id), target),
    onSuccess: (cleared, target) => {
      invalidate();
      if (target === "live" && cleared > 0) invalidateCollection();
    },
  });

  /** Move every copy from one category to another. It moves no copy out of the deck's group —
   *  the cards are still in this deck, one pile over — but a pile can be switched off, and an
   *  inactive pile is handed nothing from that group, so every `ownedQuantity` in the deck can
   *  move even though nothing was added or removed. `["decks"]` like the rest, and nothing
   *  wider. */
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
   * `["decks"]` like every card write, and nothing wider: since schema v25 a swap rewrites the
   * `deck_cards` row's `card_id` and touches no collection table at all, so no copy moves and
   * no folder changes. What *can* change is the number this deck shows — owned/missing is
   * matched by oracle id, so it is the same answer for both printings, and a fold onto a
   * printing the pile already held moves two rows into one.
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
    /** Empty a whole list of this deck. **Takes the variant as its argument** rather than using
     *  the hook's — see the mutation's own doc for the caller that makes that necessary. */
    clearDeck,
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
