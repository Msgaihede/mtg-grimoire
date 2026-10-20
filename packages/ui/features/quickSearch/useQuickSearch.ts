import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCollectionFolderList } from "@/features/collection/useCollectionFolders";
import { quickSearchRecentCardsKey } from "@/features/home/keys";
import { DEBOUNCE_MS, searchTerms } from "@/features/search/useCardSearch";
import { panelsOf } from "@/features/settings/nav";
import { useWishlistFolderList } from "@/features/wishlist/useWishlistFolders";
import { editionHas, useEdition } from "@/lib/edition";
import { ipc } from "@/lib/ipc";
import {
  GROUP_LIMIT,
  cardItems,
  corpusItems,
  deckItems,
  folderItems,
  folderPath,
  groupsOf,
  settingItems,
  type FolderLike,
  type QuickGroup,
} from "./results";

/** What a list search asks for, over the page size: a handful more than a group draws, because
 *  rows merge (one per printing per folder) and name matches are sorted above the rest. */
const CARD_FETCH = GROUP_LIMIT * 3;

const NOT_SORTED = "Not sorted";
const WISHLIST_ROOT = "Wishlist";

/**
 * The quick search's rows for `text` — every source read only while the panel is `open`, and
 * answered as {@link QuickGroup}s in the issue's order.
 *
 * **Three sources are lists the app already caches** (the decks, and the three cabinets' folders),
 * read under their pages' own keys and filtered here as the reader types, so they answer on the
 * keystroke. **Three are searches** (the collection, the wishlist, the corpus), debounced like
 * every search box in the app and keyed under their roots, so a write that invalidates the
 * collection refreshes what this panel shows of it.
 *
 * **The All cards group waits for both lists.** Each search answers with the text it was asked,
 * and the corpus is drawn only once the collection and the wishlist have answered that same text
 * (or failed): drawn first, a corpus row would sit where a matching collection row is about to
 * arrive and be pushed down by it — for a moment, the corpus above the reader's own copy, which is
 * the one order the issue rules out.
 */
export function useQuickSearch(
  text: string,
  open: boolean,
): { groups: QuickGroup[]; busy: boolean } {
  const edition = useEdition();
  const hasDecks = editionHas(edition, "decks");
  const hasCollection = editionHas(edition, "collection");
  const hasWishlist = editionHas(edition, "wishlist");
  const hasSearch = editionHas(edition, "search");
  const hasSettings = editionHas(edition, "settings");

  const [debounced, setDebounced] = useState(text);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const typed = debounced !== "";

  // `useDecks`' and `useDeckFolders`' keys and calls verbatim, so the gallery and this panel share
  // one cache entry and one invalidation.
  const decks = useQuery({
    queryKey: ["decks", "list"],
    queryFn: () => ipc.deckList(),
    enabled: open && hasDecks,
  });
  const deckFolders = useQuery({
    queryKey: ["decks", "folders"],
    queryFn: () => ipc.deckFolderList(),
    enabled: open && hasDecks,
  });
  const collectionFolders = useCollectionFolderList({ enabled: open && hasCollection });
  const wishlistFolders = useWishlistFolderList({ enabled: open && hasWishlist });

  // With nothing typed, each list's newest rows — the recency a copy record keeps.
  const collection = useQuery({
    queryKey: ["collection", "quickSearch", debounced],
    queryFn: async () => ({
      text: debounced,
      rows: (
        await ipc.collectionList({
          ...searchTerms(debounced),
          sort: typed ? undefined : [{ key: "added", dir: "desc" }],
          limit: typed ? CARD_FETCH : GROUP_LIMIT,
          offset: 0,
        })
      ).items,
    }),
    enabled: open && hasCollection,
    placeholderData: keepPreviousData,
  });
  const wishlist = useQuery({
    queryKey: ["wishlist", "quickSearch", debounced],
    queryFn: async () => ({
      text: debounced,
      rows: (
        await ipc.wishlistList({
          ...searchTerms(debounced),
          flatten: true,
          sort: typed ? undefined : [{ key: "added", dir: "desc" }],
          limit: typed ? CARD_FETCH : GROUP_LIMIT,
          offset: 0,
        })
      ).items,
    }),
    enabled: open && hasWishlist,
    placeholderData: keepPreviousData,
  });
  // Typed, the corpus's own search — one row per card, QuickAdd's request. Untyped, the cards the
  // reader opened last, under the recently viewed root so the card modal's record refreshes this
  // and the home widget alike — but in an entry of its own, since the two cache different shapes.
  const corpus = useQuery({
    queryKey: typed ? ["quickSearch", "cards", debounced] : quickSearchRecentCardsKey(GROUP_LIMIT),
    queryFn: async () =>
      typed
        ? {
            text: debounced,
            cards: (
              await ipc.searchCards({
                ...searchTerms(debounced),
                collapse: true,
                limit: CARD_FETCH,
                offset: 0,
              })
            ).items.map((c) => ({ cardId: c.id, name: c.name, setCode: c.setCode })),
          }
        : { text: "", cards: await ipc.recentCards(GROUP_LIMIT) },
    enabled: open && hasSearch,
    placeholderData: keepPreviousData,
  });

  const settledOn = (q: { isError: boolean; data?: { text: string } }, on: boolean) =>
    !on || q.isError || q.data?.text === debounced;
  const corpusReady =
    settledOn(collection, hasCollection) &&
    settledOn(wishlist, hasWishlist) &&
    corpus.data?.text === debounced;

  const panels = useMemo(() => panelsOf(edition.settings), [edition.settings]);

  const groups = useMemo(() => {
    const cFolders = collectionFolders.folders;
    const wFolders = wishlistFolders.folders;
    const nameIn = (folders: readonly FolderLike[], root: string) => (id: number | null) =>
      id === null ? root : folderPath(folders, id) || root;
    return groupsOf({
      decks: hasDecks ? deckItems(decks.data ?? [], deckFolders.data ?? [], text) : [],
      collection: hasCollection
        ? [
            ...folderItems(cFolders, text, (f) => ({
              key: `collectionFolder:${String(f.id)}`,
              target: { kind: "folder", scope: "collection", id: f.id },
            })).slice(0, GROUP_LIMIT),
            ...cardItems(
              "collection",
              collection.data?.rows ?? [],
              debounced,
              nameIn(cFolders, NOT_SORTED),
            ),
          ]
        : [],
      wishlist: hasWishlist
        ? [
            ...folderItems(wFolders, text, (f) => ({
              key: `wishlistFolder:${String(f.id)}`,
              target: { kind: "folder", scope: "wishlist", id: f.id },
            })).slice(0, GROUP_LIMIT),
            ...cardItems(
              "wishlist",
              wishlist.data?.rows ?? [],
              debounced,
              nameIn(wFolders, WISHLIST_ROOT),
            ),
          ]
        : [],
      cards: hasSearch && corpusReady ? corpusItems(corpus.data?.cards ?? [], debounced) : [],
      settings: hasSettings ? settingItems(panels, text) : [],
    });
  }, [
    text,
    debounced,
    hasDecks,
    hasCollection,
    hasWishlist,
    hasSearch,
    hasSettings,
    decks.data,
    deckFolders.data,
    collectionFolders.folders,
    wishlistFolders.folders,
    collection.data,
    wishlist.data,
    corpus.data,
    corpusReady,
    panels,
  ]);

  const busy =
    text.trim() !== debounced || collection.isFetching || wishlist.isFetching || corpus.isFetching;
  return { groups, busy };
}
