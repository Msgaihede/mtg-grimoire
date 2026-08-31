import { useEffect } from "react";
import { ipc } from "./ipc";
import { useAppStore } from "./store";

/**
 * Keep every list's layout across restarts: read the stored words once at launch, and write one
 * back the moment the reader presses the toggle.
 *
 * **Call this once.** `AppShell` is that one caller, `useCardZoomPersistence`'s rule and for its
 * reason: a second mount would be a second subscription writing the same row, and a second launch
 * read that could land after a press and be dropped by `hydrateListViews`' guard — so the two
 * copies would disagree about whether the session had been seeded. It renders nothing and returns
 * nothing; the layouts are in the store, where each page already reads its own.
 *
 * ## Why it is shaped like the zoom's hook and not like `useNavCollapsed`
 *
 * `useNavCollapsed` keeps its `app_meta` row in the query cache and reads it back from there,
 * which is right for that one: the cache **is** where the value lives, and the single component
 * that draws the rail subscribes to it. These four are the other way round. The layouts have to be
 * in the zustand store — four pages read them, and `ViewToggle` writes whichever one it is mounted
 * over — so a query here would be a cache entry with one consumer, which copies its answer into
 * the real home and is never read again. That is a launch-time seed wearing a cache's clothes, and
 * `useCardZoomPersistence` already spells out why it is written as one instead.
 *
 * ## Why there is no debounce, where the zoom has 400ms
 *
 * A zoom is a *stream* — a wheel or a pinch arrives dozens of times a second — so writing per
 * notch would put a run of obsolete values through the IPC boundary. A layout is one deliberate
 * press on one of two buttons, and the second press is a reader changing their mind rather than a
 * gesture continuing. So the write goes on the press, and the row is touched exactly as often as
 * the reader touches the control.
 *
 * ## What it does about failure, which is nothing
 *
 * Neither half surfaces an error and neither retries. A read that fails leaves every list on the
 * default `store.ts` built it with, which is a complete, drawable app. A write that fails —
 * `set_list_view` answers BUSY while a sync holds the write connection, which a first run spends
 * whole minutes in — costs the reader nothing this session and only the next launch's opening
 * layout for that list. There is no sentence either failure could put on screen worth the
 * interruption, and the next press schedules another write anyway.
 */
export function useListViewPersistence(): void {
  useEffect(() => {
    let cancelled = false;
    void ipc
      .listView()
      .then((stored) => {
        // The unmount may beat the round trip, and seeding a store the window is done with is
        // harmless — but under StrictMode's double mount it would be the *second* copy's read
        // landing into a session the first copy already seeded, which is exactly the disagreement
        // the "call this once" rule exists to prevent.
        if (!cancelled) useAppStore.getState().hydrateListViews(stored);
      })
      // Outside a Tauri window (a plain `vite dev`, a story with no fake registered) there is no
      // command to call. Losing a stored layout is not worth taking the app down for.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.listViewPulse === previous.listViewPulse) return;
      const section = state.listViewSection;
      // Every setter writes both fields, so this is unreachable in practice — but a null section
      // has no row to write to, and inventing one would put a blank key in the object the backend
      // refuses anyway.
      if (section === null) return;
      // Read the field the section names off the state the pulse arrived with, so the word written
      // is the one that caused the pulse rather than whatever a later press has since made true.
      const view = {
        search: state.searchView,
        tags: state.tagsView,
        collection: state.collectionView,
        wishlist: state.wishlistView,
      }[section];
      void ipc.setListView(section, view).catch(() => {});
    });
    return unsubscribe;
  }, []);
}
