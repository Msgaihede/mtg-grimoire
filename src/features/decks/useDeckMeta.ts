import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ipc,
  ipcError,
  type DeckCard,
  type DeckCategory,
  type DeckTag,
  type DeckVariant,
  type GlobalTag,
  type TagColor,
} from "@/lib/ipc";
import { useMarketplace } from "@/lib/useMarketplace";
import { autoCategoryFor, UNCATEGORIZED } from "./autoCategory";
import { DEFAULT_CATEGORY_NAME, DEFAULT_VARIANT, opened } from "./useDeck";

/** Stable identities for "not loaded yet", so a consumer's `useMemo` does not re-run on every
 *  render of a panel that is still waiting. */
const NO_CATEGORIES: readonly DeckCategory[] = [];
const NO_TAGS: readonly DeckTag[] = [];
const NO_ALL_TAGS: readonly GlobalTag[] = [];

/**
 * The piles {@link useDeckMeta}'s `autoCategorise` is allowed to empty — and the only ones.
 *
 * These are the two names **this app** files a card under when nobody chose: the word the v8
 * migration gave every legacy main-deck row, and the fallback `autoCategoryFor` answers for a
 * card it cannot place. Anything else is a column a person made or kept, and a one-press
 * "tidy" that emptied one of those would be destroying work rather than doing it.
 *
 * The alternative considered and rejected: re-file **every** `main` card. It is what the
 * feature sounds like, and it is the version that silently undoes a reader's hand-built
 * "Removal" column the first time they press it.
 */
const LOOSE_PILES: readonly string[] = [DEFAULT_CATEGORY_NAME, UNCATEGORIZED];

/**
 * What the reader is told when the tag read is refused — **and the press files nothing.**
 *
 * The sentence says the outcome before it says the cause, because the outcome is the part that
 * is not guessable: a reader who pressed a button promising to file by *function* would
 * otherwise be left wondering whether half the deck had moved.
 *
 * **Refusing is the whole decision here, and it is not the cautious-looking one.** Falling
 * through to the type line is what `autoCategoryFor` does for a card whose slugs come back
 * empty, and that path is deliberate and load-bearing — a database that has never ingested the
 * taxonomy answers every card `slugs: []` and the app files by type, which is a supported way
 * to run it. A **rejection** is a different fact: not "these cards do nothing this app has a
 * word for" but "nobody could ask". Proceeding on it would re-file a whole deck by type in one
 * press, across every pile at once, and the only way back is to move the cards one at a time.
 * A single add can afford to guess — its blast radius is one card. This cannot.
 *
 * Pressing again is the whole of the recovery, and it costs nothing: every refusal reachable
 * here is a busy database or a deck another surface deleted.
 */
const TAG_READ_REFUSED =
  "Nothing was filed. What these cards do could not be read, and filing the whole deck by card " +
  "type instead is not what you pressed.";

