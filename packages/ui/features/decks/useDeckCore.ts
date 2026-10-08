/**
 * One deck, everything in it, and every write that changes what is in it — **with no window
 * behind it.**
 *
 * This is the body `useDeck` was until 2026-10-03, moved out whole so the light app's phone face
 * can write through the same mutations — the same commands, the same optimistic patches, the same
 * invalidations — as the desktop editor. **What did not move is the one thing a phone has no use
 * for**: the desktop's card modal keeps a deck row's address in the app store
 * (`paneDeckContext`), and every write that moves or deletes a row has to move or let go of that
 * address too. Those three store calls are `useDeck.ts`'s, handed in here as a {@link DeckAnchor};
 * a caller with no card surface to keep in step passes nothing and gets {@link NO_ANCHOR}.
 *
 * **Nothing in this file may reach `@/lib/store`** — the phone face's fence
 * (`apps/light/phone/fence.test.ts`) walks the graph from every phone file and refuses one that does.
 * The two `import type`s below are not edges. `useDeck.ts` re-exports everything here, so every
 * desktop caller imports from where it always did.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ipc,
  type DeckCard,
  type DeckCategory,
  type DeckDetail,
  type DeckFinish,
  type DeckPatch,
  type DeckLabel,
  type DeckMissingPick,
  type DeckPullPick,
  type DeckVariant,
  type DeckViewState,
  type MoveOutcome,
} from "@/lib/ipc";
import { useMarketplace } from "@/lib/useMarketplace";
// The condition every menu add in this app records a copy at, imported rather than respelled: the
// card menu's collection add and this hook's quick add have to agree, and two spellings of a
// default drift the first time either changes.
import { MENU_CONDITION } from "@/lib/conditions";
import { invalidateOwnedWrite, refreshCardSearches } from "@/lib/searchMarks";
import { AUTO_CATEGORY, autoCategoryFor } from "./autoCategory";
import { defaultPileFor } from "./defaultCategory";
import {
  DEFAULT_CATEGORY_NAME,
  DEFAULT_VARIANT,
  deckDetailQuery,
  opened,
} from "./deckQuery";
// Types only, and neither is an edge: what a card surface's address *is*, and what leaving one
// costs — both answered on the desktop side of {@link DeckAnchor}.
import type { PaneDeparture } from "@/features/card/cardReturn";
import type { PaneDeckContext } from "@/lib/store";

// Re-exported so every caller that has always imported these from here keeps doing so — they moved
// to `deckQuery.ts`, which reaches no store, so the phone face can read a deck through the same
// key without this file's writes coming with it.
export { DEFAULT_CATEGORY_NAME, DEFAULT_VARIANT, opened } from "./deckQuery";

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
const NO_LABELS: readonly DeckLabel[] = [];

/** One category slot, as every write here addresses it: by what it *is*, never by the
 *  `deck_cards.id` the answer carries. A stale row id is the difference between emptying the
 *  slot the reader pressed and emptying one somebody else already refilled.
 *
 *  The **variant** is the third part of the slot and is not a field here: it is the hook's, and
 *  it is in the query key — see {@link useDeck}.
 *
 *  **Exported for a reason nothing in the app has.** It is in the type of what
 *  {@link useDeckCore} returns — every mutation here takes one — and `useDeck.ts` hands that on
 *  through two functions of its own. A program that only checks never has to *name* the type;
 *  the one that writes declarations (`.design-sync/tsconfig.dts.json`) does, and refused both
 *  functions with TS4058 for as long as this was private. */
