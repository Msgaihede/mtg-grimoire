import { useEffect, useMemo, useState } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { nextOffset } from "@/features/collection/useCollection";
import { useCollectionFolderList } from "@/features/collection/useCollectionFolders";
import { DEBOUNCE_MS, type FormatFilterOption } from "@/features/search/useCardSearch";
import {
  ipc,
  type CollectionFolder,
  type CollectionQuery,
  type CollectionRow,
  type MoveOutcome,
} from "@/lib/ipc";
import { useMarketplace } from "@/lib/useMarketplace";

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
  const [allocation, setAllocation] = useState<Allocation>(DEFAULT_ALLOCATION);
  const [debouncedText, setDebouncedText] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedText(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const filters: Omit<CollectionQuery, "limit" | "offset"> = {
    // Blank strings are dropped rather than sent: the backend reads them as unset anyway, and
    // sending them would make the payload lie about intent.
    text: debouncedText || undefined,
    format: format || undefined,
    // **Sent on every request, `"all"` included.** It is a two-state control the reader can see,
    // so the payload says which state it is in rather than leaning on the backend's default for
    // one of them — `useCollection`'s "a value the backend would infer anyway is not put on the
    // wire" is the rule for a filter that is *off*, and neither of these two is off.
    allocation,
    marketplace: marketplace.id,
    // Name order, which is what an empty sort means on the wire. There is no sort control in
    // this column: it is a list you scan for a card you already have in mind, and the alphabet
    // is the one order that makes scanning possible.
    sort: undefined,
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
   */
  const listKey = [
    "collection",
    "list",
    "deckSearch",
    debouncedText,
    format,
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
    /** Which copies the list is asking for. {@link DEFAULT_ALLOCATION} until the reader presses. */
    allocation,
    setAllocation,
    /** Every folder there is, so a row can be placed. See {@link copySource}. */
    folders,
    /** Where this row's copies are filed, in the three terms the Add button branches on. */
    sourceOf: (row: CollectionRow) => copySource(row, folders, deckId),
    query,
    rows,
    /** Rows matching the filters, counted in full. `0` until the first page answers. */
    total: query.data?.pages[0]?.total ?? 0,
    move,
  };
}

/** What a press with no deck behind it is refused with. Unreachable from the editor, which
 *  always has a deck — it is the fence for a story or a test mounting the tab bare. **Not
 *  exported**: nothing outside this file has ever read it, and an export nothing imports is a
 *  sentence the next reader goes looking for a second copy of. */
const NO_DECK = "There is no deck to add to";

export type CollectionSearch = ReturnType<typeof useCollectionSearch>;
