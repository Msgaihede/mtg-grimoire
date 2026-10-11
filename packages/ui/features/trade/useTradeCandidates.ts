import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCollectionFolderList } from "@/features/collection/useCollectionFolders";
import { DEBOUNCE_MS, searchTerms } from "@/features/search/useCardSearch";
import { isFinish, parseFinishes, type Finish } from "@/lib/finish";
import { ipc, ipcError } from "@/lib/ipc";
import type { CardSummary, CollectionFolder, CollectionRow, TradeSource } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";

/** Where a side's add field looks: the reader's own cards, or every card there is. */
export type TradeScope = "collection" | "all";

/**
 * One card a side could take: a printing, in one finish, at one price — and, for the reader's own
 * copies, where those copies sit.
 */
export interface TradeCandidate {
  /** Stable across keystrokes: the printing and the finish, and the deck for a deck's copies. */
  key: string;
  cardId: string;
  oracleId: string | null;
  name: string;
  setCode: string;
  collectorNumber: string;
  rarity: string | null;
  finish: Finish;
  /** At 100%, in the marketplace the caller named. `null` is "no price", never zero. */
  unitPrice: number | null;
  /**
   * Collection scope: copies held in this printing and finish **in this row's place** — outside
   * every deck, or in the one deck the row names. All-cards scope: null.
   */
  owned: number | null;
  /**
   * `collection` for the collection scope, `search` otherwise. **A deck's copies are `collection`
   * too**: the backend has no third word, and it needs none — a line names a printing and a
   * finish, and where its copies will come from is the line's own facts (`fromDecks`), not this.
   */
  source: TradeSource;
  /**
   * Where the copies this row counts sit: `collection` is anywhere outside a deck, `deck` is one
   * deck's group, and `null` is the all-cards scope, whose rows are nobody's copies.
   *
   * **The two are never one list.** A copy that comes out of a deck leaves that deck a card
   * short, so every surface draws `deck` rows in a section of their own, in the destructive
   * colour, under the deck's name.
   */
  place: "collection" | "deck" | null;
  /** The deck a `deck` row's copies are filed in. `null` for every other row. */
  deckName: string | null;
}

/** What the add field has to draw for the text in it. */
export interface TradeCandidates {
  /**
   * The rows a press may take without costing anything it did not say: the reader's copies outside
   * their decks, or — in the all-cards scope — every card.
   */
  rows: TradeCandidate[];
  /**
   * The reader's copies filed **in a deck's group**, one row a printing, finish and deck. Always
   * empty in the all-cards scope. Never folded into {@link rows}.
   */
  deckRows: TradeCandidate[];
  pending: boolean;
  error: string | null;
}

/**
 * The most rows the field offers at once — **in each of its two sections**, so a collection search
 * can draw this many copies outside the reader's decks and this many inside them.
 *
 * A list under a field, not a results page: every row it offers is a row of the side's own list
 * it covers, and a ninth match is reached by typing one more letter, which is quicker than
 * scrolling a popup would be. (The desktop's list does scroll — two full sections are taller than
 * a short window — but that is a floor under it, not a way to browse.)
 */
export const CANDIDATE_LIMIT = 8;

/**
 * How many collection **rows** are read to make those eight.
 *
 * The collection's grain is far finer than a candidate's — one printing in one finish can be five
 * rows, one per condition, language and folder — so eight rows asked for is sometimes one card.
 * Sixty folds to eight for anything short of a playset in every binder, and it is one small read.
 */
const COLLECTION_ROWS = 60;

const NO_ROWS: TradeCandidate[] = [];
const NO_FOLDERS: CollectionFolder[] = [];

