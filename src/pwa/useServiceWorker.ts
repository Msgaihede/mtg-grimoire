import { useCallback, useEffect, useRef, useState } from "react";
import { isWebTarget } from "@/pwa/target";

/** How long between "the tab came back to the front" checks for a new build. */
const RECHECK_MS = 60 * 60 * 1000;

export interface ServiceWorkerState {
  /** A new build has installed and is waiting for the reader's say-so. */
  updateReady: boolean;
  /** Let it take over: skip the wait, then one reload when it has. */
  applyUpdate: () => void;
}

/**
 * Owns the registration and the waiting worker.
 *
 * Mounted **once**, in `App`. Two calls would be two registrations racing to describe one
 * worker, which is `useUpdate`'s rule for the desktop updater arrived at from the same place.
 *
 * ## The update flow, which is the whole reason this file exists
 *
 * "Just reload" is not an update flow: a browser installs a new worker as the *waiting* one and
 * leaves it there until every page under the old one is gone, so a reader who reloads gets the
 * old build back and no explanation. Spec §5.4 fixes the shape — the new build waits, a
 * non-modal bar says so, the reader presses it, the wait is skipped and `clients.claim` runs,
 * the page reloads **once**, and a reader who never presses it keeps working on the build they
 * started with rather than being interrupted mid-deck.
 *
 * ## Two guards that look like paranoia and are not
 *
 * **`controller !== null` before calling an install an update.** A first install also ends at
 * `state === "installed"`; the difference is that there is no old build to replace. Without this
 * every reader's first session shows "A new version is ready" a few seconds in.
 *
 * **`wasControlled` before reloading on `controllerchange`.** `sw.ts` calls `clients.claim()` on
 * every activation, first install included, and claiming an uncontrolled page fires
 * `controllerchange`. Reloading for that is a loop — claim, reload, claim, reload — and it is
 * the single most common way this flow is got wrong.
 *
 * `reload` is injectable for one reason: jsdom answers `window.location.reload()` with
 * *"Not implemented: navigation"* on stderr and does nothing, so a test could neither trigger
 * the real thing nor see that it happened. It is a **dependency of the effect** rather than a
 * ref written during render — the plan wrote the ref, and reading or writing one outside an
 * effect is what `react-hooks`' compiler rules are about. Every caller passes either nothing or
 * a stable function, so the effect still runs once.
 */
export function useServiceWorker({ reload }: { reload?: () => void } = {}): ServiceWorkerState {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  // Latched, not state: it is read inside listeners and must never re-run the effect.
  const reloaded = useRef(false);

  useEffect(() => {
    if (!isWebTarget() || !("serviceWorker" in navigator)) return;
    const container = navigator.serviceWorker;
    // Read before anything is registered: after that, "were we controlled when this document
    // loaded" is unanswerable.
    const wasControlled = container.controller !== null;
    let cancelled = false;

    const onControllerChange = () => {
      if (!wasControlled || reloaded.current) return;
      reloaded.current = true;
      (reload ?? (() => window.location.reload()))();
    };
    container.addEventListener("controllerchange", onControllerChange);

    // A browser checks for a new worker on navigation and about once a day. An installed PWA
    // that is left open for a week navigates neither, so it would never learn there was one.
    //
    // **Added out here rather than inside the `register` continuation**, which the plan left as
    // an explicit choice: this way the cleanup can take it off again, and a registration that
    // has not resolved yet simply has nothing to update.
    let registration: ServiceWorkerRegistration | null = null;
    let lastCheck = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastCheck < RECHECK_MS) return;
      lastCheck = Date.now();
      void registration?.update();
    };
    document.addEventListener("visibilitychange", onVisible);
    const recheck = setTimeout(onVisible, RECHECK_MS);

    void container.register("/sw.js").then((reg) => {
      if (cancelled) return;
      registration = reg;
      if (reg.waiting && container.controller) setWaiting(reg.waiting);

      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          // The `controller` clause is the first-install guard. See the header.
          if (installing.state === "installed" && container.controller) setWaiting(installing);
        });
      });
    });

    return () => {
      cancelled = true;
      container.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(recheck);
    };
  }, [reload]);

  const applyUpdate = useCallback(() => {
    waiting?.postMessage({ type: "SKIP_WAITING" });
  }, [waiting]);

  return { updateReady: waiting !== null, applyUpdate };
}
