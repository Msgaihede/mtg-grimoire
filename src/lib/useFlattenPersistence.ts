import { useEffect } from "react";
import { ipc } from "./ipc";
import { useAppStore } from "./store";

/**
 * Keep each cabinet's Flatten switch across restarts: read the stored row once at launch, and
 * write one back the moment the reader presses the switch.
 *
 * **Call this once.** `AppShell` is that one caller, `useListViewPersistence`'s rule and for its
 * reason: a second mount would be a second subscription writing the same row, and a second launch
 * read that could land after a press and be dropped by `hydrateFlatten`'s guard — so the two
 * copies would disagree about whether the session had been seeded. It renders nothing and returns
 * nothing; the two booleans are in the store, where each page already reads its own.
 *
 * ## Why it is shaped like the layout hook rather than like `useNavCollapsed`
 *
 * `useNavCollapsed` keeps its `app_meta` row in the query cache and reads it back from there,
 * which is right for that one: the cache **is** where the value lives, and the single component
 * that draws the rail subscribes to it. These two are the other way round, exactly as the four
 * layouts are — the switches have to be in the zustand store, because the collection and the
 * wishlist each read their own and `FilterBar`'s `flatten` prop writes whichever page it is
 * mounted over. A query here would be a cache entry with one consumer, which copies its answer
 * into the real home and is never read again: a launch-time seed wearing a cache's clothes, and
 * `useCardZoomPersistence` already spells out why it is written as one instead.
 *
 * ## Why there is no debounce, where the zoom has 400ms
 *
 * `useListViewPersistence`' argument, unchanged, because it is the same gesture. A zoom is a
 * *stream* — a wheel or a pinch arrives dozens of times a second — so writing per notch would put
 * a run of obsolete values through the IPC boundary. Flatten is one deliberate press on one
 * switch, and the second press is a reader changing their mind rather than a gesture continuing.
 * So the write goes on the press, and the row is touched exactly as often as the reader touches
 * the control.
 *
 * ## What it does about failure, which is nothing
 *
 * Neither half surfaces an error and neither retries. A read that fails leaves both pages on the
 * defaults `store.ts` built them with — the collection flattened, the wishlist not — which is a
 * complete, drawable app. A write that fails — `set_flatten_state` answers BUSY while a sync
 * holds the write connection, which a first run spends whole minutes in — costs the reader
 * nothing this session, because the switch they pressed is already what the page is drawing, and
 * only the next launch's opening state for that page. There is no sentence either failure could
 * put on screen worth the interruption, and the next press schedules another write anyway.
 */
export function useFlattenPersistence(): void {
  useEffect(() => {
    let cancelled = false;
    void ipc
      .flattenState()
      .then((stored) => {
        // The unmount may beat the round trip, and seeding a store the window is done with is
        // harmless — but under StrictMode's double mount it would be the *second* copy's read
        // landing into a session the first copy already seeded, which is exactly the disagreement
        // the "call this once" rule exists to prevent.
        if (!cancelled) useAppStore.getState().hydrateFlatten(stored);
      })
      // Outside a Tauri window (a plain `vite dev`, a story with no fake registered) there is no
      // command to call. Losing a stored switch is not worth taking the app down for.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.flattenPulse === previous.flattenPulse) return;
      const section = state.flattenSection;
      // Both toggles write both fields, so this is unreachable in practice — but a null section
      // has no row to write to, and inventing one would put a blank key in the object the backend
      // refuses anyway.
      if (section === null) return;
      // Read the field the section names off the state the pulse arrived with, so the answer
      // written is the one that caused the pulse rather than whatever a later press has since
      // made true.
      const flattened = {
        collection: state.collectionFlattened,
        wishlist: state.wishlistFlattened,
      }[section];
      void ipc.setFlattenState(section, flattened).catch(() => {});
    });
    return unsubscribe;
  }, []);
}
