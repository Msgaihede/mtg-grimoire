import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ipc,
  type DeckCard,
  type DeckCategory,
  type DeckTag,
  type DeckVariant,
  type TagColor,
  type TagSuggestion,
} from "@/lib/ipc";
import { autoCategoryFor, UNCATEGORISED } from "./autoCategory";
import { DEFAULT_CATEGORY_NAME, DEFAULT_VARIANT, opened } from "./useDeck";

/** Stable identities for "not loaded yet", so a consumer's `useMemo` does not re-run on every
 *  render of a panel that is still waiting. */
const NO_CATEGORIES: readonly DeckCategory[] = [];
const NO_TAGS: readonly DeckTag[] = [];
const NO_SUGGESTIONS: readonly TagSuggestion[] = [];

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
const LOOSE_PILES: readonly string[] = [DEFAULT_CATEGORY_NAME, UNCATEGORISED];

/**
 * A deck's **categories and tags as things in themselves** — the piles and the labels, rather
 * than the cards filed under them.
 *
 * This is the categories panel's and the tag editor's hook. `useDeck` already answers both
 * lists as part of `deck_get`; these are the same facts read through the two commands that
 * exist so a panel need not pull the whole card list to draw a column heading. They cannot
 * durably disagree because every write in the app invalidates the one `["decks"]` root, which
 * is a prefix of all three keys here and of the editor's detail key.
 *
 * **`variant` scopes the two counts on each row and nothing else.** Which categories a deck
 * has, what they are called, what order they are in and whether they are switched on are facts
 * about the deck, not about one of its two lists — so a Live/Theory switch changes the numbers
 * in the headings and never the headings themselves.
 *
 * A known narrowing, and it is the backend's rather than this hook's: every category and tag
 * **write** answers with the `live` variant's counts, because a rename carries no variant of
 * its own. It costs nothing here — the row a mutation answers with is its result and is never
 * written into the cache; the invalidation re-reads through this hook's own variant.
 */
export function useDeckMeta(deckId: number | null, variant: DeckVariant = DEFAULT_VARIANT) {
  const queryClient = useQueryClient();

  const categoriesQuery = useQuery({
    queryKey: ["decks", "categories", deckId, variant],
    queryFn: () => ipc.deckCategoryList(opened(deckId), variant),
    enabled: deckId !== null,
  });

  const tagsQuery = useQuery({
    queryKey: ["decks", "tags", deckId, variant],
    queryFn: () => ipc.deckTagList(opened(deckId), variant),
    enabled: deckId !== null,
  });

  /**
   * The autocomplete palette for a "New tag" dialog: every name and colour used across **every**
   * deck, most-used first.
   *
   * No deck in the key, because there is none in the command: a reader who has typed "Cut
   * candidate" into four decks should be offered it in the fifth. It sits under `["decks"]` all
   * the same, so creating a tag refreshes the palette that tag just joined.
   *
   * Gated on a deck anyway, for the reason every query in this hook is: the Decks view mounts
   * with no deck open, and the only surface that wants a palette is a tag dialog inside an
   * editor.
   */
  const suggestionsQuery = useQuery({
    queryKey: ["decks", "tagSuggestions"],
    queryFn: () => ipc.deckTagSuggestions(),
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
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["decks"] });
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
   * "Auto-categorise from card types", pressed once: file the cards nobody has filed into the
   * piles their type lines name. Answers how many cards moved.
   *
   * **One rule, and it is `autoCategoryFor`** — the type line and nothing else, in TypeScript,
   * because the v8 migration deliberately declined to write a second copy of it in SQL. This
   * hook does not re-derive it and must not.
   *
   * Four things it will not do, each of them a way the obvious version goes wrong:
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
   *   {@link UNCATEGORISED} for an orphan or a layout it has no word for, and moving those from
   *   one loose pile into another is churn dressed as work.
   * * It creates a target pile only when the deck has none by that name, reading the deck's
   *   **current** categories rather than this hook's cached list — a panel that was one write
   *   stale would otherwise try to create a category that exists and be refused by name.
   *
   * **Not atomic, and safe to press again.** There is no backend command for this — the rule
   * is TypeScript's, so the orchestration is too — so a failure part-way leaves the cards that
   * already moved where they went; `onError` re-reads, so the screen says so. Pressing again
   * finishes the job and moves nothing twice: a card that landed in "Creature" is no longer in
   * a loose pile, so the second pass does not see it.
   */
  const autoCategorise = useMutation({
    mutationFn: async (cards: readonly DeckCard[]) => {
      const deck = opened(deckId);
      const moves = cards
        .filter(
          (card) =>
            card.variant === variant &&
            card.categoryKind === "main" &&
            card.categoryActive &&
            LOOSE_PILES.includes(card.categoryName),
        )
        .map((card) => ({ card, target: autoCategoryFor(card) }))
        .filter(({ card, target }) => target !== UNCATEGORISED && target !== card.categoryName);
      if (moves.length === 0) return 0;

      // The deck as it is now, not as this panel last read it.
      const existing = await ipc.deckCategoryList(deck, variant);
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
        await ipc.deckMoveCard(deck, card.cardId, card.categoryId, to, variant);
        moved += 1;
      }
      return moved;
    },
    ...writes,
  });

  /** A new label for this deck. The colour is a palette token, not CSS — see {@link TagColor}. */
  const createTag = useMutation({
    mutationFn: ({ name, color }: { name: string; color: TagColor }) =>
      ipc.deckTagCreate(opened(deckId), name, color),
    ...writes,
  });

  /** Rename **and** recolour: one command, both required, because there is no patch shape
   *  here — a caller changing one sends the other back unchanged. */
  const updateTag = useMutation({
    mutationFn: ({ id, name, color }: { id: number; name: string; color: TagColor }) =>
      ipc.deckTagUpdate(id, name, color),
    ...writes,
  });

  /** Delete a label. It **untags its cards rather than deleting them** — `deck_cards.tag_id` is
   *  `ON DELETE SET NULL` — which is the half of the sentence a confirm dialog owes a reader. */
  const deleteTag = useMutation({
    mutationFn: (id: number) => ipc.deckTagDelete(id),
    ...writes,
  });

  return {
    categoriesQuery,
    tagsQuery,
    suggestionsQuery,
    /** Every category of the deck in `sortOrder`, empty and inactive ones included. */
    categories: categoriesQuery.data ?? NO_CATEGORIES,
    /** Every tag of the deck, alphabetically. */
    tags: tagsQuery.data ?? NO_TAGS,
    /** The app-wide tag palette, most-used first — not this deck's tags. */
    suggestions: suggestionsQuery.data ?? NO_SUGGESTIONS,
    createCategory,
    renameCategory,
    setCategoryActive,
    reorderCategories,
    deleteCategory,
    autoCategorise,
    createTag,
    updateTag,
    deleteTag,
  };
}

/** The whole of what a categories or tags panel consumes, named so the view and the hook
 *  agree. */
export type DeckMeta = ReturnType<typeof useDeckMeta>;
