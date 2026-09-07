import { useCallback, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";

/**
 * Where the reader's answers about the docked search columns are kept for the life of the window.
 *
 * **One key for all three surfaces, not one each**, which is the whole of what this module changed
 * on 2026-09-07: the row behind it is a map, so a second query key would be a second observer of
 * the same fact and a second prefetch to fill it.
 *
 * Exported for `PRINTING_GROUP_BY_KEY`'s reason: a test or a story that wants a page to open with
 * its column already shut seeds the cache rather than mocking the command, and a key spelled twice
 * is a key that drifts.
 */
export const SEARCH_OPEN_KEY = ["searchOpen"];

/**
 * The surfaces that have a docked card-search column, and therefore the section names this app
 * writes into `app_meta.search_open`.
 *
 * **This side owns the vocabulary and the backend deliberately does not.** `searchopen.rs` refuses
 * a blank section and nothing else, exactly as `flatten.rs` does — which page has a column is a
 * question about screens the crate never draws, so a word it does not know is a row it stores
 * rather than a row it refuses.
 *
 * `SearchSurface` in `CardSearchPanel.tsx` is the same three words for the `data-search-over`
 * attribute. Two names for one vocabulary is deliberate: one is the storage key and one is a DOM
 * value, and folding them would make a rename of either a change to the other.
 */
export type SearchSection = "deck" | "collection" | "wishlist";

/**
 * What each column does before the stored answer has arrived, and on a database that has never
 * been asked.
 *
 * **All three open, and the deck's `true` is the one with a history.** It opened shut, on the
 * argument that a search is a thing the reader asks for — and that argument only ever held while
 * the answer was forgotten the moment the deck closed, so a reader who searches while they build
 * pressed the same control on every deck they opened (issue #183). The default and the memory are
 * one change: this is the state of a database nobody has expressed a preference in, and every
 * reader who shuts a column once never sees it again.
 *
 * The collection's and the wishlist's follow it rather than deciding again. A sidebar that opens
 * shut is a feature the reader has to find; one that opens open is a feature they have to dismiss,
 * once, and the dismissal is remembered.
 *
 * **A literal `Record<SearchSection, boolean>` on purpose**, `DEFAULT_SECTION_ZOOMS`' rule: a
 * fourth surface is then a compile error until somebody says which way it starts, rather than a
 * silent `undefined` that reads as shut.
 *
 * Nothing in `searchopen.rs` spells these, and that is the difference from the constant this
 * replaced. The old `DEFAULT_DECK_SEARCH_OPEN` was spelled on both sides — two answers to two
 * questions, what a *missing row* means and what a *read in flight* means — and the map has only
 * the second: a section the row says nothing about is answered here and nowhere else.
 */
export const DEFAULT_SEARCH_OPEN: Readonly<Record<SearchSection, boolean>> = {
  deck: true,
  collection: true,
  wishlist: true,
};

/**
 * Whether one surface's docked card search column is open — remembered across pages and across
 * restarts.
 *
 * TanStack Query rather than the zustand store and rather than a `useState` in the panel, for
 * `usePrintingGroupBy`'s two reasons: `store.ts` scopes itself to UI state and hands anything
 * backed by the database to Query, and this setting lives in `app_meta` so it outlives the
 * process. The cache is also what makes it survive a *page* — the deck editor is keyed on the deck
 * id, so opening a second deck throws the panel away and mounts a new one, and a new observer over
 * a resolved query is a read of the cache rather than a round trip.
 *
 * **The press is what is remembered, not the drawn state**, and the two are different: a panel
 * rails itself when the desk is too narrow to hold the page's list *and* a column
 * (`CardSearchPanel`'s `roomy`), and a reader who never touched the control must not come back to
 * a window they never asked for. So the disclosure writes here and the measurement does not.
 *
 * **The write is optimistic and deliberately not rolled back**, which is `usePrintingGroupBy`'s
 * paragraph applied to a control that is pressed far more often: the column has to open on the
 * press rather than a round trip later, and `set_search_open` legitimately answers BUSY while a
 * sync holds the write connection — whole minutes of a first run. Snapping the column shut again
 * under the reader's hand, with nothing on screen saying why, would be worse than losing the
 * memory; what a refused write costs is only that the next launch opens on the state before it.
 *
 * `gcTime: Infinity` is what makes "across pages" literal rather than a five-minute accident.
 * Without it the entry is collected once the last panel closes, and a page opened six minutes
 * later would re-read `app_meta` and get the value the refused write never stored — the rollback
 * this hook refuses to do, arriving late.
 *
 * **A read that fails is the default, never an error.** Nothing here surfaces `isError` and
 * nothing branches on it: a preference that cannot be read is not worth breaking a page over, and
 * the reader is one press from either state anyway.
 */
const QUERY = {
  queryKey: SEARCH_OPEN_KEY,
  queryFn: () => ipc.searchOpen(),
  // Read once per app run. Nothing else writes this row, so there is nothing to go stale
  // against — every change to it goes through the mutation below, which writes the answer
  // straight into the cache.
  staleTime: Infinity,
  gcTime: Infinity,
};

/**
 * Ask for the stored answers **at launch**, so no page has to draw its column before it knows
 * which way round to draw it.
 *
 * **This exists because of a measurement, and the measurement is worth the whole doc.** Without it
 * the read is started by the panel itself — which in the deck editor mounts only once `deck_get`
 * has answered — so the panel's first paint is always the {@link DEFAULT_SEARCH_OPEN} guess.
 * Driven in the shipped window on 2026-08-22 at 1280×800, on a database whose stored answer was
 * *shut*: the column drew **384px wide for 43 frames** — about 700ms — and then snapped to its
 * 36px rail, with the deck beside it re-packing from 617px to 965px on the way past. A reader who
 * had closed the search saw it thrown open and yanked shut every time they opened a deck.
 *
 * 700ms rather than the round trip, which is the part worth knowing: the row is one `app_meta` row
 * and answers in **5–21ms** when asked on its own (measured in the same window, on the
 * `deck_search_open` command this one replaced). It is slow *there* because it queues behind the
 * page's own read on the read connection — and behind a sync, on the launch where this is most
 * likely to be a reader's first deck. So the fix cannot be to make the read faster; it has to be
 * to stop asking at the moment the answer is needed.
 *
 * **`AppShell` is the one caller**, beside `useCardZoomPersistence` and for its reason: it is the
 * component that is always mounted, so the read starts while the reader is still on the Search
 * view and has resolved long before they have reached a deck, the collection or the wishlist. It
 * renders nothing and returns nothing — the answer goes into the query cache, which is where
 * {@link useSearchOpen} reads it back from.
 *
 * **One prefetch for three columns**, which is the argument for the map having been made once and
 * then costing nothing three times: the old shape would have put three of these here.
 *
 * `prefetchQuery` rather than a second `useQuery`: an observer here would be a subscription for a
 * value this component never draws, re-rendering the whole shell when a press on any page changed
 * it. A prefetch fills the same cache entry — same key, same `staleTime: Infinity` — and then has
 * nothing further to do with it.
 *
 * A failure is swallowed for the reason the read itself falls back: a preference that cannot be
 * read is not worth a sentence anywhere, and the panel's own query will simply try again.
 */
export function usePrefetchSearchOpen(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    void queryClient.prefetchQuery(QUERY).catch(() => {});
  }, [queryClient]);
}

