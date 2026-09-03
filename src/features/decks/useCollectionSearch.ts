import { useCallback, useEffect, useMemo, useState } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { COLLECTION_FIRST_DIR, nextOffset } from "@/features/collection/useCollection";
import { useCollectionFolderList } from "@/features/collection/useCollectionFolders";
import {
  activeFilterCount,
  colorParam,
  DEBOUNCE_MS,
  formatsWithDefault,
  toggleColor,
  toggleIn,
  type ColorKey,
  type FormatFilterOption,
} from "@/features/search/useCardSearch";
import {
  ipc,
  type CollectionFolder,
  type CollectionQuery,
  type CollectionRow,
  type CollectionSortKey,
  type MoveOutcome,
} from "@/lib/ipc";
import type { SortSpec } from "@/lib/sort";
import { useMarketplace } from "@/lib/useMarketplace";
import { playKey, useDeckPlays } from "./useDeckPlays";

/**
 * Rows per request in this column.
 *
 * Smaller than the collection page's `COLLECTION_PAGE_SIZE` of 100, and the reason is the
 * width rather than the corpus: this list is drawn in a column between {@link MIN_PANEL_WIDTH_PX}
 * and half the window, one text row per copy, and a reader who has not found what they wanted in
 * sixty rows is going to narrow the filter rather than scroll. The rest is one press on **Show
 * more**, which is also the only paging control there is room for.
 */
export const DECK_COLLECTION_PAGE_SIZE = 60;

/**
 * Which copies the list is asking for — `CollectionQuery.allocation`'s two words, spelled the way
 * `collection::Allocation`'s `rename_all = "camelCase"` deserialises them.
 *
 * **Nothing in this app has ever sent this field.** It has existed since schema v25 and every
 * caller written before folders gets `All` by omission, so this tab is its first sender and these
 * two strings are the whole of the wire contract. `src/lib/ipc.test.ts` pins them.
 */
export type Allocation = NonNullable<CollectionQuery["allocation"]>;

/**
 * What a reader who has pressed nothing gets — **the copies no deck is holding**, and that is the
 * product decision this tab is (spec §7.2).
 *
 * "Unallocated" is the root, a folder the reader made, and `Recently removed`: all three are cards
 * on the desk. A copy filed in a deck's group is spoken for, and hiding it by default is what
 * makes this list answer "what can I build with today" rather than "what do I own".
 */
export const DEFAULT_ALLOCATION: Allocation = "unallocated";

/**
 * Where one copy is filed, said in the terms the Add button needs.
 *
 * Three answers rather than a boolean, because the three lead to three different presses: a copy
 * on the desk moves silently, a copy this deck already holds cannot move at all
 * (`collection_alloc::ALREADY_HERE` refuses it in words), and a copy in **another** deck's group
 * moves only through a confirmation that names that deck.
 */
export interface CopySource {
  kind: "desk" | "here" | "otherDeck";
  /** The other deck's name, for the sentence the confirm asks. `null` on the two answers that
   *  name no deck. */
  deckName: string | null;
}

const DESK: CopySource = { kind: "desk", deckName: null };
const HERE: CopySource = { kind: "here", deckName: null };

/**
 * Which of the three a row is, from the folder census.
 *
 * **A function over `collection_folder_list` rather than a field on the row, because the row has
 * no field to read.** `CollectionRow` carries `folderId` and `folderName` and deliberately not the
 * folder's `kind` — the DTO says where a copy is filed, not what kind of place that is — so "is
 * this copy in a deck" is a question only the census answers. That census is one cached query
 * (`["collection", "folders"]`) already fetched once per window for the card menu, so asking it
 * here costs nothing.
 *
 * **An unplaceable folder is treated as spoken for, and the asymmetry is deliberate.** The census
 * is a query, so there is a render or two on the way up where it has not answered and every
 * `folderId` is unknown; guessing "desk" there would let an add slip past the confirm on exactly
 * the copies the confirm exists for. Guessing the other way costs a confirmation the reader
 * dismisses. The row's own `folderName` is the best name available in that state and is what the
 * question quotes — for a deck's group it *is* the deck's name, since `create_deck_group` names
 * the folder after the deck.
 */