export interface Slot {
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
 * The row a write named, as this file can always spell one — `useDeck`'s own `id` and `variant`,
 * and the mutation's {@link Slot}.
 *
 * A `null` `deckId` is a hook nothing can write through, and equals no context's `deckId`, so it
 * needs no arm of its own.
 */
export type WrittenRow = Slot & { deckId: number | null; variant: DeckVariant };

/**
 * Which parts of the address a write moved — every field of {@link PaneDeckContext} that names
 * *where the row is* rather than which deck or which list it is in.
 *
 * `deckId` and `variant` are deliberately absent: no write in this hook moves a row between decks
 * or between the live list and the plan, so a patch that could say so would be a shape nothing can
 * produce. `categoryName` rides beside `categoryId` because a category is a row the reader named
 * (schema v8) — the word is not derivable from the id anywhere the context is *read*, which is why
 * {@link PaneDeckContext} carries both, and a move that updated only the id would leave the card
 * modal's `4× in Burn spells` line naming the pile the card has just left.
 *
 * **A key left out keeps the context's own value; a key present must never be `undefined`.** The
 * patch is spread over the context, so an explicit `undefined` would erase a field rather than
 * leave it — every site below builds the object without one.
 */
export type PaneMove = Partial<Pick<PaneDeckContext, "categoryId" | "categoryName" | "cardId" | "finish">>;

/**
 * What a deck write tells **the card surface that is open on one of its rows** — the desktop's
 * card modal, whose address for a deck row lives in the app store.
 *
 * Three moments, and every write in {@link useDeckCore} that changes a row's address reaches one:
 *
 * - `moved` — the row was written to a new address (a move, a refile, a printing swap, a finish).
 * - `planRemoval` — a removal is *about to* be made; answered before the optimistic patch takes
 *   the row out of the cache, because afterwards nothing can say where it stood. Its answer rides
 *   the mutation's context to `removed`.
 * - `removed` — the row is gone, and the surface open on it has to step off it.
 *
 * **`useDeck.ts` is the one implementation, and the argument for each arm is written there**,
 * beside the store calls it makes. Every arm guards on the whole five-part address itself, so a
 * write that has nothing open on its row costs a store read and nothing else.
 */
export interface DeckAnchor {
  moved: (wrote: WrittenRow, to: PaneMove) => void;
  planRemoval: (wrote: WrittenRow) => PaneDeparture | null;
  removed: (wrote: WrittenRow, departure: PaneDeparture | null) => void;
}

/**
 * The anchor of a caller with no card surface open on a deck row — the light app's phone face,
 * whose card sheet is a place in the URL rather than an address in a store, and which a write
 * therefore has nothing to re-point.
 */
export const NO_ANCHOR: DeckAnchor = {
  moved: () => {},
  planRemoval: () => null,
  removed: () => {},
};

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
export async function oracleTagsFor(cardId: string): Promise<readonly string[]> {
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
export function useDeckCore(
  id: number | null,
  variant: DeckVariant = DEFAULT_VARIANT,
  anchor: DeckAnchor = NO_ANCHOR,
) {
  const queryClient = useQueryClient();
  // Read here rather than passed in: every caller of this hook would otherwise have to thread
  // it through, and one that forgot would silently read a deck priced at the default while the
  // heading beside it named something else.
  const { marketplace } = useMarketplace();

  const detailRead = deckDetailQuery(id, variant, marketplace.id);
  const detailKey = detailRead.queryKey;

  /**
   * The pile `decks.default_category_id` names on **this** list, or `null` for Auto — what an
   * add with {@link addCard}'s `deckDefault` files into (issue #693).
   *
   * **Read through the cache under the keys the editor already uses**, so an add from a menu
   * while that deck is open costs nothing, and one from anywhere else is the one `deck_get` the
   * caller's own `useDeck` was about to make anyway (`fetchQuery` shares the flight). `fetchQuery`
   * rather than `ensureQueryData`: every deck write — Deck settings' among them — invalidates
   * `["decks"]`, and a stale answer here would be a setting changed a moment ago being ignored.
   *
   * The Theory list is resolved by name through the live list's piles, which is
   * {@link defaultPileFor}'s whole reason and the same second read `DeckEditor` makes. A deck
   * that has gone answers Auto; `deck_add_card` then refuses it in words.
   */
  const defaultPileOf = async (deckId: number): Promise<number | null> => {
    const detail = await queryClient.fetchQuery(deckDetailQuery(deckId, variant, marketplace.id));
    if (detail === null || detail.deck.defaultCategoryId === AUTO_CATEGORY) return null;
    const livePiles =
      variant === "theory"
        ? await queryClient.fetchQuery({
            queryKey: ["decks", "categories", deckId, "live", marketplace.id],
            queryFn: () => ipc.deckCategoryList(deckId, "live", marketplace.id),
          })
        : undefined;
    const pile = defaultPileFor(detail.deck.defaultCategoryId, detail.categories, livePiles);
    return pile === AUTO_CATEGORY ? null : pile;
  };

  const query = useQuery(detailRead);

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
   * What the deck calls one of its piles, or `null` — the word a {@link DeckAnchor.moved} needs
   * beside a category id, read at the moment the write succeeded.
   *
   * **The cache rather than `query.data`**, which is the same value one render older: a mutation's
   * `onSuccess` fires after a round trip, and the entry this reads is the one every observer of
   * this deck is drawing from. A category is a row the reader named (schema v8), so there is no
   * table to translate an id through and this list is the only place the word lives.
   *
   * `null` is *the cached read cannot name it*, which is a real state rather than a defensive one:
   * a pile created a beat ago from the card modal's `Create new…` is a row the refetch behind it
   * has not answered with yet. That is what `moveCard`'s optional `toName` is for — the caller who
   * made the pile is holding its name — and a `null` here leaves the context's own word alone
   * rather than replacing it with a guess.
   */
  const categoryNameFor = (categoryId: number): string | null =>
    queryClient
      .getQueryData<DeckDetail | null>(detailKey)
      ?.categories.find((c) => c.id === categoryId)?.name ?? null;

  /**
   * The whole `["decks"]` root, not this one detail: a card write can move every
   * `ownedQuantity` in the deck, and the gallery tile's `cardCount` and `updatedAt` with them.
   *
   * **And, for most writes, not the collection.** Owned/missing is a sum over the rows
   * sitting in this deck's collection group, so a write that only changes the *list* — an add, a
   * move between piles, a finish, a label — provably leaves `collection_entries` where it was,
   * and firing the collection's root as well would be a refetch per press of the stepper that can
   * only answer what is already on screen. **`["wishlist"]` rides every write since user schema
   * v48**, because a theory deck's managed wishlist is rewritten by Rust after any change to the
   * deck — see the line below.
   *
   * **{@link invalidateCollection} is the exception and it is a real one**, so read that one
   * before adding a write to this file: since schema v25 a cut on the live list *moves a
   * collection row*, and this invalidation cannot see that.
   */
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["decks"] });
    // A theory deck's managed wishlist (issue #512) is rewritten by Rust after every deck
    // write, so the wishlist's reads go stale with the deck's. Only a mounted query refetches;
    // an unmounted one is marked and read fresh the next time the wishlist opens.
    void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
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
   * **Four writes here call it, and each is as precise as its own answer allows.** All four
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
   *
   * The **pull** ({@link pullFromCollection}) is the fourth, and it is the one that needs no
   * gate at all — the other three are precise about *when* copies moved because their commands
   * can honestly answer "none". This one cannot: `deck_pull_from_collection` is all-or-nothing
   * and refuses in words, so a resolved promise means every pick landed and rows changed folder
   * by construction. It is also the only one of the four that moves copies **into** the group
   * rather than out of it, which changes nothing here: a row leaving the root for a deck group,
   * and possibly being folded into what the group already held and deleted, is the same edit to
   * the same four surfaces read the other way round.
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
   * **It takes a whole {@link DeckPatch} and names no field, which is what makes a new column
   * free here.** `tokensOpen` — whether the editor's Tokens & Emblems area is expanded — was
   * added to that struct and reached this mutation with no edit at all, exactly as
   * `separateXGroup` and `bracket` did; a per-field arm would be a second definition of what the
   * command already accepts, and the one thing this mutation does branch on (`theoryEnabled`,
   * below) is a *cache* consequence rather than a field being forwarded.
   *
   * `useDecks.update`, narrowed to the deck that is open — it takes a patch and no id,
   * because an editor has exactly one deck and cannot be given the wrong one. Both write the
   * same command and both invalidate the same `["decks"]` root, so the gallery's tile and
   * this header can never disagree about a name; what this one buys is an editor that does
   * not have to mount the gallery's list query to rename the deck it is showing.
   *
   * **A patch that moves the deck's *kind* drops its unwatched lists as well, and that is not
   * tidying.** Either column does it — `theoryEnabled` or `virtualOnly` — because the two are
   * one three-way choice (`deckKind.ts`) and `deckKindPatch` names both on every press, so in
   * practice the first test already fires for every kind change the settings form makes. The
   * second is not therefore redundant: it is the fence for a caller that patches one column
   * alone, and a condition that is true only because of how its one caller happens to spell
   * things is a condition waiting to be wrong.
   *
   * Every field of the deck row is cached once per variant — see the key — so
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
      if (patch.theoryEnabled !== undefined || patch.virtualOnly !== undefined) {
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
   * **A token is never a deck card, and the routing is Rust's** (token stacks, spec §4.6):
   * `deck_add_card` looks at the printing's layout, and a `token`, `double_faced_token` or
   * `emblem` is filed as one of the deck's token entries on this hook's list rather than as a
   * row in any pile — whichever pile it was dropped on, and whatever category or name this sends.
   * It answers `EntryChange.id` **`0`** then, because no deck card was made: a caller that marks
   * the row an add landed in (`DeckEditor`'s landed mark) must skip it. Nothing here branches on
   * the layout — no add payload carries one, which is why the rule lives where the card's row is
   * at hand — and the invalidation below already re-reads the token pile.
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
      deckDefault = false,
      typeLine,
      oracleTags,
      finish = null,
      quantity,
    }: {
      cardId: string;
      categoryId?: number | null;
      /**
       * **File an add that names no pile where the deck says its adds land** —
       * `decks.default_category_id`, the setting Deck settings asks once (issue #693).
       *
       * Set by the surfaces that add to a deck from **outside its editor** — the card menu's
       * `Add to → Deck`, the card modal's picker, the cabinet's `Decks` rows (all three through
       * `useCardToDeck`) and the sidebar's Decks entry. The editor resolves the setting itself,
       * against piles it already has on screen, and hands a real `categoryId` down; a surface
       * with no editor has nothing on screen to resolve it against, so the read is done here, on
       * the deck this hook is open on. Until it was, every one of those adds took the Auto arm
       * below whatever the deck said, and a deck pointed at its Sideboard filled its main piles.
       *
       * **Opt-in rather than the rule for every add with no category, and the reason is the
       * quick zones' `Auto`.** That drop is the reader *choosing* Auto over the deck's setting —
       * the editor's one gesture that names the rule rather than a pile — and it sends the same
       * `{ cardId, typeLine }` shape. Reading the setting for it would turn an explicit choice
       * back into the default.
       *
       * Ignored when `categoryId` is given — a caller that named a pile has already answered. A
       * setting of {@link AUTO_CATEGORY}, or one that names no pile on this list, falls through
       * to the Auto arm exactly as before: {@link defaultPileFor} is the editor's own rule, so
       * the two can never disagree about where an add lands.
       */
      deckDefault?: boolean;
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
      /**
       * What the card *does*, from a caller that has **already read it** — and absent from every
       * caller that has not, which is most of them and costs them the one read below.
       *
       * The docked search is the caller that has: its Add button names the pile before the press,
       * so it reads the wall's tags to name it (`useWallOracleTags`) and hands the same slugs
       * here. **That is what makes the button's word and this hook's word one answer rather than
       * two that usually agree** — the rule is still applied on this one definition, over the
       * very facts the label was drawn from, so a taxonomy replaced between the paint and the
       * press cannot file a card somewhere the button did not say. Until 2026-10-04 the button
       * computed its word from the type line alone and this read the tags: `Add Rampant Growth to
       * Sorcery`, filed under Ramp.
       *
       * Read only in the arm {@link typeLine} is read in. `[]` is an answer — a card known to
       * carry no tag — and is not read again.
       */
      oracleTags?: readonly string[];
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
      const pileId =
        categoryId === null && deckDefault ? await defaultPileOf(deckId) : categoryId;
      // The `await` sits inside the one arm that needs it, so the other two cost exactly what
      // they always did — a named category and a caller with nothing to say each make one IPC
      // call in total. A land still pays the read: the Land pin lives inside `autoCategoryFor`,
      // and short-circuiting it here would be a second copy of that rule.
      const categoryName =
        pileId !== null
          ? null
          : typeLine === undefined
            ? DEFAULT_CATEGORY_NAME
            : autoCategoryFor({ typeLine, oracleTags: oracleTags ?? (await oracleTagsFor(cardId)) });
      return ipc.deckAddCard(deckId, cardId, pileId, categoryName, variant, finish, quantity);
    },
    // **{@link invalidate} for every add, on success and on refusal alike.** This write touches
    // `deck_cards` — **or, for a token, the deck's token entries and nothing in `deck_cards`**
    // (token stacks, spec §4.6: Rust reroutes a `token` / `double_faced_token` / `emblem`
    // printing to a token entry and answers `id: 0`) — and never the collection, so the deck root
    // is the whole of what moved either way: the Tokens & Emblems read is keyed
    // `["decks", "tokens", …]` under it, so a rerouted add re-reads the pile with no arm of its
    // own. The wider `query.ts`'s `OWNED_WRITE_KEYS` set was the deleted `own` arm's, which took a
    // row out of the binder as well, and firing it here would be three refetches per press that
    // can only re-answer what is already on screen.
    onSuccess: invalidate,
    onError: invalidate,
  });

  /**
   * Put **one copy** of a row's exact printing and finish into the deck's **other** list — the
   * card menu's `Add to actual` on a theory row and `Add to theory` on an actual one (issue #592).
   *
   * The variables are the row's {@link Slot}, and `categoryId` is the pile it is in **now**:
   * `deck_add_card_to_other_list` finds the pile in the other list that stands for it — a zone by
   * its kind, any other pile by its name, made there as a copy when the other list lacks it — so
   * that rule lives in Rust once and nothing here guesses a pile of a list it is not reading. The
   * target is the opposite of this hook's `variant`, because the press is always about the list
   * the reader is *not* looking at.
   *
   * **One copy per press and never the row's quantity**, the owner's call: every other Add in the
   * app adds one, so a playset is four presses and a second press folds into a second copy.
   *
   * **{@link invalidate} on success and on refusal alike**, for {@link addCard}'s reason: the
   * write touches `deck_cards` and never the collection, and a refusal may mean the deck is gone.
   * The other list's cached read sits under the same `["decks"]` root, so it is marked stale with
   * the rest and read fresh when the reader switches to it.
   */
  const addToOtherList = useMutation({
    mutationFn: ({ cardId, categoryId, finish }: Slot) =>
      ipc.deckAddCardToOtherList(
        opened(id),
        cardId,
        categoryId,
        variant === "theory" ? "live" : "theory",
        finish,
        1,
      ),
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
   * **Four things decide which command goes**, all of them cheap and all of them necessary: the
   * list has to be `live` (a plan holds no cards, and the backend refuses a theory row outright,
   * so the UI must not ask); **the deck has to keep cardboard at all**; the quantity has to be
   * going *down* (an increase moves no copies — putting a card *into* a deck is
   * `collectionToDeck`, the Collection Search tab's write, which is the next PR); and the caller
   * has to have supplied {@link CutFrom}, because the command addresses `deck_cards.id` and
   * takes a delta while a stepper states an absolute.
   *
   * **The second is the one that had to be added rather than derived, and it was a live defect
   * for the length of one branch** (2026-09-08, issue #401). A *virtual* deck keeps its rows in
   * `live` on purpose — the gallery's card count and colour bar both read that variant — so the
   * first condition is satisfied on the only list it has, and `collection_alloc`'s
   * `deck_to_collection` then refuses it by name. Every removal in the editor reaches this one
   * route, so the stepper's zero, `Remove card` and the remove tray would all have failed on a
   * deck the reader never owned a card of. **The fence is here rather than at the call site**
   * because `held` is the *caller's* answer to a different question — where the copies are — and
   * a route that only refuses when its caller remembers to withhold an argument is a route that
   * breaks the day a fifth surface calls it.
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
      // **The fourth condition, and the one the variant cannot answer** (2026-09-08, issue
      // #401). A virtual deck keeps its rows in `live` like any ordinary deck and has no
      // collection group at all, so `deck_to_collection` refuses it by name — which means every
      // press that *removes* a card would have failed: the stepper's zero, `Remove card` and the
      // remove tray all reach this one route. Read from the cache rather than from `query.data`,
      // which is that value one render older; see {@link invalidate}'s note on the same choice.
      const virtual =
        queryClient.getQueryData<DeckDetail | null>(detailKey)?.deck.virtualOnly === true;
      if (!virtual && variant === "live" && held !== undefined && quantity < held.quantity) {
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
      // **Before the patch below, and that order is the whole reason this is planned here rather
      // than read off at the answer** — see {@link DeckAnchor.planRemoval}. `quantity === 0` is the
      // *intent* to remove; `result.removed` at the answer is the row's fate, and `onSuccess`
      // reads that one before spending this.
      const departure =
        quantity === 0
          ? anchor.planRemoval({ deckId: id, variant, cardId, categoryId, finish })
          : null;
      // Zero takes the row out at the press rather than at the answer: it is what the write
      // means, and a row sitting at `0` for a round trip is a state this table never has.
      patchSlot(
        { cardId, categoryId, finish },
        quantity === 0 ? null : (card) => ({ ...card, quantity }),
      );
      return { saved, departure };
    },
    onError: (_error, _slot, context) => {
      // The rollback puts the row back in the cache and the editor republishes a walk with it on,
      // so a refused removal needs nothing done about `departure`: nobody was moved.
      if (context?.saved !== undefined) queryClient.setQueryData(detailKey, context.saved);
      invalidate();
    },
    onSuccess: (result, { cardId, categoryId, finish }, context) => {
      // The answer, not the guess: the backend clamps and canonicalises, and this is the
      // number it actually stored.
      patchSlot(
        { cardId, categoryId, finish },
        result.removed ? null : (card) => ({ ...card, quantity: result.quantity }),
      );
      // **The one write here that leaves no address to re-anchor to.** Zero deletes the row, so
      // an open card that came out of it is left addressing nothing — see {@link DeckAnchor.removed},
      // which carries the argument for stepping the modal onto the next card rather than closing
      // it or leaving it stranded. `result.removed`, never the `quantity` that was asked for: the
      // two commands this mutation can send answer the same field, and it is the row's fate
      // rather than the argument — which is the same reason the `patchSlot` above reads it. A
      // `quantity` that asked for zero and came back `removed: false` moved nobody, so the plan
      // made at the press is simply dropped.
      if (result.removed) {
        anchor.removed(
          { deckId: id, variant, cardId, categoryId, finish },
          context?.departure ?? null,
        );
      }
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
   * Empty **one whole list** of this deck — Deck settings' **Clear actual list…** and
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

  /**
   * Move every copy from one category to another. It moves no copy out of the deck's group —
   * the cards are still in this deck, one pile over — but a pile can be switched off, and an
   * inactive pile is handed nothing from that group, so every `ownedQuantity` in the deck can
   * move even though nothing was added or removed. `["decks"]` like the rest, and nothing wider.
   *
   * **It changes the third part of the row's address, so it re-anchors** — see
   * {@link DeckAnchor.moved}, whose doc carries the whole argument. This was the reported half of
   * issue "detached modal": a category picked in the card modal landed the write (`categoryId: 5
   * "Draw"` on the row afterwards) and left `paneDeckContext` on `categoryId: 1 "Commander"`, so
   * the picker went on reading **Commander** over a card the deck had filed under Draw.
   */
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
      /**
       * What the destination pile is **called**, where the caller knows and this hook's cache
       * might not — the one argument here that reaches no command.
       *
       * `deck_move_card` answers the category id and nothing else, and {@link categoryNameFor}
       * covers every ordinary press: the destination came out of the deck's own list, so the word
       * is in the cache already. What it cannot cover is a pile *made by the same gesture* — the
       * card modal's `Create new…` chains a create into this move, and the refetch behind the
       * create is racing the move rather than ordered before it. That caller has the name in hand
       * from `deck_category_create`'s own answer, so it says it. Optional, because no other caller
       * has anything to add and a required field would be a question every drag had to answer.
       */
      toName?: string;
    }) => ipc.deckMoveCard(opened(id), cardId, from, to, null, variant, finish),
    onSuccess: (_categoryId, { cardId, from, to, finish, toName }) => {
      const name = toName ?? categoryNameFor(to);
      anchor.moved(
        { deckId: id, variant, cardId, categoryId: from, finish },
        // Built in two shapes rather than one with a possibly-`undefined` key: the patch is
        // spread over the context, so `categoryName: undefined` would erase the word rather than
        // leave it. See {@link PaneMove}.
        name === null ? { categoryId: to } : { categoryId: to, categoryName: name },
      );
      invalidate();
    },
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
      anchor.moved({ deckId: id, variant, cardId, categoryId, finish }, { finish: to });
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
    //
    // **The re-anchor is gated on the same answer and for a stronger reason than the refetch is**
    // ({@link DeckAnchor.moved}): a card that did not move is a card whose address did not change, so
    // moving the open card's context would be this hook re-pointing it at where it already is.
    // `categoryId` is non-null exactly when `moved` is — the mutation's own doc says so — and the
    // name comes off `result.category`, which is the word the rule produced, so this arm never
    // needs {@link categoryNameFor}: `deck_move_card`'s name arm finds-or-creates, and a pile it
    // has just created is one the cached read cannot name.
    onSuccess: (result, { cardId, from, finish }) => {
      if (!result.moved) return;
      if (result.categoryId !== null) {
        anchor.moved(
          { deckId: id, variant, cardId, categoryId: from, finish },
          { categoryId: result.categoryId, categoryName: result.category },
        );
      }
      invalidate();
    },
  });

  /**
   * Swap a deck card to another printing of the same card — `AllPrintingsDialog`'s press on a
   * tile, and the card modal's own **Printing** picker, both from outside this editor.
   *
   * **It changes the fourth part of the row's address, so it re-anchors** — see
   * {@link DeckAnchor.moved}, and read that doc before moving this back to a call site: it was at one
   * until 2026-09-03, on an argument about a docked pane that no longer exists, and in the
   * meantime *nothing* re-anchored at all. A card open on the row a swap rewrites went on
   * addressing the printing the deck had stopped playing, which is what a reader reports as the
   * modal detaching.
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
    // The **fold** needs no arm: a swap onto a printing the pile already holds turns two rows
    // into one, and the survivor is the row at `toCardId` — which is where this lands either
    // way. `AllPrintingsDialog` still says the fold in words, because a merged count is the one
    // outcome of that press nothing on screen explains; what it no longer has to do is re-point
    // the card underneath it.
    onSuccess: (_result, { fromCardId, toCardId, categoryId, finish }) => {
      anchor.moved(
        { deckId: id, variant, cardId: fromCardId, categoryId, finish },
        { cardId: toCardId },
      );
      invalidate();
    },
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
   *
   * **It names a folder now, and that leaves every word above true** (issue #437). The wish is
   * still oracle-grained and still finish-blind — what a folder adds is *where the line is
   * filed*, which is the wishlist's fourth grain term (`coalesce(folder_id, 0)`) and not a
   * fifth thing about the card. So the fold is unchanged in kind and narrower in reach: two
   * presses at one destination still raise one line, and the same shortfall sent to the root
   * and then to `Ordered` is two lines rather than one folded twice — which is right, because
   * those are two *places*, and a reader who filed the second one somewhere else meant a
   * second line. `null` is the wishlist root, and the argument is **required** rather than
   * optional for this hook's standing reason: a caller that has not thought about where these
   * wishes go must say `null` out loud rather than get the root by silence.
   *
   * **None of the three invalidations moves.** `["wishlist"]` is the root every folder key in
   * that feature sits under — the folder list and every folder summary — so a line written
   * inside `Ordered` re-counts that folder for free and no fourth key belongs here. And
   * `["cards", "search"]` is unaffected by *where* a wish sits: `CardSummary.wishlisted` is an
   * `EXISTS` over `oracle_id` and has never read `folder_id`.
   *
   * **A folder id that names nothing is refused up front** — "That folder is not there any
   * more." — rather than answered with 0. That is the backend's decision and it is the one this
   * hook depends on: 0 is already the honest answer for a deck that is short of nothing, so a
   * vanished folder answering the same number would be a press that reported success and wrote
   * nowhere. It reaches the reader through `DeckStats`' own failure line, beside the button.
   */
  const missingToWishlist = useMutation({
    mutationFn: (folderId: number | null) => ipc.deckMissingToWishlist(opened(id), folderId),
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
      void refreshCardSearches(queryClient);
    },
  });

  /**
   * Copies the reader already owns, moved into this deck's group — the write half of the pull.
   *
   * {@link missingToWishlist} read in the other direction, and that is not a resemblance: the
   * two commands ask one question about the same shortfall. What the deck has *not* got goes on
   * a shopping list; what it *has* got is sitting in a binder and only needs moving. So where
   * that one takes `["wishlist"]` on top of the deck root, this one takes `["collection"]`.
   *
   * **It writes no `deck_cards` row**, which is worth stating here because it decides what
   * `["decks"]` is doing. Nothing about the *list* changes — a 4-copy line the reader is 3 short
   * of is still a 4-copy line — so the deck root is fired for `ownedQuantity` alone, which is a
   * sum over the collection rows sitting in this deck's group and is exactly what this moved.
   * The shortfall line, every card's owned/missing mark and the gallery tile all read off it.
   *
   * **{@link invalidateCollection} unconditionally**, unlike the three writes that gate on their
   * own answer: a pick the backend re-reads and disagrees with refuses the whole batch, so there
   * is no "succeeded and moved nothing" state to tell apart. Read that function's doc before
   * touching this — a row that leaves the root for a deck group can be folded into what the
   * group already held and deleted outright, which is four collection surfaces wrong at once and
   * none of them under `["decks"]`.
   *
   * **And `["cards", "search"]`, which is not optional.** The backend runs this through
   * `collection_source::with_write_owned`, which rebuilds the facet index's `owned` dimension —
   * so a search wall left on screen behind the dialog is drawing a stale `owned` facet, over
   * tiles whose printings really have changed hands. The same key {@link missingToWishlist}
   * takes and for the same shape of reason: this is a write that is visibly wrong on a surface
   * the reader can see rather than stale in a field nothing draws.
   *
   * **No optimistic patch, and none to write.** Every number this could move is a sum the
   * backend computes over rows in another table, so there is nothing in the cached `DeckDetail`
   * this file could correct without re-deriving the allocator in TypeScript.
   */
  const pullFromCollection = useMutation({
    mutationFn: (picks: DeckPullPick[]) => ipc.deckPullFromCollection(opened(id), picks),
    onSuccess: () => {
      invalidate();
      invalidateCollection();
      void refreshCardSearches(queryClient);
    },
  });

  /**
   * Record the copies this row is short of, straight into the deck's own group — and, where the
   * press named a wish, take them off it in the same transaction.
   *
   * **The one write in this hook that can _create_ a collection row**, which is the whole of why
   * it takes `query.ts`'s {@link OWNED_WRITE_KEYS} rather than the {@link invalidateCollection}
   * the three movers share. That function's own doc says the narrower set is right *because* all
   * four of its callers only move a row between folders, so the total the reader owns cannot have
   * changed — and it names the write that went with the deleted `own` add as the one that could
   * do otherwise. **This is that case coming back.** `CardSummary.ownedQuantity` moves from 0 to
   * N on the very tile the press was made on, and a 30 s `staleTime` over a missing root is a
   * number that goes on saying what it said before the press for half a minute.
   *
   * **`["wishlist"]` is in that set already, and here it is load-bearing rather than incidental.**
   * The other member of the constant takes it because a recorded copy changes what a wish counts
   * as owned; this write can go further and **delete the wish outright**, so the shopping list's
   * own rows move and not just their progress.
   *
   * **`["decks"]` is the fourth member**, so {@link invalidate} is not called beside this: it
   * would be a second spelling of a root the set already carries. Nothing about the deck's *list*
   * changes — no `deck_cards` row is written — and the root is owed for `ownedQuantity` alone,
   * exactly as it is on the pull.
   *
   * **`MENU_CONDITION` rather than a second spelling of whatever it holds.** A quick add records
   * a copy at the condition every other menu add in this app records one at, and two constants
   * holding that decision drift the first time either moves — which it has: the constant was
   * `"NM"` until schema v35 gave the column a grade meaning "the reader did not say", and every
   * site that had spelled the letters out would have gone on recording Near Mint for a reader who
   * never claimed it.
   *
   * **The card is passed whole rather than a `(cardId, finish)` pair**, because the row is the
   * thing the reader right-clicked and its finish is part of its address — a caller assembling
   * the pair by hand is a caller that can send the regular copy's word for a foil line. The
   * `quantity` is the caller's for the same reason it is not derived here: `quickAddShort` reads
   * the row, and a mutation that re-derived it would answer for a `DeckCard` a beat older than
   * the menu label the reader pressed.
   *
   * **No optimistic patch, for {@link pullFromCollection}'s reason**: every number this moves is
   * a sum the backend computes over rows in another table.
   */
  const quickAddToCollection = useMutation({
    mutationFn: ({
      card,
      quantity,
      wishId,
    }: {
      card: DeckCard;
      quantity: number;
      wishId: number | null;
    }) =>
      ipc.deckQuickAddToCollection(
        opened(id),
        card.cardId,
        card.finish,
        MENU_CONDITION,
        quantity,
        wishId,
      ),
    onSuccess: () => {
      invalidateOwnedWrite(queryClient);
    },
  });

  /**
   * The deck-wide form of the line above: record **every** copy the reader ticked into this
   * deck's group, and take the unambiguous wishlist lines down with them.
   *
   * **It takes `query.ts`'s {@link OWNED_WRITE_KEYS} and not the narrower
   * {@link invalidateCollection} the three movers share, and the reason is the one that
   * constant's own doc gives for the set existing: this write *creates* rows.** A move cannot
   * change the total a reader owns, so `["collection"]` alone is honest for it; this makes
   * `collection_entries` rows that were not there, so `CardSummary.ownedQuantity` goes from 0 to
   * N on tiles the reader is looking at — and `query.ts` caches for 30 s, so a root left out is
   * not a refetch that lands late but a number that goes on saying the old one for half a
   * minute. {@link quickAddToCollection} is the same case one grain down.
   *
   * **`["wishlist"]` in that set is load-bearing here rather than incidental.** The other
   * members take it because a recorded copy changes what a wish counts as *owned*; this press
   * can go further and **delete a wish outright** — `take_lone_wish` removes a line it takes to
   * nothing — so the shopping list's own rows move and not just their progress bars.
   *
   * **`["decks"]` is already in that set, so {@link invalidate} is not called beside this.** It
   * would be a second spelling of a root the constant carries, and the root is owed here for
   * exactly what it is owed for on the pull: no `deck_cards` row is written, but every deck's
   * `ownedQuantity` is a sum over the rows this press just made.
   *
   * **No optimistic patch, and none to write** — {@link pullFromCollection}'s reason. Every
   * number this moves (the shortfall, the owned count, the wish's progress) is a sum the backend
   * computes over rows in another table, so there is nothing in the cached `DeckDetail` this
   * file could correct without re-deriving the write in TypeScript.
   *
   * **The picks arrive whole from the dialog rather than being derived here.** `addMissingPlan`
   * is the pure module that turns the plan plus the reader's departures from it into
   * `DeckMissingPick[]`, and a mutation that re-derived them would answer for a plan a beat
   * older than the footer count the reader pressed. The backend re-plans inside its own
   * transaction anyway, which is the fence — nothing sent here is trusted.
   */
  const addMissingToCollection = useMutation({
    mutationFn: ({ picks, clearWishes }: { picks: DeckMissingPick[]; clearWishes: boolean }) =>
      ipc.deckMissingToCollection(opened(id), picks, clearWishes),
    onSuccess: () => {
      invalidateOwnedWrite(queryClient);
    },
  });

  /**
   * Put the deck's one label on a card, or take it off with `labelId: null`.
   *
   * A **card** write, addressed by the same slot as the stepper and the move — which is why it
   * lives here rather than in `useDeckMeta` beside the label CRUD. The label is app-wide data; a
   * card *wearing* one is a fact about a row of `deck_cards`, and a stale editor pointing at a
   * row that has since moved, folded or been stepped to zero is answered in words.
   *
   * **No optimistic patch, and no reallocation to wait for.** A label changes what a row is
   * *called* and nothing about what is in the deck — the backend does not run the allocator for
   * it — so there is no number on screen that this could get wrong for a beat. It still takes
   * the `["decks"]` root on the way out, because the card counts on every `DeckLabel` row moved.
   */
  const setLabel = useMutation({
    mutationFn: ({ cardId, categoryId, finish, labelId }: Slot & { labelId: number | null }) =>
      ipc.deckCardSetLabel(opened(id), cardId, categoryId, variant, finish, labelId),
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
    /** **Every** category of the list this hook reads, in `sortOrder`, empty and inactive ones
     *  included — the editor's columns are this list, not the categories that happen to hold a
     *  card. Each list has piles of its own since user schema v53 (issue #561), so the Theory
     *  tab's columns are the plan's and never the Actual list's. */
    categories: query.data?.categories ?? NO_CATEGORIES,
    /** Every label this list is wearing — the palette a row's mark is drawn from. */
    labels: query.data?.labels ?? NO_LABELS,
    /** Which of the two lists this hook is reading and writing. Handed back so a caller that
     *  took the default does not have to know what it was. */
    variant,
    update,
    /** How the deck is being *looked at*, stored. Not a write to what is in the deck — see the
     *  mutation's own doc, and `DeckEditor`'s `newest([...])`, which this is not in. */
    rememberView,
    addCard,
    /** One copy of a row into the deck's other list, filed in the pile there that stands for
     *  the row's own — see the mutation's doc. */
    addToOtherList,
    setQuantity,
    clearCategory,
    /** Empty a whole list of this deck. **Takes the variant as its argument** rather than using
     *  the hook's — see the mutation's own doc for the caller that makes that necessary. */
    clearDeck,
    moveCard,
    refileCard,
    swapPrinting,
    setCardFinish,
    setLabel,
    missingToWishlist,
    /** The mirror of the line above — what the deck is short of **and the reader owns**, moved
     *  into its group. See the mutation's own doc for the three roots it invalidates, and for
     *  why the third of them is not optional. */
    pullFromCollection,
    /** Record the copies one row is short of into this deck's group, and optionally clear a
     *  wish with them. **The one write here that creates a collection row**, so it takes all
     *  four of `OWNED_WRITE_KEYS` — see the mutation's own doc. */
    quickAddToCollection,
    /** The same press over the whole list: every copy the reader ticked in the Add missing
     *  dialog, recorded into this deck's group, with the unambiguous wishes taken down beside
     *  them. It creates rows too, so it takes the same four roots — see its own doc. */
    addMissingToCollection,
  };
}

