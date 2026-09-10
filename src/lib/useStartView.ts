import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "./ipc";
import { useAppStore, type ViewId } from "./store";

/**
 * Where the view the app opens on is kept for the life of the window.
 *
 * Exported for `NAV_COLLAPSED_KEY`'s reason: a test or a story that wants the app to launch on
 * Search — or on a word no build has ever drawn — seeds the cache rather than mocking the command,
 * and a key spelled twice is a key that drifts.
 */
export const START_VIEW_KEY = ["startView"];

/**
 * The view the app opens on.
 *
 * ⚠️ **This alias is a seam, and Task 24 of the home-page plan closes it.** `store.ts` gains
 * `"home"` as {@link ViewId}'s first member in the same task that adds `hydrateStartView`, and on
 * the day it does this type is *definitionally* `ViewId` — a union absorbs a member it already
 * holds. Delete the alias then and spell `ViewId` throughout; nothing else in this module or in
 * its callers changes. Writing it this way rather than casting `"home"` into a union that does not
 * yet hold it is the difference between a fence the compiler keeps and a lie it cannot see.
 */
export type StartView = ViewId | "home";

/**
 * The view a database nobody has changed — and every failure below — opens on.
 *
 * Home, because it is the page built to be landed on: `home.rs` seeds it for a reader who has
 * never customised anything, and every other view answers a question the reader has not asked yet.
 */
export const DEFAULT_START_VIEW: StartView = "home";

/**
 * Every view this build can open on.
 *
 * **A `Record<StartView, true>` rather than a list, and that is the fence** — `WIDGET_META`'s
 * pattern one directory over. A view added to the union with no key here is a compile error at
 * this object, and a key here naming a view the union does not hold is a compile error too; an
 * array would silently strand a new view at the fallback and let a deleted one linger. The values
 * are `true` and mean nothing: the *keys* are the whole content.
 */
const VIEW_IDS: Record<StartView, true> = {
  home: true,
  search: true,
  tags: true,
  collection: true,
  wishlist: true,
  decks: true,
  shared: true,
  scanner: true,
  trade: true,
  playtesting: true,
  settings: true,
};

/** The same set, for {@link isStartView}. A `Set` rather than `value in VIEW_IDS`, because `in`
 *  walks the prototype and would answer `true` for `"toString"` and `"constructor"`. */
const KNOWN_VIEWS = new Set<string>(Object.keys(VIEW_IDS));

/**
 * Is this stored word a view this build draws?
 *
 * **The vocabulary check is TypeScript's and there is deliberately none in Rust.**
 * `startview.rs` hands back a word it has never heard of rather than refusing it, because which
 * pages exist is a fact about this app's router: an allow-list on that side would make every new
 * view a Rust change, and — worse — would strand a reader who ran a downgrade, because the newer
 * build's word would have been refused at the door and their setting silently rewritten. So the
 * word survives the round trip as itself and degrades *here*, where the degrading is one launch
 * on the wrong page rather than a lost setting.
 */
export function isStartView(value: string): value is StartView {
  return KNOWN_VIEWS.has(value);
}

/** A stored word read as a view — {@link DEFAULT_START_VIEW} when it is not one. The one place a
 *  bare `string` becomes a {@link StartView}, so nothing hands an unchecked word to the store. */
function asStartView(stored: string): StartView {
  return isStartView(stored) ? stored : DEFAULT_START_VIEW;
}

/**
 * The one query behind the hook and the hydration — spelled once so the two cannot ask for the
 * same row under different terms and end up with two cache entries, and so the launch read serves
 * the Settings row for free.
 *
 * **The cache holds the stored *word*, not the narrowed view**, which is the one place this parts
 * from `useHomeLayout` and it is deliberate. A layout is a document every consumer would otherwise
 * re-parse on every render; a view is one `Set.has`. Narrowing on the way out instead means a
 * story or a test that seeds this entry with a word no build draws gets the same answer a stored
 * one does, rather than the seed sneaking past the check the round trip would have applied.
 *
 * `staleTime`/`gcTime: Infinity` for `useNavCollapsed`'s reason: nothing else writes this row,
 * every change goes through the mutation below which writes the answer straight into the cache,
 * and a collected entry would re-read `app_meta` and get the word a refused write never stored.
 */
const QUERY = {
  queryKey: START_VIEW_KEY,
  queryFn: () => ipc.startView(),
  staleTime: Infinity,
  gcTime: Infinity,
};