export function copySource(
  row: Pick<CollectionRow, "folderId" | "folderName">,
  folders: readonly CollectionFolder[],
  deckId: number | null,
): CopySource {
  if (row.folderId === null) return DESK;
  const folder = folders.find((f) => f.id === row.folderId);
  if (!folder) return { kind: "otherDeck", deckName: row.folderName };
  if (folder.kind !== "deck") return DESK;
  return folder.deckId === deckId ? HERE : { kind: "otherDeck", deckName: folder.name };
}

/**
 * Whether the open deck's **live** list plays this card at all — the second half of what pressing
 * Add on a tile does, and **a separate axis rather than a fourth {@link CopySource} arm**
 * ([#358](https://github.com/Msgaihede/mtg-grimoire/issues/358)).
 *
 * ## Why not a fourth arm
 *
 * {@link CopySource} answers *where this copy is filed* — a fact about one `collection_entries`
 * row — and every one of its three answers is a different **press**: move it silently, refuse it,
 * or ask about the deck that loses a card. This asks *whether the deck's list has this card at
 * all*, which is a fact about the **oracle card and the deck**, and is true or false identically
 * of every copy the reader owns. Three things follow, and each of them breaks if the two are one
 * enum:
 *
 * - **`pickCopy` ranks `CopySource`.** A `notPlayed` arm would have to be filtered out of the pool
 *   the way `here` is — and a tile whose every candidate was filtered reads as `add === null`,
 *   which this tab already says in words as *"already in this deck"*. That sentence would then be
 *   printed over a card the deck has never held: the one refusal a reader cannot act on, because
 *   it tells them the opposite of what is wrong.
 * - **The two are simultaneously true and say different things.** A copy in Mono-Red Aggro that
 *   this deck does not play is both `otherDeck` and `notPlayed`, and only one sentence fits on a
 *   button. They are not two shades of one refusal: *"taking it from Mono-Red Aggro"* tells the
 *   reader what the press **costs**, and *"add it from the Card search tab first"* tells them
 *   **where to go instead**. An enum forces a rank between two facts that are about different
 *   things; two axes let the fence answer first and the cost answer after.
 * - **It is a fact per *card*, and `CopySource` is a fact per *row*.** Folding four copies of one
 *   printing gives one `CopySource` by a rule ({@link pickCopy}); folding them gives one
 *   `PlayState` by identity. Putting a per-card fact through a per-row rule is where a rule that
 *   is true of a card and false of its own copy comes from.
 *
 * ## The four answers
 *
 * `plays` is the only pressable one. **`unread` and `unreadable` are the fail-closed pair**, and
 * they are the reason this is four words rather than a boolean: an unanswered census is not
 * *"plays nothing"*, and a tile that is pressable for one frame and then greys is the failure —
 * `CollectionPage.tsx`'s `stepperByTile` argues this direction in full ("A filed tile is fenced
 * until the census has answered … the permissive reading would draw a control over a deck's copies
 * for exactly that window"). The two are kept apart because the *sentence* differs: a wall that is
 * waiting says so, and a wall that cannot find out says that instead — one is about to fix itself
 * and the other is not.
 *
 * **Nothing here is the fence.** `collection_alloc::NOT_IN_DECK` refuses the write in the same
 * words at the backend, and this is that refusal said *early*: it saves a round trip and puts the
 * route on the button, and it is deliberately not the only thing holding the rule.
 */
export type PlayState = "plays" | "notPlayed" | "unread" | "unreadable";

/**
 * As much of a tile as a play key is built from.
 *
 * **`id` is the printing** — `CopyTile.id` is `CollectionRow.cardId` under the wall's own name, and
 * `CopyTile.key` (the printing *and* its finish) is a different string that must never reach
 * {@link playKey}. Writing the shape down is what says which of a tile's three id-shaped fields
 * this rule is allowed to read; a mix-up here is silent, because every one of them is a `string`.
 */
export interface PlayableTile {
  id: string;
  oracleId: string | null;
}

/**
 * What {@link PlayState} a tile is in — pure over the census, so it is checkable as a truth table.
 *
 * **The match is on the oracle card and never on the printing**, through {@link playKey}, which
 * mirrors Rust's `coalesce(oracle_id, card_id)`: a reader whose deck plays the 2XM Lightning Bolt
 * and whose binder holds the Alpha one is holding a copy of a card their deck plays, and a
 * printing-exact test would grey exactly the tile this tab exists to press. The `card_id` fallback
 * is for an **orphan** — a copy whose printing has left `cards`, which therefore has no oracle id
 * on either side of the comparison — and it is the same fallback the deck row gets, so the two
 * still meet.
 *
 * **A census that has answered wins, and everything else is closed.** `isSuccess` is the only way
 * through: a query in flight, a query that failed, and a query that failed *after* answering are
 * three states with no trustworthy `plays` behind them, and the one thing they must not do is let
 * a press through.
 */