/** The whole of what a deck page consumes — `useDeck.ts`'s `Deck` is this, anchored. */
export type DeckCore = ReturnType<typeof useDeckCore>;

/**
 * What the deck is short of that the reader **already owns** — the read half of the pull, and
 * the whole of what the dialog draws.
 *
 * **Its own hook rather than a member of {@link useDeck}, because it is the one read here that
 * nobody wants by default.** Everything that hook answers is what the editor is drawing right
 * now; this is a plan over every unallocated collection row that could fill a hole, asked once,
 * by one dialog, when a reader presses one button. Folding it in would mean either a `deck_pull_plan`
 * behind every mounted editor — the card pane's `useSwapFromPane` included — or an `enabled`
 * flag threaded through a hook whose other fifteen members have no use for it.
 *
 * **Keyed under the `["decks"]` root** so `useDeck`'s own `invalidate` reaches it, which is the
 * whole reason the key is shaped this way: every write in that hook can move the shortfall this
 * answers, and the pull itself moves the *candidates* as well as the holes — a plan left in the
 * cache after a successful pull offers copies that are now in the deck's own group and are
 * therefore excluded from it by definition. `["decks", "pullPlan", deckId]` is
 * `["decks", "theorySlots", deckId]`'s shape, which is this folder's shape for a read that is
 * about one deck and is not the deck itself: the root, the question, the id.
 *
 * **No `variant` and no `marketplace` in the key, and neither is an omission.** The command
 * reads the live list only — a plan holds no cards, so there is nothing there to be short of —
 * and nothing it answers is priced. A key carrying either would be two cached answers to one
 * question, refetched on a switch that cannot change it.
 *
 * **`enabled` is the caller's, and what it means is "the dialog is open".** `DeckEditor`'s
 * `Layer` doc is explicit that a surface nobody opened has no business asking for anything, and
 * this is the widest read that surface makes. It is a gate on a mounted query rather than a
 * conditionally mounted hook for the ordinary reason — the answer stays in the cache across an
 * open and a close, so a reader who shuts the dialog and reopens it pays nothing.
 *
 * `deckId` is nullable for {@link useDeck}'s reason: a caller with no deck open mounts an idle
 * query rather than branching around one, and a `null` id can never satisfy the gate.
 */
