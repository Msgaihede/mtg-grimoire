import { useEffect } from "react";
import { ipc } from "./ipc";
import { useAppStore } from "./store";

/**
 * How long a section has to go quiet before its zoom is written, in ms.
 *
 * **A trailing debounce is not an optimisation here, it is the only workable shape.** A ctrl+wheel
 * is a *stream*: a rolled mouse wheel arrives a few tens of ms apart, and a precision trackpad's
 * pinch — which reaches the page as ctrl-flagged wheel events, not as a gesture of its own —
 * arrives dozens of times a second for as long as the fingers move. Writing per notch would put a
 * whole run of `set_card_zoom` calls through the IPC boundary and onto the write connection, each
 * one a read-modify-write of the same row, for a value that was obsolete before it committed.
 *
 * 400ms because it has to sit above the gap between two notches of one gesture (tens of ms, so a
 * two-second pinch collapses to a single write) and below anything a reader would experience as a
 * delay. What the number really costs is the case where the app is closed *during* the tail: a
 * zoom made in the last 400ms of the process is not remembered. That is a rounding error against
 * the alternative, and it is the same trade the badge's own `ZOOM_QUIET_MS` makes — deliberately
 * not the same constant, though, because that one is about when a figure stops being news and
 * this one is about how often to touch the database. Two numbers that happen to be measured from
 * the same last notch are not one number.
 */
export const ZOOM_WRITE_DELAY_MS = 400;

/**
 * Keep every wall's zoom across restarts: read the stored sizes once at launch, and write a
 * section back once its gesture has stopped.
 *
 * **Call this once.** `AppShell` is that one caller, `useMarketplaceProgress`'s rule and for a
 * sharper version of its reason: a second mount would be a second subscription writing the same
 * row, and — worse — a second launch read that could land after a gesture and be dropped by
 * `hydrateCardZoom`'s guard, so the two copies would disagree about whether the session had been
 * seeded. It renders nothing and returns nothing; the sizes are in the store, where every wall
 * already reads them.
 *
 * ## Why this is not TanStack Query, where the app's other three settings are
 *
 * `useMarketplace`, `usePrintingGroupBy` and `useNavCollapsed` keep their `app_meta` row in the
 * query cache and read it back from there, which is right for all three: the cache **is** where
 * the value lives, and the component that draws the control subscribes to it. The zoom is the other way round. `cardZoom`
 * has to be in the zustand store — a wheel handler steps it imperatively fifty times a second and
 * five walls read it during layout — so a query here would not be the home of anything. It would
 * be a cache entry with exactly one consumer, which copies its answer into the real home and is
 * never read again. That is a launch-time seed wearing a cache's clothes, so it is written as one.
 *
 * ## Why the writes hang off `zoomPulse` rather than off `cardZoom`
 *
 * The pulse is the store's own word for *a gesture happened*, and a gesture is exactly what is
 * worth remembering. Watching the value instead would get two cases wrong in opposite directions.
 * It would write back everything {@link hydrateCardZoom} had just seeded — seven round trips at
 * launch to tell the database what it had said a moment earlier — and it would *miss* the reader
 * holding the wheel at 200%, whose gestures `stepZoom` answers with 200% forever: the value never
 * moves, so a value-watcher would never restart the timer, and the write would land in the middle
 * of a gesture rather than after it. `zoomSection` says which wall each pulse belonged to, so the
 * timers stay per-section and a reader who zooms the deck, then its search column, gets both.
 *
 * The value is read at the moment the timer fires (`getState()`), never captured when it was set:
 * whatever the wall settled on is what gets stored, however many notches happened in between.
 *
 * ## What it does about failure, which is nothing
 *
 * Neither half surfaces an error and neither retries. A read that fails leaves every wall at
 * `DEFAULT_ZOOM`, which is a complete, drawable app. A write that fails — `set_card_zoom` answers
 * BUSY while a sync holds the write connection, which a first run spends whole minutes in — costs
 * the reader nothing this session and only the next launch's starting size for that wall. There
 * is no sentence either failure could put on screen that would be worth the interruption, and the
 * next gesture on that wall schedules another write anyway.
 */
export function useCardZoomPersistence(): void {
  useEffect(() => {
    let cancelled = false;
    void ipc
      .cardZoom()
      .then((stored) => {
        // The unmount may beat the round trip, and seeding a store the window is done with is
        // harmless — but under StrictMode's double mount it would be the *second* copy's read
        // landing into a session the first copy already seeded, which is exactly the disagreement
        // the "call this once" rule exists to prevent.
        if (!cancelled) useAppStore.getState().hydrateCardZoom(stored);
      })
      // Outside a Tauri window (a plain `vite dev`, a story with no fake registered) there is no
      // command to call. Losing a stored size is not worth taking the app down for.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    /** One trailing timer per section, so two walls zoomed in turn both get written. */
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.zoomPulse === previous.zoomPulse) return;
      const section = state.zoomSection;
      // `zoomCards` writes both on every gesture, so this is unreachable in practice — but a null
      // section has no row to write to, and inventing one would put a blank key in the object the
      // backend refuses anyway.
      if (section === null) return;

      clearTimeout(timers.get(section));
      timers.set(
        section,
        setTimeout(() => {
          timers.delete(section);
          // Read now, not when the timer was set: the wall may have moved several more stops.
          void ipc.setCardZoom(section, useAppStore.getState().cardZoom[section]).catch(() => {});
        }, ZOOM_WRITE_DELAY_MS),
      );
    });

    return () => {
      unsubscribe();
      // A pending timer would fire into a window that is going away, and in a test it would fire
      // into the next one — which is how a debounce becomes a cross-test leak.
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, []);
}