/**
 * A deck's **categories and tags as things in themselves** — the piles and the labels, rather
 * than the cards filed under them.
 *
 * **One hook, mounted by two dialogs** (changed 2026-08-14): `CategoriesDialog` and `TagsDialog`
 * were two sections of one drawer and are two independent surfaces now, and each of them mounts
 * the whole of this. So each fires the other's read — opening Categories asks for the deck's
 * tags, opening Tags asks for its categories — and that is worth having written down rather than
 * discovered from a log. It is cheap and it is not free: **three** local-SQLite reads either way
 * — the categories, the tags the list on screen is wearing, and every tag there is — across the
 * three key shapes below, shared through one `["decks"]`-rooted cache, so the second dialog a
 * reader opens in a sitting finds its own lists already there. (It was four until schema v21:
 * the fourth was a second `deck_tag_list` at the *other* variant, folded into a map so that a
 * delete confirmation could quote a count the variant does not scope. `deck_tag_all` answers
 * that off the row now, and answers it about every deck rather than about two lists of one.)
 * Splitting the hook to match the split of the drawer would buy two of those reads back for
 * Categories and one for Tags, and would cost the two surfaces their one definition of what a
 * deck's piles and labels are; that trade has not been worth making.
 *
 * `useDeck` already answers both lists as part of `deck_get`; these are the same facts read
 * through the two commands that exist so a dialog need not pull the whole card list to draw a
 * column heading. They cannot durably disagree because every write in the app invalidates the
 * one `["decks"]` root, which is a prefix of every key here — both spellings of the tag key
 * included — and of the editor's detail key.
 *
 * **`variant` scopes the two counts on each category row and nothing else.** Which categories
 * a deck has, what they are called, what order they are in and whether they are switched on are
 * facts about the deck, not about one of its two lists — so a Live/Theory switch changes the
 * numbers in the headings and never the headings themselves.
 *
 * **For tags it scopes membership as well, and that asymmetry is deliberate.** Since schema v21
 * a tag belongs to no deck; what a deck has is cards, some of which wear one. So "this deck's
 * tags" is derived from the cards of the list on screen, and flipping Live↔Theory genuinely
 * changes which tags are there — the issue asks for the two lists to be treated as different
 * decks where labels are concerned, and this is where that is true.
 *
 * **The marketplace scopes one number and is in the categories key for it**: a category's
 * `totalPrice` is a sum at one marketplace, and the two are not conversions of each other.
 * The tag reads take no marketplace at all — a `DeckTag` carries a count and no money — which
 * is why only one of the three key shapes below grew a segment.
 *
 * A known narrowing, and it is the backend's rather than this hook's: every **category** write
 * answers with the `live` variant's counts, because a rename carries no variant of its own. It
 * costs nothing here — the row a mutation answers with is its result and is never written into
 * the cache; the invalidation re-reads through this hook's own variant. The tag writes stopped
 * having the problem at v21: an app-wide write answers the app-wide row, whose counts are not
 * scoped by a variant at all.
 */