export function usePullPlan(deckId: number | null, enabled: boolean) {
  return useQuery({ ...pullPlanQuery(deckId), enabled: enabled && deckId !== null });
}

/**
 * The pull plan's key and fetcher, as options both readers build from.
 *
 * **Two things ask for this plan and they must not spell the key twice.** {@link usePullPlan}
 * mounts it for the dialog; the deck card menu's per-card pull *fetches* it imperatively at the
 * press (`queryClient.fetchQuery`) so that a right-click costs nothing and only a chosen row
 * pays. A second spelling here would be a fetch that never shares the dialog's cache — the two
 * would each hold their own answer to one question, and the silent half is that both would still
 * work: the menu's press would simply always miss, and every press would be a fresh
 * `deck_pull_plan` behind a dialog that already had one.
 *
 * The key is unchanged from what the hook spelled: `["decks", "pullPlan", deckId]`, under the
 * root {@link useDeck}'s own `invalidate` reaches, which is what keeps a plan from outliving the
 * write that filled its holes. See {@link usePullPlan} for why it carries neither a variant nor a
 * marketplace.
 *
 * `deckId` is nullable so the hook can pass what it was given; the fetcher throws through
 * {@link opened} rather than answering for a deck that is not open, and the hook's `enabled` is
 * what keeps that unreachable.
 */