/**
 * The cards a side's add field offers for what has been typed into it.
 *
 * **Two reads behind one shape, and the shape is the point.** A reader adding to their own side
 * is mostly picking a card they hold, so that scope reads the collection and answers a printing
 * *in the finish they hold it in* with how many copies there are. Anything else — their side, or
 * the reader's own with *All cards* pressed — reads the card search, one row per card. Both come
 * back as {@link TradeCandidate}, so the list under the field and the phone's sheet draw one kind
 * of row and add it with one call.
 *
 * **Scryfall's syntax, as in every other card box.** The text goes through {@link searchTerms},
 * so `t:goblin` narrows here as it does on the search page and a tag term folds back into the
 * words rather than being dropped.
 *
 * **The collection scope asks twice, because it answers two lists.** A finish can take a copy
 * from outside the reader's decks and, once those run out, from inside one — and the second costs
 * a deck a card, so the two are never drawn as one list.
 *
 * - {@link TradeCandidates.rows} is the first read: not the copies a deck is holding
 *   (`allocation: "unallocated"`) and not the ones in a locked folder. That is the question a
 *   line's `owned` answers, and it keeps "3 owned" under the field from promising a card the
 *   finish step will then leave alone. The one thing the query cannot say is *Recently removed*,
 *   which is neither a deck's folder nor the reader's — so those rows are dropped here, by kind,
 *   once the folder list is in.
 * - {@link TradeCandidates.deckRows} is the second: the collection read at the deck groups and
 *   nowhere else (`shelves`, every folder of kind `deck`). That is a line's `ownedInDecks`. The
 *   collection has no word for "only what a deck holds" — `allocation` can leave decks out and
 *   cannot ask for them alone — and naming the folders is the same question asked exactly. So this
 *   read waits for the folder list, and a reader with no deck asks nothing.
 *
 * **Neither list offers a proxy**, which a trade never counts as the card and never hands over.
 *
 * **Debounced by the app's own 300ms**, and an empty field asks nothing and answers nothing at
 * once: `keepPreviousData` would otherwise leave the last search's rows hanging under a box the
 * reader has cleared.
 */
export function useTradeCandidates(
  scope: TradeScope,
  text: string,
  marketplace: MarketplaceId,
): TradeCandidates {
  const asked = text.trim();
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(asked), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [asked]);

  const { folders, query: folderList } = useCollectionFolderList();
  const deckFolders = useMemo(() => {
    const decks = folders.filter((folder) => folder.kind === "deck");
    return decks.length > 0 ? decks : NO_FOLDERS;
  }, [folders]);
  /** In id order, so the key is the same key whatever order the cabinet lists its folders in. */
  const deckShelves = useMemo(
    () => deckFolders.map((folder) => folder.id).sort((a, b) => a - b),
    [deckFolders],
  );
  const decksAsked = scope === "collection" && deckShelves.length > 0;

  const collection = useQuery({
    // Under `["collection"]`, so a write that moves a copy — a finish does, and so does every
    // collection page — refreshes the count this row prints.
    queryKey: ["collection", "tradeCandidates", marketplace, debounced],
    queryFn: () =>
      ipc.collectionList({
        ...searchTerms(debounced),
        allocation: "unallocated",
        excludeLocked: true,
        marketplace,
        limit: COLLECTION_ROWS,
        offset: 0,
      }),
    enabled: scope === "collection" && debounced.length > 0,
    placeholderData: keepPreviousData,
  });

  const decks = useQuery({
    // Under `["collection"]` for the first read's reason, and keyed by the shelves it names: a
    // deck made or deleted while the field is up is a different question.
    queryKey: ["collection", "tradeCandidates", "decks", marketplace, debounced, deckShelves],
    queryFn: () =>
      ipc.collectionList({
        ...searchTerms(debounced),
        // The deck groups and nothing else. A shelves list replaces every other folder question,
        // the lock included — and a lock is never asked of a deck's group.
        shelves: deckShelves,
        marketplace,
        limit: COLLECTION_ROWS,
        offset: 0,
      }),
    enabled: decksAsked && debounced.length > 0,
    placeholderData: keepPreviousData,
  });

  const cards = useQuery({
    // Under `["cards"]` and deliberately **not** under `["cards", "search"]`: that root is patched
    // in place after every owned write (`@/lib/searchMarks`), by code that expects an infinite
    // query's pages there.
    queryKey: ["cards", "tradeCandidates", marketplace, debounced],
    queryFn: () =>
      ipc.searchCards({
        ...searchTerms(debounced),
        collapse: true,
        marketplace,
        limit: CANDIDATE_LIMIT,
        offset: 0,
      }),
    enabled: scope === "all" && debounced.length > 0,
    placeholderData: keepPreviousData,
  });

  const query = scope === "collection" ? collection : cards;

  const rows = useMemo(() => {
    if (asked.length === 0) return NO_ROWS;
    if (scope === "collection") {
      return collection.data ? fromCollection(collection.data.items, folders, asked) : NO_ROWS;
    }
    return cards.data ? cards.data.items.map(fromSearch) : NO_ROWS;
  }, [asked, scope, collection.data, cards.data, folders]);

  const deckRows = useMemo(() => {
    if (asked.length === 0 || !decksAsked || !decks.data) return NO_ROWS;
    const found = fromDecks(decks.data.items, deckFolders, asked);
    return found.length > 0 ? found : NO_ROWS;
  }, [asked, decksAsked, decks.data, deckFolders]);

  const waiting = (read: { isPending: boolean; isPlaceholderData: boolean }) =>
    read.isPending || read.isPlaceholderData;

  return {
    rows,
    deckRows,
    // The whole wait, the debounce included: for those 300ms the rows on screen answer an older
    // question, and a caller that adds the top row on Enter has to be able to tell. In the
    // collection scope that is both reads and the folder list the second one waits on — until
    // all three are in, "nothing matches" is not known and neither is which row is the top one.
    pending:
      asked.length > 0 &&
      (asked !== debounced ||
        waiting(query) ||
        (scope === "collection" && (folderList.isPending || (decksAsked && waiting(decks))))),
    error:
      asked.length === 0
        ? null
        : query.isError
          ? ipcError(query.error)
          : decksAsked && decks.isError
            ? ipcError(decks.error)
            : null,
  };
}