/**
 * Which view the app opens on — read for the Settings row that shows it, and written by that
 * row's press.
 *
 * TanStack Query rather than the zustand store, for `useNavCollapsed`'s reason: `store.ts` scopes
 * itself to UI state and hands anything backed by the database to Query, and this is one
 * `app_meta` row that outlives the process. **It is not `activeView`** and must never be confused
 * with it — that is where the reader *is*, this is where the app *starts*, and the only place the
 * two meet is {@link useStartViewHydration}, once, at launch.
 *
 * **A read that fails is {@link DEFAULT_START_VIEW}, never an error.** Nothing here surfaces
 * `isError` and nothing branches on it: what is left to fail is the IPC boundary and a `BUSY`
 * under a sync, and neither is worth a Settings panel that will not draw. The whole cost of
 * falling back is one row showing Home while the app is in fact somewhere else, on a launch where
 * the database could not be reached at all.
 *
 * **The write is optimistic and deliberately not rolled back**, `useNavCollapsed`'s trade for its
 * reason: `set_start_view` answers `BUSY` while a sync holds the write connection, and putting the
 * picker back under the reader's hand with nothing on screen saying why is worse than losing one
 * launch's memory of the choice. There is no `onError` and nothing calls `mutateAsync`, so the
 * rejection settles inside the mutation and never reaches a boundary.
 */
export function useStartView(): {
  view: StartView;
  setView: (view: StartView) => void;
} {
  const queryClient = useQueryClient();

  // The same entry {@link useStartViewHydration} filled at launch, so the Settings row is a read
  // of the cache rather than a round trip. It is still a real query rather than a bare
  // `getQueryData`, because that read can fail — and then this is what asks again.
  const query = useQuery(QUERY);

  const write = useMutation({
    mutationFn: (view: StartView) => ipc.setStartView(view),
  });

  const startWrite = write.mutate;

  const setView = useCallback(
    (view: StartView) => {
      // The optimistic half. `setQueryData` before `mutate`, not in an `onMutate`: the two are the
      // same commit either way, and doing it here says outright that the cache is the reader's
      // choice and the command is only how it is remembered.
      queryClient.setQueryData(START_VIEW_KEY, view);
      startWrite(view);
    },
    [queryClient, startWrite],
  );

  const stored = query.data;
  return {
    // The read in flight, the read that failed and a word this build does not draw are all the
    // same answer to a row that has to show something: Home.
    view: typeof stored === "string" ? asStartView(stored) : DEFAULT_START_VIEW,
    setView,
  };
}

/**
 * The store, plus the action Task 24 adds to it.
 *
 * ⚠️ **The second half of this module's seam.** `hydrateStartView` is added to `store.ts` beside
 * `hydrateCardZoom` in Task 24 of the home-page plan, which runs after this file. Until it lands
 * the action is genuinely absent, so it is named as optional and called with `?.` — a runtime
 * check rather than a cast that claims something untrue. On the day Task 24 lands, `AppState`
 * carries the action itself, this intersection stops adding anything, and the alias and the `?.`
 * can both go. Nothing else here changes.
 */
type StoreWithStartView = ReturnType<typeof useAppStore.getState> & {
  hydrateStartView?: (view: StartView) => void;
};

/**
 * Land the app on the stored view, once, at launch.
 *
 * **Call this once.** `AppShell` is that one caller, beside `useCardZoomPersistence` and
 * `useListViewPersistence` and for their reason: it is the component that is always mounted, so
 * the read starts before the reader has reached anything and a second copy would be a second
 * launch read racing the first. It renders nothing and returns nothing.
 *
 * **A press already made wins, and that is the whole of the guard.** The read is a round trip, and
 * on a launch that is also a first sync it queues behind one — so a reader who has already reached
 * for the rail would otherwise be yanked off the page they asked for and onto last session's, a
 * beat later, with nothing on screen explaining it. `hydrateStartView` carries `hydrateCardZoom`'s
 * check verbatim and drops a seed that lands after the first press; this side's job is only to
 * never send it twice.
 *
 * `fetchQuery` rather than a `useQuery` observer: this component never draws the value, and an
 * observer here would re-render the whole shell every time the Settings row changed it. The
 * fetch fills the same entry {@link useStartView} reads back from — same key, same
 * `staleTime: Infinity` — so a Settings panel opened later costs no round trip, and an entry a
 * story already seeded costs none now.
 *
 * A failure is swallowed for the reason the read itself falls back: outside a Tauri window there
 * is no command to call, and a stored view that cannot be read is not worth a sentence anywhere —
 * the app simply opens where it already was.
 */
export function useStartViewHydration(): void {
  const queryClient = useQueryClient();

  /**
   * Whether the launch read has been started.
   *
   * A ref rather than state because nothing renders differently for it, and it is what makes
   * "once" true under StrictMode's double mount as well as under a re-render — the fiber is the
   * same one, so the ref survives the simulated remount that a `cancelled` flag would not.
   */
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void queryClient
      .fetchQuery(QUERY)
      .then((stored) => {
        // Narrowed before it crosses into the store, never after: `activeView` is a `ViewId` and
        // a word Rust stored is a `string`, and this is the one door between them.
        const state = useAppStore.getState() as StoreWithStartView;
        state.hydrateStartView?.(asStartView(stored));
      })
      .catch(() => {});
  }, [queryClient]);
}