export function playStateFor(
  tile: PlayableTile,
  plays: ReadonlySet<string>,
  census: { isSuccess: boolean; isError: boolean },
): PlayState {
  if (census.isSuccess) {
    return plays.has(playKey({ oracleId: tile.oracleId, cardId: tile.id })) ? "plays" : "notPlayed";
  }
  return census.isError ? "unreadable" : "unread";
}

/** What a move is addressed by — the row it comes out of, the pile it lands in, and how many. */
export interface MoveRequest {
  row: CollectionRow;
  categoryId: number;
  quantity: number;
}

export interface CollectionSearchOptions {
  /**
   * The deck the copies are being moved **into**, or `null` while the editor has not answered.
   *
   * `null` disables the write rather than sending a bad id: `collection_to_deck` answers
   * `deck::GONE` for a deck that is not there, and a refusal the reader can do nothing about is
   * worse than a button that says why it cannot press.
   */
  deckId: number | null;
  /**
   * The format the list **opens** on — the deck's, handed down through the panel from
   * `DeckEditor`, where `spec.hasLegalityData` is the fence.
   *
   * A default and never a constraint, exactly as it is on the card-search tab: `null` and absent
   * both mean every format, which is the honest answer for a deck whose format has no legality
   * data to filter by (`casual` is every deck's birth format and matches no rows at all).
   */
  defaultFormat?: FormatFilterOption | null;
}

/**
 * The reader's own binder, filtered, with the one write that puts a copy of it into a deck.
 *
 * **Called from `CollectionSearchTab` and from nowhere else**, which is the same rule
 * `useCardSearch` follows one component over and for the same reason: each tab's data hook lives
 * in the component that mounts with that tab, so a reader browsing the wider search runs no
 * `collection_list` and a reader who never leaves their binder runs no `search_cards`. Hoisting
 * either into `DeckSearchPanel` runs both for everybody.
 *
 * **The write is here rather than in the component** because the invalidation is the part of it
 * that can be wrong in a way nothing on screen names — see {@link useCollectionSearch}'s `move`.
 */