export function pullPlanQuery(deckId: number | null) {
  return {
    queryKey: ["decks", "pullPlan", deckId],
    queryFn: () => ipc.deckPullPlan(opened(deckId)),
  };
}

/**
 * What the deck is short of that the reader has **just bought** — the read half of
 * `Add missing to collection`, and the whole of what that dialog draws.
 *
 * **The mirror of {@link usePullPlan} and not a second spelling of it.** The pull asks which
 * copies already on the reader's desk could fill a hole; this asks only what the holes *are*,
 * because the cardboard it is about exists nowhere the database can see it yet. So there is no
 * candidate join here and the row carries `wishes` instead — the same answer
 * `deck_quick_add_wishes` gives the per-card menu, so the two entrances cannot come to disagree
 * about what fills a wish.
 *
 * **Its own hook rather than a member of {@link useDeck}, for `usePullPlan`'s reason**: that
 * hook answers what the editor is drawing right now, and this is a walk of every hole in the
 * live list, asked once, by one dialog, when a reader presses one button.
 *
 * **Keyed `["decks", "missingPlan", deckId]`** — the root, the question, the id, which is this
 * folder's shape for a read that is about one deck and is not the deck itself. Under `["decks"]`
 * on purpose: {@link useDeck}'s own `invalidate` reaches it, and so does this feature's own
 * write, whose `OWNED_WRITE_KEYS` carries that root — **the press closes the very holes this
 * answers**, so a plan left in the cache after a successful record offers copies the deck is no
 * longer short of.
 *
 * **No `variant` and no `marketplace` in the key**, for the pull's reasons exactly: the command
 * reads the live list only — a plan holds no cards, so there is nothing there to be short of —
 * and nothing it answers is priced. Either in the key would be two cached answers to one
 * question, refetched on a switch that cannot change it.
 *
 * **`enabled` is the caller's and means "the dialog is open".** A gate on a mounted query rather
 * than a conditionally mounted hook, so the answer survives an open and a close and reopening
 * costs nothing. `deckId` is nullable for {@link useDeck}'s reason, and a `null` id can never
 * satisfy the gate.
 */