/**
 * Whether a collection row is a copy a trade could ever take: a named printing in a finish this
 * app knows, at least one of it, and **not a proxy** — a stand-in for the card is not the card
 * that was agreed across the table, so the backend neither counts one as owned nor hands one over.
 */
function tradeable(row: CollectionRow): row is CollectionRow & { name: string; finish: Finish } {
  return row.name !== null && isFinish(row.finish) && row.quantity > 0 && !row.proxy;
}

/**
 * Candidates in the order a reader typing a name expects them, cut to the limit.
 *
 * **A name match comes before a rules-text match.** The collection's `text` is the search's — a
 * prefix match over name, type line and rules text — and it is ordered by name, so `bolt` puts a
 * creature that merely *mentions* a bolt above Lightning Bolt. The words typed here are almost
 * always a name.
 */
function ranked(rows: readonly TradeCandidate[], asked: string): TradeCandidate[] {
  const needle = asked.toLowerCase();
  const rank = (name: string): number => {
    const at = name.toLowerCase().indexOf(needle);
    return at === 0 ? 0 : at > 0 ? 1 : 2;
  };
  return (
    [...rows]
      // `sort` is stable, so within a rank the backend's own order stands.
      .sort((a, b) => rank(a.name) - rank(b.name))
      .slice(0, CANDIDATE_LIMIT)
  );
}

/**
 * Collection rows folded to one candidate per printing and finish, names first ({@link ranked}).
 *
 * **The fold is the trade's own grain.** A side's line is a printing in a finish; the condition a
 * copy is in, its language and the folder it sits in are the collection's business, and a list
 * that offered "Boros Charm, NM" and "Boros Charm, LP" as two cards would add two lines that fold
 * into one the moment they land.
 */