export function useCollectionSearch({ deckId, defaultFormat }: CollectionSearchOptions) {
  const queryClient = useQueryClient();
  // Part of the payload and part of the key: the marketplace decides what a row's `unitPrice`
  // is, not merely how it is written.
  const { marketplace } = useMarketplace();
  const { folders } = useCollectionFolderList();
  /**
   * Every card the open deck's **live** list plays — the census {@link playStateFor} answers from,
   * and the whole of this tab's assign-only fence (issue #358).
   *
   * **Read here rather than threaded down from the editor, and that is a correctness decision
   * rather than a convenience.** `collection_to_deck` hardcodes `LIVE`, while the editor may be
   * drawing **Theory** — so `DeckEditor`'s own `deck.cards` is the wrong list half the time, and a
   * prop taken from it would grey the cards a reader can file and offer the ones they cannot. The
   * hook's key sits under `["decks"]`, which every deck write in the app already invalidates
   * (including {@link move} below), so adding the card on the **Card search** tab beside this one
   * un-greys its tile here with no reload — which is the whole of what makes the refusal's own
   * sentence actionable.
   */
  const deckPlays = useDeckPlays(deckId);
  const { plays } = deckPlays;
  // The two booleans rather than the query object: TanStack hands back a fresh result object every
  // render, so a `useCallback` closing over it would have a new identity on each one.
  const censusAnswered = deckPlays.query.isSuccess;
  const censusFailed = deckPlays.query.isError;

  const defaultFormatValue = defaultFormat?.value ?? "";
  const [text, setText] = useState("");
  const [format, setFormat] = useState(defaultFormatValue);
  /**
   * The default this filter is sitting on, so a **changed** deck format can be told from a reader
   * who happens to have picked the same key.
   *
   * `useCardSearch`'s adjust-state-during-render pattern, kept verbatim and for its measured
   * reason: an effect runs after the paint, so the column would draw one frame of the previous
   * deck's filter and fire a whole request for it. It is also what applies a default that
   * **arrives late** — `useFormatSpecs` is a query, so on the first deck of a session this mounts
   * before the seed has answered.
   */
  const [appliedDefaultFormat, setAppliedDefaultFormat] = useState(defaultFormatValue);
  if (defaultFormatValue !== appliedDefaultFormat) {
    setAppliedDefaultFormat(defaultFormatValue);
    setFormat(defaultFormatValue);
  }
  const defaultFormatLabel = defaultFormat?.label;
  const formatOptions = useMemo<readonly FormatFilterOption[]>(
    () => formatsWithDefault(defaultFormatValue, defaultFormatLabel),
    [defaultFormatValue, defaultFormatLabel],
  );
  const [allocation, setAllocation] = useState<Allocation>(DEFAULT_ALLOCATION);
  /**
   * The three filters this column grew on 2026-08-24, when the tab became a wall of art rather
   * than a list of text rows.
   *
   * **`CollectionQuery extends CardFilters`, so all three were already on the wire** — the tab
   * simply never sent them. `push_card_filters` emits `colors`, `mana_values` and `mana_x` for
   * every one of the three lists, which is what makes this state-only work rather than a
   * schema change.
   */
  const [colors, setColors] = useState<readonly ColorKey[]>([]);
  const [manaValues, setManaValues] = useState<readonly number[]>([]);
  const [manaX, setManaX] = useState(false);
  /**
   * The three filters this column grew on 2026-08-25, when the tab stopped drawing a row of its
   * own and started drawing `FilterBar` — the same control the card search beside it has.
   *
   * **Sets and rarities were already on the wire**, exactly as the three above were:
   * `CollectionQuery extends CardFilters` and `push_card_filters` emits both for all three lists,
   * so those two are state-only work. **The price band is not** — `CollectionQuery.priceMin` and
   * `priceMax` are new, and they are the entry's own per-finish price rather than the printing's
   * fallback chain, which is what makes a banded row a row the Price column agrees with. See
   * `collection::scope`.
   */
  const [sets, setSets] = useState<readonly string[]>([]);
  const [rarities, setRarities] = useState<readonly string[]>([]);
  const [priceMin, setPriceMin] = useState<number | undefined>(undefined);
  const [priceMax, setPriceMax] = useState<number | undefined>(undefined);
  /**
   * The order the wall is drawn in — **`[]` is the backend's own name order** rather than a fourth
   * option, which is why `sortSelection` reports `"name"` for it.
   *
   * There are no sortable headers in this column to build a `Custom…` state out of, so unlike
   * `useCollection` this never holds a spec its own select cannot show.
   */
  const [sort, setSort] = useState<SortSpec<CollectionSortKey>>([]);
  const [debouncedText, setDebouncedText] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedText(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  // Normalised to the app's own orders before they reach the wire or the key, exactly as
  // `useCollection` does it: a key built from the press order would miss the cache every time the
  // reader picked the same two colours in the other order.
  const colorsParam = colorParam(colors);
  const manaParam = manaValues.length > 0 ? [...manaValues].sort((a, b) => a - b) : undefined;
  // Sorted for the key's sake, like the mana values above: a picker's press order is not a fact
  // about the filter, and an unsorted array would be a second cache entry for one answer.
  const setsParam = sets.length > 0 ? [...sets].sort() : undefined;
  const raritiesParam = rarities.length > 0 ? [...rarities].sort() : undefined;

  const filters: Omit<CollectionQuery, "limit" | "offset"> = {
    // Blank strings are dropped rather than sent: the backend reads them as unset anyway, and
    // sending them would make the payload lie about intent.
    text: debouncedText || undefined,
    format: format || undefined,
    colors: colorsParam,
    sets: setsParam,
    rarities: raritiesParam,
    manaValues: manaParam,
    manaX: manaX || undefined,
    // Each end on its own, and **`undefined` rather than a substituted `0`/`Infinity`**: half a
    // band is one predicate, and a floor of zero would silently drop every copy the marketplace
    // cannot price — which is a filter the reader did not ask for. `collection::scope` pushes
    // exactly the ends that arrive.
    priceMin,
    priceMax,
    // **Sent on every request, `"all"` included.** It is a two-state control the reader can see,
    // so the payload says which state it is in rather than leaning on the backend's default for
    // one of them — `useCollection`'s "a value the backend would infer anyway is not put on the
    // wire" is the rule for a filter that is *off*, and neither of these two is off.
    allocation,
    // **Sent on every request and never a control**, which is where this parts company with the
    // field above it: `allocation` is a chip the reader can press, and this is a fact about what
    // the tab is for. `DEFAULT_ALLOCATION` already hides the copies a deck is holding because
    // this list answers *what can I build with today* rather than *what do I own* — and a drawer
    // the reader has set aside for a trade or a display case is not something this deck can be
    // built out of either, so it belongs on the same side of the same question. **`false` by
    // omission is what makes that safe to ask for**: the mirror and the export sweep page through
    // this same query for a whole-collection backup and must go on seeing every row, so the
    // narrowing is the caller's to request rather than the backend's to assume.
    //
    // Spec §4.2 gives `deck_theory::OWNED_SPARE_SQL` the same arm for the same reason — the
    // shopping list's *spare* count already drops a copy filed in a deck's group, and a locked
    // one is no more a copy a plan can count on. **Keep the two in step**: this panel offering a
    // copy the diff beside it has already written off is one question answered two ways.
    excludeLocked: true,
    marketplace: marketplace.id,
    // `undefined` rather than `[]`: an empty array is a sort the backend would have to test for,
    // and the absent field is what already means "your name order".
    sort: sort.length > 0 ? sort : undefined,
  };

  /**
   * The list's key — **`allocation` is in it, and that is the segment most easily forgotten**.
   * The two states are two different sets of rows over the same filters, so a key built without
   * it would serve the narrowed page under a widened control, instantly, against local SQLite,
   * with nothing on screen to notice.
   *
   * Under `["collection", …]` like every other read of this table, so the one
   * `invalidateQueries({ queryKey: ["collection"] })` every collection write in the app already
   * fires reaches this column too.
   *
   * **`excludeLocked` is deliberately not a segment**, and that is not the same omission: it is
   * a constant this tab sends on every request, so it narrows the one answer rather than telling
   * two of them apart. A key term for it would be the same string in every entry. What *can*
   * change under it is a folder being locked, and that is a write — `["collection"]` above.
   */
  const listKey = [
    "collection",
    "list",
    "deckSearch",
    debouncedText,
    format,
    // Every segment is a **string**, and the normalised one where there is a normal form: a key
    // holding an array compares by structure, so `["W","U"]` and `["U","W"]` would be two entries
    // for one answer. `colorParam` and the sort above have already put both in order.
    colorsParam ?? "",
    setsParam?.join(",") ?? "",
    raritiesParam?.join(",") ?? "",
    manaParam?.join(",") ?? "",
    manaX ? "x" : "",
    // `String(undefined)` is `"undefined"`, which is a segment as good as any other and cannot
    // collide with a number — where an empty string could be read as a bound of zero by anyone
    // debugging the key.
    String(priceMin),
    String(priceMax),
    sort.map((t) => `${t.key}:${t.dir}`).join(","),
    allocation,
    marketplace.id,
  ];

  const query = useInfiniteQuery({
    queryKey: listKey,
    queryFn: ({ pageParam }) =>
      ipc.collectionList({ ...filters, limit: DECK_COLLECTION_PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (_last, pages) => nextOffset(pages),
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);

  const sourceOf = useCallback(
    (row: CollectionRow) => copySource(row, folders, deckId),
    [folders, deckId],
  );

  /**
   * Whether this deck's live list plays this tile's card — {@link sourceOf}'s peer on the other
   * axis, and held still for the same reason.
   *
   * **Deliberately not folded into `sourceOf`, and therefore not into `foldCopies`.** The fold's
   * job is to pick *which copy* a press moves ({@link pickCopy}), and this answer is identical for
   * every copy behind a tile — see {@link PlayState} for the three ways merging the two goes
   * wrong. The wall's tiles are memoised off `sourceOf`, so keeping this out of it also means the
   * census landing re-renders the buttons rather than refolding every row.
   */
  const playStateOf = useCallback(
    (tile: PlayableTile) =>
      playStateFor(tile, plays, { isSuccess: censusAnswered, isError: censusFailed }),
    [plays, censusAnswered, censusFailed],
  );

  /**
   * Put copies of one collection row into this deck.
   *
   * **Deliberately not optimistic, and that is a decision rather than an omission.** A move is one
   * deliberate press on a row the reader has just read, so there is no held key to make responsive
   * and nothing to gain from drawing an answer before there is one — and there is a great deal to
   * lose, because the write can *split* a row (`take_copies` leaves what it did not take behind)
   * and `MoveOutcome.quantity` is the number that actually moved rather than the one that was
   * asked for. A patch written from the argument would disagree with SQLite in exactly the cases
   * that matter.
   *
   * **Both roots, on success and on refusal.** `lib/query.ts` caches 30 s and this list's observer
   * is mounted, so a query merely *marked* stale is never refetched — that is the ghost row PR 2
   * shipped: a write removed a row in SQLite and left it on screen with the header disagreeing
   * beside it. `invalidateQueries` matches by key **prefix**, so `["collection"]` reaches this
   * list, the collection page's list and summary, the folder census and the per-folder subtotals
   * together, and `["decks"]` reaches every deck's detail — which has to be every deck rather than
   * this one, because a copy taken out of another deck's group is one card off **that** deck's
   * live list.
   *
   * A refusal takes the same pair for `useCollectionFolders`' reason: the usual refusal is a row
   * something else has already moved or deleted, so the list on screen is the thing that is wrong.
   */
  const move = useMutation<MoveOutcome, unknown, MoveRequest>({
    mutationFn: ({ row, categoryId, quantity }) => {
      if (deckId === null) return Promise.reject(new Error(NO_DECK));
      // The id arm of {@link DeckPile}: this tab always has a pile in hand — the reader picked
      // one — so there is no name for the backend to find-or-create.
      return ipc.collectionToDeck(row.id, deckId, { id: categoryId }, quantity);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["collection"] });
      void queryClient.invalidateQueries({ queryKey: ["decks"] });
    },
  });

  return {
    text,
    setText,
    format,
    setFormat,
    /** The rows the format picker offers — {@link formatsWithDefault}, memoised on the two
     *  strings for the reason `useCardSearch` states: every caller builds `defaultFormat` inline,
     *  so a dependency on the object would rebuild the list on every keystroke. */
    formats: formatOptions,
    colors,
    /** `toggleColor` rather than a plain `toggleIn`, so **C excludes the five and the five exclude
     *  C** — colourless is not a sixth colour and the search's own rule is the one to keep. */
    toggleColor: (key: ColorKey) => setColors((picked) => toggleColor(picked, key)),
    sets,
    toggleSet: (code: string) => setSets((picked) => toggleIn(picked, code)),
    rarities,
    toggleRarity: (rarity: string) => setRarities((picked) => toggleIn(picked, rarity)),
    priceMin,
    priceMax,
    /** Both ends at once, because {@link PriceRange} moves them together — a slider drag can
     *  change either, and two setters would be two renders and two query keys for one gesture. */
    setPriceRange: (min: number | undefined, max: number | undefined) => {
      setPriceMin(min);
      setPriceMax(max);
    },
    manaValues,
    toggleManaValue: (value: number) => setManaValues((picked) => toggleIn(picked, value)),
    manaX,
    toggleManaX: () => setManaX((on) => !on),
    /**
     * **No facets, and that is a fact about this list rather than a gap.** `facets.ts` reads
     * `undefined` as "we do not know", which leaves every chip live and nothing greyed — the
     * honest state here, because `collection_list` has no facet command behind it the way
     * `search_cards` does. Counting would be a second query per keystroke over the reader's whole
     * binder, for a row of numbers beside a list already on screen.
     */
    facets: undefined,
    /** Which marketplace the price band and every figure on a tile are quoted from. `FilterBar`
     *  captions the band with its currency, so this is what keeps `Price (USD)` from standing
     *  over a filter in euros. */
    marketplace,
    sort,
    setSortKey: (key: CollectionSortKey) => setSort([{ key, dir: COLLECTION_FIRST_DIR[key] }]),
    /**
     * Turn the first term over — the same control the card search's arrow drives, and the first
     * term because that is the one the select owns.
     *
     * **An empty spec is written out rather than left alone, which is where this parts company
     * with the search's twin.** There the empty spec is `Best match`, which has no direction, so
     * that arrow is `disabled` and a no-op is unreachable. Here the empty spec *is* name order —
     * `sortSelection` below reports `name` for it and never `""` — so the button is drawn live
     * and pointing up, and a no-op would be a control that visibly does nothing. Flipping it
     * materialises the order the list was already in, with its direction reversed.
     */
    flipSortDir: () =>
      setSort((spec) =>
        spec.length === 0
          ? [{ key: "name", dir: COLLECTION_FIRST_DIR.name === "asc" ? "desc" : "asc" }]
          : spec.map((term, at) =>
              at === 0 ? { key: term.key, dir: term.dir === "asc" ? "desc" : "asc" } : term,
            ),
      ),
    /** Which row the sort select shows. `[]` is the backend's name order, which is what the
     *  `name` option asks for — so the control never sits on a value it has no option for. */
    sortSelection: (sort.length === 0 ? "name" : sort[0].key) as CollectionSortKey,
    /**
     * Which way the list runs — **never `undefined`, which is where this parts company with the
     * card search's twin.**
     *
     * An empty spec is this list's name order rather than a ranking, so it has a direction and
     * that direction is `COLLECTION_FIRST_DIR.name`. The search's empty spec is `Best match`,
     * which has none, and its arrow greys there; greying this one would grey a button that
     * works, on a list whose order is on screen in front of the reader.
     */
    sortDir: sort.length === 0 ? COLLECTION_FIRST_DIR.name : sort[0].dir,
    /**
     * How many filters are narrowing the wall — the number in `Reset all`.
     *
     * **`allocation` is deliberately not counted, and it is the one judgement call here.** The
     * chip is pressed by default, so counting it would open every deck showing `Reset all 1` for
     * a state the reader has not touched — and `resetAll` leaves it pressed for the same reason:
     * "the copies no deck is holding" is what this tab *is*, not a filter laid over it.
     *
     * **The search's `activeFilterCount` and no longer the collection page's** (2026-08-25). This
     * tab draws `FilterBar`'s tray now, so its kinds *are* the search's kinds — set, format,
     * colour, mana value, rarity, price — and counting them against the definition the tray's own
     * cells come from is what keeps the badge and the cells from drifting apart. The collection
     * page's count is over a longer row (finishes, conditions, needs-review) this column has never
     * offered a control for, and passing three empty arrays to it was a shape that only worked as
     * long as nothing here grew.
     *
     * `owned` is `undefined` for the reason the tray has no Owned cell: every row here is a copy
     * the reader has, so it is not a question this list can ask.
     */
    activeCount: activeFilterCount({
      text,
      format,
      colors,
      sets,
      manaValues,
      manaX,
      owned: undefined,
      rarities,
      priceMin,
      priceMax,
    }),
    resetAll: () => {
      setText("");
      setFormat("");
      setColors([]);
      setSets([]);
      setRarities([]);
      setPriceMin(undefined);
      setPriceMax(undefined);
      setManaValues([]);
      setManaX(false);
      setSort([]);
    },
    /** Which copies the list is asking for. {@link DEFAULT_ALLOCATION} until the reader presses. */
    allocation,
    setAllocation,
    /** Every folder there is, so a row can be placed. See {@link copySource}. */
    folders,
    /** Where this row's copies are filed, in the three terms the Add button branches on.
     *
     *  **Held still**, because the wall's fold is a `useMemo` over it: a fresh arrow every render
     *  would refold every tile on every keystroke. */
    sourceOf,
    /** Whether the deck plays this tile's card at all, in the four terms the Add button branches
     *  on — this tab is **assign-only** and {@link PlayState} is where that is argued. Held still
     *  for {@link sourceOf}'s reason. */
    playStateOf,
    query,
    rows,
    /** Rows matching the filters, counted in full. `0` until the first page answers.
     *
     *  **A count of *rows*, which since the wall folds them is not the number of tiles drawn** —
     *  one printing held in two finishes is two rows and one tile. The caption counts what is on
     *  screen for that reason; this stays because it is the backend's own answer and the thing a
     *  paging decision is made against. */
    total: query.data?.pages[0]?.total ?? 0,
    /** The list's key as one string, for `CardGrid`'s `listKey` — a new search scrolls the wall
     *  back to the top rather than leaving the reader wherever the last one was. */
    queryKeyString: JSON.stringify(listKey),
    move,
  };
}

/** What a press with no deck behind it is refused with. Unreachable from the editor, which
 *  always has a deck — it is the fence for a story or a test mounting the tab bare. **Not
 *  exported**: nothing outside this file has ever read it, and an export nothing imports is a
 *  sentence the next reader goes looking for a second copy of. */
const NO_DECK = "There is no deck to add to";

export type CollectionSearch = ReturnType<typeof useCollectionSearch>;