export function useMissingPlan(deckId: number | null, enabled: boolean) {
  return useQuery({ ...missingPlanQuery(deckId), enabled: enabled && deckId !== null });
}

/**
 * The missing plan's key and fetcher, as options.
 *
 * **This one has a single reader, where {@link pullPlanQuery} has two — and the factory is kept
 * anyway, deliberately.** That one exists because the dialog mounts the plan and a deck card's
 * `Collection ▸ Pull …` *fetches* it imperatively at the press, and two spellings of the key
 * would be two caches for one question. Nothing presses this imperatively: the per-card form of
 * this feature is `Collection ▸ Quick add N copies`, a menu row that writes outright and reads
 * no plan at all. So what the factory buys here is not a shared cache but the *shape* — the key
 * is written once, beside its neighbour, in the file this folder's rule already names as the
 * home for these options ({@link quickAddWishesQuery} is the third), and a second reader added
 * later is a caller rather than a second key. The alternative — folding it into the hook — is
 * equally correct today and would cost one export; it was weighed and this is the tie-break.
 */
export function missingPlanQuery(deckId: number | null) {
  return {
    queryKey: ["decks", "missingPlan", deckId],
    queryFn: () => ipc.deckMissingPlan(opened(deckId)),
  };
}

/**
 * The wishes a quick-add-and-unwish press would clear, as query options rather than as a hook.
 *
 * **Deliberately not a hook, and that is the whole design of it.** A deck card's right-click has
 * to be free: a mounted query per drawn card, or even per opened menu, would ask the wishlist
 * about every card a reader hovered past. So the editor fetches this at the **press**, through
 * `queryClient.fetchQuery(quickAddWishesQuery(...))`, and the answer lands in the same cache
 * anything else reading it would find — which is what the factory is for. A key written out at
 * the call site is the one this file cannot keep in step.
 *
 * **`["wishlist", "forPrinting", cardId, finish ?? ""]`.** Under the `["wishlist"]` root, so
 * `quickAddToCollection`'s own invalidation reaches it — that write can delete the very wish this
 * answered, and a cached list offering a row that is gone is a picker whose confirm is refused.
 * The finish is part of the key because it is part of the *question*: the predicate matches the
 * row's own finish, so the foil line and the regular line of one printing have two answers.
 * `""` for the regular copy, `pullKey`'s translation and safe for its reason — no finish is the
 * empty string, so `null` cannot collide with `"foil"` or `"etched"`.
 *
 * It names no deck, because a wish does not: which deck the press came from decides where the
 * *copies* are filed and says nothing about which shopping lines could be cleared.
 */
export function quickAddWishesQuery(cardId: string, finish: DeckFinish) {
  return {
    queryKey: ["wishlist", "forPrinting", cardId, finish ?? ""],
    queryFn: () => ipc.deckQuickAddWishes(cardId, finish),
  };
}