function fromCollection(
  items: readonly CollectionRow[],
  folders: readonly CollectionFolder[],
  asked: string,
): TradeCandidate[] {
  const takeable = new Set(folders.filter((f) => f.kind === "user").map((f) => f.id));
  const byKey = new Map<string, TradeCandidate>();
  for (const row of items) {
    if (!tradeable(row)) continue;
    // Until the folder list answers every filed row is kept: dropping them would empty the list
    // for a reader whose whole collection is in binders, for the length of one read.
    if (row.folderId !== null && folders.length > 0 && !takeable.has(row.folderId)) continue;
    const key = `${row.cardId}:${row.finish}`;
    const held = byKey.get(key);
    if (held) {
      held.owned = (held.owned ?? 0) + row.quantity;
      continue;
    }
    byKey.set(key, {
      key,
      cardId: row.cardId,
      oracleId: row.oracleId,
      name: row.name,
      setCode: row.setCode,
      collectorNumber: row.collectorNumber,
      rarity: row.rarity,
      finish: row.finish,
      unitPrice: row.unitPrice,
      owned: row.quantity,
      source: "collection",
      place: "collection",
      deckName: null,
    });
  }
  return ranked([...byKey.values()], asked);
}

/**
 * The rows a deck is holding, folded to one candidate per printing, finish **and deck**.
 *
 * **The deck stays in the grain**, where {@link fromCollection} folds every folder away: which
 * binder a spare copy sits in is no part of a trade, and which deck a copy would be pulled out of
 * is the whole of what the reader has to be told. Two decks holding the same Sol Ring are two
 * rows, each under its own deck's name.
 *
 * **Kept by the folder's kind, not by having been asked for.** The read names the deck groups, so
 * every row it answers should be in one — and a row that is not, because a folder changed kind
 * between the two reads or an answer was not the one asked for, is dropped rather than offered
 * under a deck's heading. *Recently removed* is never a deck, so it can never reach this list.
 *
 * `source` is still `collection`: see {@link TradeCandidate.source}.
 */
function fromDecks(
  items: readonly CollectionRow[],
  deckFolders: readonly CollectionFolder[],
  asked: string,
): TradeCandidate[] {
  const decks = new Map(deckFolders.map((folder) => [folder.id, folder]));
  const byKey = new Map<string, TradeCandidate>();
  for (const row of items) {
    if (!tradeable(row) || row.folderId === null) continue;
    const deck = decks.get(row.folderId);
    if (deck === undefined) continue;
    const key = `${row.cardId}:${row.finish}:deck:${deck.id}`;
    const held = byKey.get(key);
    if (held) {
      held.owned = (held.owned ?? 0) + row.quantity;
      continue;
    }
    byKey.set(key, {
      key,
      cardId: row.cardId,
      oracleId: row.oracleId,
      name: row.name,
      setCode: row.setCode,
      collectorNumber: row.collectorNumber,
      rarity: row.rarity,
      finish: row.finish,
      unitPrice: row.unitPrice,
      owned: row.quantity,
      source: "collection",
      place: "deck",
      // The group carries its deck's name — renaming the deck renames it — and the row's own
      // copy of that name is the one read with the cards.
      deckName: row.folderName ?? deck.name,
    });
  }
  return ranked([...byKey.values()], asked);
}

/**
 * One search row as a candidate: the card's representative printing, in its first listed finish.
 *
 * **The first finish, because that is the one {@link CardSummary.price} is quoted for.** The
 * search's price is a fallback chain across finishes in the order a printing lists them, so a
 * foil-only printing's figure is its foil's — and a candidate that said `nonfoil` beside it would
 * add a line the backend then refuses, at a price that was never that finish's. A printing whose
 * finishes are unknown is offered as the regular copy, which is what a price is assumed to be.
 */
function fromSearch(card: CardSummary): TradeCandidate {
  const finish = parseFinishes(card.finishes)[0] ?? "nonfoil";
  return {
    key: `${card.id}:${finish}`,
    cardId: card.id,
    oracleId: card.oracleId,
    name: card.name,
    setCode: card.setCode,
    collectorNumber: card.collectorNumber,
    rarity: card.rarity,
    finish,
    unitPrice: card.price,
    owned: null,
    source: "search",
    place: null,
    deckName: null,
  };
}