export function useSearchOpen(section: SearchSection): {
  open: boolean;
  setOpen: (open: boolean) => void;
} {
  const queryClient = useQueryClient();

  // The same entry {@link usePrefetchSearchOpen} filled at launch, so on every page a reader
  // actually opens this is a read of the cache rather than a round trip. It is still a real query
  // rather than a bare `getQueryData`, because the prefetch can fail or be beaten by a very fast
  // reader — and then this is what asks again.
  const query = useQuery(QUERY);

  const write = useMutation({
    mutationFn: (open: boolean) => ipc.setSearchOpen(section, open),
  });

  const startWrite = write.mutate;
  const setOpen = useCallback(
    (open: boolean) => {
      // The optimistic half. `setQueryData` before `mutate`, not in an `onMutate`: the two are
      // the same commit either way, and doing it here says outright that the cache is the
      // reader's choice and the command is only how it is remembered.
      //
      // **The spread is what makes this a map rather than three settings sharing a key**: only
      // the section being pressed is touched, so a column shut on the collection does not carry a
      // stale answer for the wishlist back into the cache. It mirrors what `searchopen.rs`'s
      // `store` does to the row itself, for the same reason and one level down.
      queryClient.setQueryData(SEARCH_OPEN_KEY, (stored: Record<string, boolean> | undefined) => ({
        ...stored,
        [section]: open,
      }));
      startWrite(open);
    },
    [queryClient, section, startWrite],
  );

  // Narrowed on the way out for `usePrintingGroupBy`'s reason, and here there are two ways in
  // rather than one: the whole entry can be `undefined` (the read still in flight, or failed),
  // and an *entry* can be missing or hold something that is not a boolean — a row a newer build
  // wrote, or one a reader hand-edited. All three are the same answer, which is this side's
  // default for the section.
  const stored = query.data?.[section];
  return {
    open: typeof stored === "boolean" ? stored : DEFAULT_SEARCH_OPEN[section],
    setOpen,
  };
}
