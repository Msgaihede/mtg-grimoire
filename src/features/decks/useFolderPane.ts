import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, type DeckFolderPane } from "@/lib/ipc";
import { DEFAULT_FOLDER_TREE_WIDTH_PX } from "./FolderTree";

/**
 * Where the decks page's folder tree keeps its width and its fold for the life of the window.
 *
 * Exported for `NAV_COLLAPSED_KEY`'s reason: a test or a story that wants the page to open with
 * the tree already folded, or already 320px wide, seeds the cache rather than mocking the
 * command — and a key spelled twice is a key that drifts.
 */
export const FOLDER_PANE_KEY = ["deckFolderPane"];

/**
 * How long the drag has to go quiet before the width is written, in ms.
 *
 * **A trailing debounce is not an optimisation here, it is the only workable shape**, which is
 * `ZOOM_WRITE_DELAY_MS`' paragraph arriving at a second gesture: a drag is a *stream*. A pointer
 * dragged across 100px emits a `pointermove` per frame — dozens a second, for as long as the hand
 * moves — and writing per event would put a run of `set_deck_folder_pane` calls through the IPC
 * boundary and onto the write connection, each a read-modify-write of the same row, for a value
 * that was obsolete before it committed.
 *
 * 400ms, the same number and for the same two bounds: above the gap between two frames of one
 * gesture, so a two-second drag collapses to a single write, and below anything a reader would
 * experience as a delay. **It is deliberately a separate constant from the zoom's**, for the
 * reason that one is deliberately separate from the badge's: two numbers that happen to be
 * measured from the same last event are not one number, and a change to how often a *drag* touches
 * the database must not have to be argued about against a wheel.
 *
 * What it costs is the tail: a width the reader settles on in the last 400ms before the app closes
 * is not remembered. That is the trade `useCardZoomPersistence` already took for the identical
 * shape, and it is a rounding error against the alternative — the process ending is the exit that
 * matters here, and no cleanup this hook could run would help with that one.
 */
export const FOLDER_WIDTH_WRITE_DELAY_MS = 400;

/**
 * The one query behind both the hook and the prefetch — spelled once so the two cannot ask for
 * the same row under different terms and end up with two cache entries.
 *
 * Read once per app run. Nothing else writes this row, so there is nothing to go stale against:
 * every change to it goes through the mutation in {@link useFolderPane}, which writes the answer
 * straight into the cache.
 */
const QUERY = {
  queryKey: FOLDER_PANE_KEY,
  queryFn: () => ipc.deckFolderPane(),
  staleTime: Infinity,
  gcTime: Infinity,
};

/**
 * Start the read at launch rather than at the decks page — **the fix for a wrong-width flash**,
 * and the reason it is a separate export.
 *
 * `useSearchOpen` measured this exact failure on the row beside this one: the read is one
 * `app_meta` row that answers in 5–21ms asked on its own, and **~700ms** asked at the moment the
 * page mounts, because it queues behind that page's own reads on the read connection — and behind
 * a sync, on the launch where this is most likely to be a reader's first visit. So the fix cannot
 * be a faster read; it has to be to stop asking at the moment the answer is needed.
 *
 * What that flash *is* here is worth naming, because it is worse than the search column's. Until
 * the row lands {@link useFolderPane} answers with {@link DEFAULT_FOLDER_TREE_WIDTH_PX} and
 * `collapsed: false` — so a reader who works with a railed tree watches it draw open and then
 * shut, and a reader who dragged it to 320 watches it draw at 208 and jump. Both are the page
 * re-laying itself out around a column that changes width after first paint.
 *
 * **`AppShell` is the one caller**, beside `usePrefetchSearchOpen` and for its reason: it is the
 * component that is always mounted, so the read starts while the reader is still on the Search
 * view and has resolved long before they reach the decks page. It renders nothing and returns
 * nothing — the answer goes into the query cache, which is where {@link useFolderPane} reads it
 * back from.
 *
 * `prefetchQuery` rather than a second `useQuery`: an observer here would be a subscription for a
 * value this component never draws, re-rendering the whole shell every time a drag settled. A
 * prefetch fills the same cache entry — same key, same `staleTime: Infinity` — and then has
 * nothing further to do with it.
 *
 * A failure is swallowed for the reason the read itself falls back: a preference that cannot be
 * read is not worth a sentence anywhere, and {@link useFolderPane}'s own query will ask again.
 */
export function usePrefetchFolderPane(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    void queryClient.prefetchQuery(QUERY).catch(() => {});
  }, [queryClient]);
}

