import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import {
  createActivityStore,
  topActivity,
  type Activity,
  type ActivityState,
} from "@/lib/activity";

const ActivityContext = createContext<StoreApi<ActivityState> | null>(null);

/**
 * Holds the app's activity registry, above everything that writes to it or reads it.
 *
 * At the top of `AppShell`, which is above both of today's writers *and* above the view — so
 * a job started from inside a view registers with no rewiring. The store is created once per
 * provider and never re-created; the provider itself never re-renders when a job moves,
 * because the state lives in the store rather than in its own `useState`.
 */
export function ActivityProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createActivityStore);
  return <ActivityContext.Provider value={store}>{children}</ActivityContext.Provider>;
}

function useActivityStore(): StoreApi<ActivityState> {
  const store = useContext(ActivityContext);
  // A silent `null` here would be indistinguishable from "nothing is running", which is the
  // one wiring mistake this could make and the hardest one to notice.
  if (!store) throw new Error("useTopActivity/useRegisterActivity need an <ActivityProvider>");
  return store;
}

/**
 * Describe a long job for as long as it is running, and stop describing it when it is not.
 *
 * Declarative rather than a `begin()`/`end()` pair, and that is the whole design: pass the
 * job (or `null`) on every render and the registry cannot outlive the component that owns
 * it. The two effects are deliberately separate — see below.
 */
export function useRegisterActivity(job: Activity | null): void {
  const store = useActivityStore();
  const key = job?.key ?? null;

  // Every render, with no dependency array. The adapters build a fresh object each time, and
  // `put` is identity-in-identity-out when nothing moved, so this costs one shallow compare
  // and saves every call site a `useMemo` it could forget a dependency of.
  useEffect(() => {
    if (job !== null) store.getState().put(job);
  });

  // Removal is keyed and therefore rare: dropping and re-adding on every progress event
  // would blink the top job to null fifty-eight times an ingest, and the ribbon's delay
  // would re-arm on every blink. This runs only when the job ends or its key changes.
  useEffect(() => {
    if (key === null) return;
    return () => store.getState().drop(key);
  }, [store, key]);
}

/**
 * The job the ribbon is describing, or `null` when the app is idle.
 *
 * The selector returns an element of the store's array rather than a new object, so a
 * subscriber re-renders when the top job actually moves and not merely when the store is
 * written to.
 */
export function useTopActivity(): Activity | null {
  const store = useActivityStore();
  return useStore(store, (s) => topActivity(s.jobs));
}