export function useDeckMeta(deckId: number | null, variant: DeckVariant = DEFAULT_VARIANT) {
  const queryClient = useQueryClient();
  const { marketplace } = useMarketplace();

  const categoriesQuery = useQuery({
    queryKey: ["decks", "categories", deckId, variant, marketplace.id],
    queryFn: () => ipc.deckCategoryList(opened(deckId), variant, marketplace.id),
    enabled: deckId !== null,
  });

  const tagsQuery = useQuery({
    queryKey: ["decks", "tags", deckId, variant],
    queryFn: () => ipc.deckTagList(opened(deckId), variant),
    enabled: deckId !== null,
  });

  /**
   * **Every tag there is**, most-used first — the app-wide list, and the only read here that
   * can answer a tag no card is wearing.
   *
   * No deck in the key, because there is none in the command: one tag list belongs to the app.
   * It sits under `["decks"]` all the same, so creating, renaming or deleting a tag refreshes
   * the list that tag is in.
   *
   * **It also does the work `tagCardCountsAllVariants` used to** — a second `deck_tag_list` at
   * the *other* variant, folded into a map, so that a delete confirmation could quote a number
   * the variant does not scope. That read existed because `DECK_VARIANTS` has two members and
   * two reads were therefore every variant; it stopped being enough the moment the reach became
   * every *deck*, and {@link GlobalTag.cardCount} is the number itself, off one command.
   *
   * Gated on a deck for the reason every query in this hook is: the Decks view mounts with no
   * deck open, and the only surface that wants this list is a tag dialog inside an editor.
   */
  const allTagsQuery = useQuery({
    queryKey: ["decks", "tagsAll"],
    queryFn: () => ipc.deckTagAll(),
    enabled: deckId !== null,
  });

  /**
   * The whole `["decks"]` root, from every write here — `useDeck`'s rule, and it is load-bearing
   * for two of these in particular.
   *
   * `setCategoryActive` and `deleteCategory` **reallocate** inside their own transaction: the
   * switch is what decides whether a card is claimed at all, so flipping it changes what this
   * deck has reserved without touching a single card, and every other deck's `ownedQuantity`
   * can move with it. The rest (a rename, a reorder, every tag write) change what a pile is
   * *called* and nothing about what is in it — they take the same root anyway, because the
   * editor's columns are drawn from a category list this just rewrote.
   *
   * **On error as well as on success**, on the definition rather than on a call site. Every
   * refusal here is either a busy database or a deck, category or tag that another surface has
   * deleted — and the second must not leave a panel drawing a column that is gone. Two
   * definitions of that rule would be two places to keep it.
   */
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["decks"] });
  };
  const writes = { onSuccess: invalidate, onError: invalidate };

  /** A new pile: always `kind: "main"`, always active, appended after the deck's last one.
   *  Refused when the deck already has that name — the grain is `(deckId, name)`. */
  const createCategory = useMutation({
    mutationFn: (name: string) => ipc.deckCategoryCreate(opened(deckId), name),
    ...writes,
  });

  /** Rename one pile. Refused for the four predefined ones, which is what guarantees that
   *  "Commander" still reads "Commander" in every heading and every refusal sentence. */
  const renameCategory = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => ipc.deckCategoryRename(id, name),
    ...writes,
  });

  /** Switch a pile on or off — `isActive`, which is the whole of "counts toward nothing".
   *  Allowed on every kind including the Commander, and it reallocates. */
  const setCategoryActive = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      ipc.deckCategorySetActive(id, isActive),
    ...writes,
  });

  /** The new order, whole: `sortOrder` is written from position, so this takes **every** id and
   *  not a move. An id that is not this deck's is skipped rather than failing the reorder. */
  const reorderCategories = useMutation({
    mutationFn: (ids: number[]) => ipc.deckCategoryReorder(opened(deckId), ids),
    ...writes,
  });

  /**
   * Delete a pile, with or without keeping its cards.
   *
   * **`moveToCategoryId: null` is the destructive half** — the cards go with the category, by
   * cascade — and it is one command rather than two so a caller cannot lose them between a move
   * and a delete that failed. A confirm dialog owes the reader that difference in words.
   */
  const deleteCategory = useMutation({
    mutationFn: ({ id, moveToCategoryId }: { id: number; moveToCategoryId: number | null }) =>
      ipc.deckCategoryDelete(id, moveToCategoryId),
    ...writes,
  });

  /**
   * "File cards by what they do", pressed once: file the cards nobody has filed into piles
   * named for what they *do* — falling back to what they *are*. Answers how many cards moved.
   *
   * **One rule, and it is `autoCategoryFor`** — Land by type line, then the Oracle-tag bucket,
   * then the type line again, in TypeScript, because the v8 migration deliberately declined to
   * write a second copy of it in SQL. This hook does not re-derive it and must not; what it
   * owns is the **fact** the rule reads, which is the tags.
   *
   * **One tag read for the whole press, and it is the reason this is a mutation rather than a
   * loop over `useDeck.addCard`'s trick.** An add carries its own type line from the call site
   * and pays no round trip; there is no such free ride for a slug list, so the choice is one
   * bulk read here or one read per card. `oracle_tags_for_printings` batches 500 ids to a
   * statement, so a 100-card deck costs exactly one call. The ids are sent **distinct** and the
   * answers matched back **by `cardId`** — never by position: the command drops blanks and
   * duplicates, so the answer can be shorter than the request, and a deck holding one printing
   * in two loose piles is exactly the shape that would mis-file under an index.
   *
   * **A refused tag read refuses the press** — see {@link TAG_READ_REFUSED}, which is the whole
   * of that argument. An *empty* answer is not a refusal and never reaches it: a card with no
   * slugs is filed by its type line, which is the floor this feature has always stood on.
   *
   * Five things it will not do, each of them a way the obvious version goes wrong:
   *
   * * It only empties {@link LOOSE_PILES}. A column a person made is theirs.
   * * It only moves cards out of an **active** category. Moving one out of a switched-off pile
   *   would make it count toward size, copies and legality again — a rules change nobody
   *   pressed, in a button labelled "tidy".
   * * It only moves cards **into** an active category, which is the same hazard seen from the
   *   other end and is reachable by accident: a reader may own a category called "Creature"
   *   and have switched it off. Filing a card there would take it *out* of the deck — no size,
   *   no copy limit, no legality check, no claim — with nothing on screen saying so. This is
   *   the mirror of the collision `autoCategory.ts` guards against by keeping the rule's answers
   *   clear of the predefined names, and it needs its own fence because a *user's* category can
   *   be called anything. Such a card is left where it is; switching the pile back on and
   *   pressing again files it.
   * * It leaves a card the rule cannot place where it is. `autoCategoryFor` answers
   *   {@link UNCATEGORIZED} for an orphan or a layout it has no word for, and moving those from
   *   one loose pile into another is churn dressed as work.
   * * It creates a target pile only when the deck has none by that name, reading the deck's
   *   **current** categories rather than this hook's cached list — a panel that was one write
   *   stale would otherwise try to create a category that exists and be refused by name.
   *
   * **Not atomic, and safe to press again.** There is no backend command for this — the rule
   * is TypeScript's, so the orchestration is too — so a failure part-way leaves the cards that
   * already moved where they went; `onError` re-reads, so the screen says so. Pressing again
   * finishes the job and moves nothing twice: a card that landed in "Removal" is no longer in
   * a loose pile, so the second pass does not see it.
   */
  const autoCategorise = useMutation({
    mutationFn: async (cards: readonly DeckCard[]) => {
      const deck = opened(deckId);
      const loose = cards.filter(
        (card) =>
          card.variant === variant &&
          card.categoryKind === "main" &&
          card.categoryActive &&
          LOOSE_PILES.includes(card.categoryName),
      );
      // Nothing to file is answered before anything is read: a second press on a filed deck
      // costs no tag read, which is what keeps "press it again" free.
      if (loose.length === 0) return 0;

      // One read for the press, keyed by printing. Distinct ids, because two loose piles can
      // hold the same printing and the second copy would buy nothing.
      let slugsByCardId: ReadonlyMap<string, readonly string[]>;
      try {
        const answers = await ipc.oracleTagsForPrintings([...new Set(loose.map((c) => c.cardId))]);
        slugsByCardId = new Map(answers.map((row) => [row.cardId, row.slugs] as const));
      } catch (cause) {
        // The backend's own words after this app's, and the rejection itself carried along:
        // `ipcError` is what the panel renders, `cause` is what a stack trace needs.
        //
        // The two-argument `Error` is ES2022 and this program targets ES2020, so it compiles
        // only because `tsconfig.json` adds `ES2022.Error` to `lib` — added *for* this line,
        // because ESLint's `preserve-caught-error` requires the `cause` and the type checker
        // refused it. Dropping the second argument to "fix" a type error here re-breaks lint.
        throw new Error(`${TAG_READ_REFUSED} ${ipcError(cause)}`, { cause });
      }

      const moves = loose
        .map((card) => ({
          card,
          // A card the answer does not mention is a card with no tags — the command answers
          // `slugs: []` for an unknown id on purpose, and a shortened list means the same
          // thing. Both fall through to the type line, which is the rule's own floor.
          target: autoCategoryFor({
            typeLine: card.typeLine,
            oracleTags: slugsByCardId.get(card.cardId) ?? null,
          }),
        }))
        // **The `UNCATEGORIZED` guard stays here after the quick zones' `Auto` dropped it**
        // (2026-08-16), and the asymmetry is the point rather than a drift. This press is over
        // every loose card in the deck at once, and `Uncategorized` is itself one of
        // {@link LOOSE_PILES} — so filing into it would walk a card from one pile nobody chose
        // to another, in bulk, and call it tidying. A drag is the opposite act: one card, aimed
        // by hand at a zone the reader pressed, where "I could not place it" is worth a pile they
        // can see and drag out of. It is the same split this action already makes about a pile
        // the reader built and a switched-off target — blast radius decides.
        .filter(({ card, target }) => target !== UNCATEGORIZED && target !== card.categoryName);
      if (moves.length === 0) return 0;

      // The deck as it is now, not as this panel last read it. The marketplace is along for
      // the ride because the command takes one; nothing here reads a price.
      const existing = await ipc.deckCategoryList(deck, variant, marketplace.id);
      // Only **active** piles are somewhere a card may be filed. An inactive one of the right
      // name is not a target, and it is not something to create over either: the name is taken,
      // so `deck_category_create` would refuse it. Both facts are read off the same list.
      const idByName = new Map(
        existing.filter((c) => c.isActive).map((c) => [c.name, c.id] as const),
      );
      const switchedOff = new Set(existing.filter((c) => !c.isActive).map((c) => c.name));

      for (const target of new Set(moves.map((m) => m.target))) {
        // A pile this deck has not got at all is made, and is active by construction —
        // `deck_category_create` seeds `is_active` true.
        if (!idByName.has(target) && !switchedOff.has(target)) {
          idByName.set(target, (await ipc.deckCategoryCreate(deck, target)).id);
        }
      }

      let moved = 0;
      for (const { card, target } of moves) {
        const to = idByName.get(target);
        // A target that is somehow the card's own category is skipped rather than sent: the
        // backend would refuse a move to where the card already is, and failing the whole
        // press over one such row would undo nothing and finish nothing. A target that is only
        // held by a switched-off pile is skipped the same way, and reaches here as `undefined`.
        if (to === undefined || to === card.categoryId) continue;
        // The **id** arm, even though this rule names its target: the pile has already been
        // found or made above, in a loop that reads the deck's live categories once for the
        // whole press. Sending the name instead would re-resolve it per card, and would take
        // this bulk action's three deliberate refusals — a switched-off target, a pile the
        // reader made, a card the rule cannot place — out of TypeScript's hands and hand them
        // to `category_for_name`, which knows none of them.
        // The row's own finish: this walks `cards`, so a pile holding a printing twice is two
        // entries here and each is moved as itself.
        await ipc.deckMoveCard(
          deck,
          card.cardId,
          card.categoryId,
          to,
          null,
          variant,
          card.finish,
        );
        moved += 1;
      }
      return moved;
    },
    ...writes,
  });

  /** A new label, **app-wide**; the deck is where the reader was standing. Refused when any
   *  tag already holds the name — see `tagNames.ts` for the comparison, and for why the
   *  dialogs try not to let a reader reach this refusal. */
  const createTag = useMutation({
    mutationFn: ({ name, color }: { name: string; color: TagColor }) =>
      ipc.deckTagCreate(opened(deckId), name, color),
    ...writes,
  });

  /** Rename **and** recolour, **in every deck at once**: one command, both required, because
   *  there is no patch shape here — a caller changing one sends the other back unchanged. */
  const updateTag = useMutation({
    mutationFn: ({ id, name, color }: { id: number; name: string; color: TagColor }) =>
      ipc.deckTagUpdate(opened(deckId), id, name, color),
    ...writes,
  });

  /** Take a label off **this deck's cards in the list on screen**, leaving the tag itself
   *  alone. The row-level act the app-wide list needed: "I am done with this here" and "this
   *  label should stop existing" were one press while a tag belonged to a deck, and
   *  conflating them now would mean tidying one deck stripped the label off nine others. */
  const removeTagFromDeck = useMutation({
    mutationFn: (tagId: number) => ipc.deckTagRemoveFromDeck(opened(deckId), tagId, variant),
    ...writes,
  });

  /** Delete a label **from the whole app**. It **untags its cards rather than deleting them**
   *  — `deck_cards.tag_id` is `ON DELETE SET NULL` — in every deck wearing it, which is the
   *  half of the sentence a confirm dialog owes a reader and the reason
   *  {@link GlobalTag.deckCount} is on the row. */
  const deleteTag = useMutation({
    mutationFn: (id: number) => ipc.deckTagDelete(opened(deckId), id),
    ...writes,
  });

  return {
    categoriesQuery,
    tagsQuery,
    allTagsQuery,
    /** Every category of the deck in `sortOrder`, empty and inactive ones included. */
    categories: categoriesQuery.data ?? NO_CATEGORIES,
    /** The tags this deck's list on screen is wearing, most-used first. */
    tags: tagsQuery.data ?? NO_TAGS,
    /** Every tag there is, most-used first — including the ones nothing wears. */
    allTags: allTagsQuery.data ?? NO_ALL_TAGS,
    createCategory,
    renameCategory,
    setCategoryActive,
    reorderCategories,
    deleteCategory,
    autoCategorise,
    createTag,
    updateTag,
    removeTagFromDeck,
    deleteTag,
  };
}

/** The whole of what a categories or tags panel consumes, named so the view and the hook
 *  agree. */
export type DeckMeta = ReturnType<typeof useDeckMeta>;