/**
 * How wide the decks page's folder tree is drawn and whether it is folded — remembered across
 * restarts.
 *
 * TanStack Query rather than the zustand store, for `useNavCollapsed`'s reason repeated whole:
 * `store.ts` scopes itself to UI state and hands anything backed by the database to Query, and
 * this setting is one `app_meta` row that outlives the process. The cache is where the value
 * *lives* — there is no second home for it to be copied into.
 *
 * **In `features/decks/` rather than in `lib/`, and that is a claim about the app rather than
 * about the file.** `useNavCollapsed` is `lib/`'s because the rail it folds is the shell every
 * page hangs inside; this tree is one page's sidebar, exactly as `useSearchOpen` is the docked
 * search columns' and lives in `features/search/`. A hook in `lib/` is one any surface may reach
 * for, and nothing outside the decks page has any business asking how wide its folder tree is.
 *
 * **Two facts and one row**, which is {@link DeckFolderPane}'s argument and the thing that shapes
 * everything below: a width and a fold are one gesture's worth of state about one column, so they
 * are written together and there is exactly one command. That is what makes the debounce split
 * interesting rather than mechanical — see {@link FOLDER_WIDTH_WRITE_DELAY_MS} and the race note
 * on `setCollapsed` below.
 *
 * **A read that fails is the defaults — the tree at {@link DEFAULT_FOLDER_TREE_WIDTH_PX} and
 * open — and never an error.** Nothing here surfaces `isError` and nothing branches on it:
 * `deck_folder_pane` is infallible at the far end, where a missing row, a junk row and an
 * unreadable one all answer `{ width: null, collapsed: false }`, so the only failures left are the
 * IPC boundary itself and a `BUSY` under a sync. Neither is worth a decks page that will not draw,
 * and the whole cost of falling back is a tree that opens at its default width on a launch it
 * would have opened at the reader's.
 *
 * **The writes are optimistic, and they are deliberately not rolled back.** The cache is written
 * before the command is sent, so the divider follows the pointer rather than a round trip later —
 * a drag is direct manipulation, and a column that answers late reads as a column that will not
 * move. And the command can legitimately fail: `set_deck_folder_pane` answers `BUSY` while a sync
 * holds the write connection, which is a state the app spends whole minutes in on a first run.
 * Snapping the tree back to where it was under the reader's hand in that window, with nothing on
 * screen saying why, is worse than losing one launch's memory of it. So a refused write keeps the
 * reader's choice for this session and says nothing. There is no `onError` and nothing calls
 * `mutateAsync`, so the rejection settles inside the mutation and never reaches a boundary.
 *
 * `gcTime: Infinity` is what makes "for this session" literal rather than a five-minute accident,
 * and it earns more here than it does on the rail: a reader who leaves the decks page unmounts the
 * tree, and a collected entry would re-read `app_meta` on their way back and get the value the
 * refused write never stored — the rollback this hook refuses to do, arriving late.
 *
 * **One window this hook does not close, named rather than papered over**: a reader who grabs the
 * divider *inside* the launch read's round trip has their optimistic width overwritten when that
 * read lands, because a resolved fetch writes the cache entry it was fetching. It is
 * `useNavCollapsed`'s and `useSearchOpen`'s window exactly and it is left where they leave it —
 * what it costs is one frame of snap-back mid-drag, after which the next `pointermove` is the
 * newer fact again. `useCardZoomPersistence` guards the same race explicitly, and it can: its
 * value lives in a store the seed can be checked against, where this one's home *is* the thing
 * that would have to be guarded.
 */
export function useFolderPane(): {
  /** How wide to draw the tree, in px — the reader's width, or the default on a database nobody
   *  has dragged. */
  width: number;
  collapsed: boolean;
  setWidth: (width: number) => void;
  setCollapsed: (collapsed: boolean) => void;
} {
  const queryClient = useQueryClient();

  const query = useQuery(QUERY);

  const write = useMutation({
    mutationFn: (pane: DeckFolderPane) =>
      // The command's `width` is a `number` where the row's is nullable, so the default is
      // supplied here — see `ipc.setDeckFolderPane`, which names what that costs.
      ipc.setDeckFolderPane(pane.width ?? DEFAULT_FOLDER_TREE_WIDTH_PX, pane.collapsed),
  });

  /**
   * The width write in flight, or `undefined`.
   *
   * A ref rather than state because nothing renders differently for it, and one per hook instance
   * rather than per module because a module-level timer would outlive the page and, in the suite,
   * leak into the next test — `useCardZoomPersistence`'s map, with one entry because there is one
   * tree.
   */
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const startWrite = write.mutate;

  /**
   * Write whatever the cache currently holds, now.
   *
   * **Read at the moment of the call, never captured when it was scheduled** — `setCardZoom`'s
   * rule, and here it is half of the race defence below: whatever the reader has settled on is
   * what gets stored, however many `pointermove`s and however many presses happened in between.
   */
  const flush = useCallback(() => {
    const stored = queryClient.getQueryData<DeckFolderPane>(FOLDER_PANE_KEY);
    if (stored) startWrite(stored);
  }, [queryClient, startWrite]);

  const setWidth = useCallback(
    (width: number) => {
      // The optimistic half. `setQueryData` before the write is scheduled, not in an `onMutate`:
      // the two are the same commit either way, and doing it here says outright that the cache is
      // the reader's choice and the command is only how it is remembered.
      //
      // The updater keeps `collapsed` rather than assuming it, for `useSearchOpen`'s reason one
      // field over: this is one row holding two facts, and a width write that flattened the fold
      // would be a drag putting the tree back open.
      queryClient.setQueryData(FOLDER_PANE_KEY, (stored: DeckFolderPane | undefined) => ({
        width,
        collapsed: stored?.collapsed ?? false,
      }));
      clearTimeout(pending.current);
      pending.current = setTimeout(() => {
        pending.current = undefined;
        flush();
      }, FOLDER_WIDTH_WRITE_DELAY_MS);
    },
    [flush, queryClient],
  );

  const setCollapsed = useCallback(
    (collapsed: boolean) => {
      /**
       * **The pending width write is dropped rather than allowed to land after this one**, and it
       * is the one race this shape has. Both facts go through one command, so a debounced write
       * scheduled 300ms ago carries the fold as it was *then* — and a reader who drags the
       * divider and immediately presses the fold would have their press overwritten 100ms later
       * by a write that predates it, with the tree unfolding on its own and nothing on screen
       * explaining why.
       *
       * Cancelling costs nothing, because this write is a **superset** of the one it cancels: the
       * row is one struct and {@link flush} reads the cache, which already holds the width that
       * pending write was scheduled for. So the drag is remembered by the press rather than in
       * spite of it, and the reader's two gestures reach the database as one row saying both.
       *
       * Belt and braces, deliberately: {@link flush} reading at call time means even a timer that
       * somehow survived would write today's fold rather than the one it was scheduled with. The
       * cancellation is what makes the *ordering* impossible; the late read is what makes the
       * ordering not matter.
       */
      clearTimeout(pending.current);
      pending.current = undefined;

      // `stored?.width ?? null` and not the default: the cache says what the *reader* has done and
      // `null` is still the truth of that, while the row about to be written says what went over a
      // wire whose `width` cannot be null. The two draw the same tree — the getter below turns a
      // `null` into the same default the mutation sends — so nothing downstream can tell them
      // apart, and the cache keeps the one fact a later default change would want back.
      queryClient.setQueryData(FOLDER_PANE_KEY, (stored: DeckFolderPane | undefined) => ({
        width: stored?.width ?? null,
        collapsed,
      }));
      // **Not debounced**, which is the whole of the asymmetry: a drag is a stream and a fold is
      // one deliberate press. There is no run of obsolete values to collapse, and a press whose
      // memory waits 400ms is a press that is lost to a reader who closes the window on it.
      flush();
    },
    [flush, queryClient],
  );

  useEffect(
    () => () => {
      // A pending timer would fire into a page that is going away, and in a test it would fire
      // into the next one — which is how a debounce becomes a cross-test leak. The tail it drops
      // is the one {@link FOLDER_WIDTH_WRITE_DELAY_MS} already names.
      clearTimeout(pending.current);
      pending.current = undefined;
    },
    [],
  );

  const stored = query.data;
  return {
    /**
     * **Narrowed on the way out rather than trusted**, which is `useSearchOpen`'s check on its
     * booleans and it is owed more here than it is there: `null` is the honest answer for a
     * database nobody has dragged, and a row a hand-edit or a future build left holding `0`, a
     * negative or a `NaN` would draw a tree of no width with nothing red anywhere. What is
     * refused is only what could never be a width — the *floor* and the *ceiling* are a fact
     * about a desk this hook never measures, and clamping them here would make one narrow
     * session's squeeze permanent.
     */
    width:
      typeof stored?.width === "number" && Number.isFinite(stored.width) && stored.width > 0
        ? stored.width
        : DEFAULT_FOLDER_TREE_WIDTH_PX,
    // The read in flight, the read that failed and a row holding something that is not a boolean
    // are all the same answer to a page that has to draw: the tree is open.
    collapsed: typeof stored?.collapsed === "boolean" ? stored.collapsed : false,
    setWidth,
    setCollapsed,
  };
}
