import type { HostUpdate } from "../hostUpdate";
import { CLAIM, installFailure, SKIP_WAITING, type Heard } from "./sw/bridge";

/**
 * **The page's half of the service worker: registering it, and the update flow** (the light-app
 * spec §6). Everything is handed in — the container, the reload, the clock — so the suite drives
 * it with a fake registration (`update.test.ts`); `index.ts` hands in the page's own.
 *
 * "Just reload" is not an update flow. A browser installs a new worker as the *waiting* one and
 * keeps it there while any page of the old build is open, a reload included — so a reader who
 * reloads gets the old build back, from the old worker's cache, with nothing said. What is built
 * here: the new build waits; the host says so (`hostUpdate.ts`); **only the reader's press tells
 * it to take over**; and the page reloads once when it has.
 */

/** Where the worker is served from: the origin's root, so its scope is the whole app. */
export const WORKER_URL = "/sw.js";

/** How often a page that has come back into view asks whether there is a newer build. */
export const RECHECK_MS = 60 * 60 * 1000;

/** What the web host answers `host_update` with while a build waits. */
export const UPDATE_READY: HostUpdate = {
  title: "A new version of MTG Grimoire is ready.",
  action: "Reload to update",
};

/**
 * What the page's console says, once, when the worker could not install — `reason` is the
 * worker's own account of why, where it got one across (`sw/bridge.ts`'s `INSTALL_FAILED`).
 *
 * **Two sentences, because the two cases cost different things.** On a page nothing controls
 * there is then no worker at all: no card picture, no offline shell, and — until this was
 * written — not a word anywhere (driven 2026-10-04: Cache Storage threw `UnknownError` on open,
 * the install failed, and the page ran on in silence). On a page an older build controls,
 * nothing the reader has is lost: only the newer build did not arrive.
 *
 * On the console and not on the page: the app works, a reload retries the install, and a notice
 * a reader could do nothing about would be worse than a tile's own "Retrying…".
 */
export function installFailedLine(controlled: boolean, reason: string | undefined): string {
  const why = reason ? ` (${reason})` : "";
  return controlled
    ? `MTG Grimoire: a newer version could not be saved, so this one keeps running${why}.`
    : "MTG Grimoire: this browser could not save the app for offline use, so card pictures " +
        `will not load and the app will not open without a connection. A reload tries again${why}.`;
}

/** As much of a `ServiceWorker` as a waiting one is used for. */
export interface WaitingWorker {
  state: string;
  postMessage(message: unknown): void;
  addEventListener(type: "statechange", listener: () => void): void;
}

/** As much of a `ServiceWorkerRegistration` as is used. */
export interface Registration {
  /** The worker answering this origin's pages — though not necessarily this one. */
  active: WaitingWorker | null;
  waiting: WaitingWorker | null;
  installing: WaitingWorker | null;
  addEventListener(type: "updatefound", listener: () => void): void;
  update(): Promise<unknown>;
}

/** As much of `navigator.serviceWorker` as the page uses. The real one is assignable. */
export interface WorkerContainer {
  /** The worker answering this page's requests, or `null` for a page nothing controls. */
  controller: unknown;
  register(url: string, options: { updateViaCache: "none" }): Promise<Registration>;
  addEventListener(type: "controllerchange", listener: () => void): void;
  /** What the worker posts to this page: its asks for a picture's address (`sw/bridge.ts`). */
  addEventListener(type: "message", listener: (event: Heard) => void): void;
  /**
   * Starts delivery of those messages. A listener *added* — rather than assigned to `onmessage`
   * — hears nothing until the document has finished loading unless this is called, and a
   * picture can be asked for before that.
   */
  startMessages(): void;
}

export interface UpdateWatch {
  /** Whether a newer build is installed and waiting on the reader. */
  waiting(): boolean;
  /** Tell it to take over. `false` when there is none to tell. */
  apply(): boolean;
}

export interface WatchOptions {
  /** Called whenever {@link UpdateWatch.waiting}'s answer changes. */
  onChange(): void;
  /**
   * Whether this page should start again when a new worker takes it over. The web core answers
   * *yes* only for the page that holds the database: a second tab is a boot screen whose one
   * control is already a link to a fresh document, and a tab still opening has nothing a reload
   * would bring — and either, reloading, would race the tab that pressed for the database.
   */
  mayReload(): boolean;
  reload(): void;
  /** Subscribes to the page coming back into view. Absent where there is no page to watch. */
  onVisible?(heard: () => void): void;
  /** Unix milliseconds. */
  now(): number;
}

/**
 * Register the worker and watch for a newer build.
 *
 * - **A first install is not an update.** A worker reaching `installed` on a page nothing
 *   controls has no old build to replace — it activates by itself — so it is never reported.
 *   Without the guard every reader's first visit is told a new version is ready.
 * - **Being claimed is not a reason to reload; being taken over is.** The worker claims its pages
 *   on every activation, so a first visit hears `controllerchange` once, when it goes from no
 *   worker to one. That one is ignored. **What is remembered is whether the page is controlled
 *   *now*, not whether it was at load**: a page first claimed and later offered an update — a
 *   first visit left open across a deploy — must still reload when the reader presses.
 * - **One reload, ever.** A second `controllerchange` while the first reload is on its way would
 *   otherwise be a second one.
 * - **A waiting worker that stops waiting clears the answer**: activated by the press, or
 *   replaced by a still newer build, whose own `updatefound` reports it afresh.
 * - **`updateViaCache: "none"`**: the browser checks the worker's script — and what it imports —
 *   against the network, whatever the HTTP cache says. With the host's `no-cache` on the file
 *   that is belt and braces; without either, a new build is found a day late.
 * - **An install that fails is said, once** ({@link installFailedLine}): by the worker's own
 *   message when it got one across, and otherwise by its going `redundant` without ever having
 *   installed — which is all a page can see of a failed install by itself.
 */
export function watchUpdates(container: WorkerContainer, options: WatchOptions): UpdateWatch {
  let waiting: WaitingWorker | null = null;
  let controlled = container.controller !== null && container.controller !== undefined;
  let reloaded = false;
  let registration: Registration | undefined;

  const found = (worker: WaitingWorker): void => {
    // Read at the moment it is found: a first install reaches `installed` before it has claimed
    // the page, and a real update arrives on a page some worker already answers.
    if (!controlled || waiting === worker) return;
    waiting = worker;
    worker.addEventListener("statechange", () => {
      if (waiting !== worker || worker.state === "installed") return;
      waiting = null;
      options.onChange();
    });
    options.onChange();
  };

  let said = false;
  /** Say that an install failed — once a page, whichever of the two ways it was heard first. */
  const failed = (reason: string | undefined): void => {
    if (said) return;
    said = true;
    console.warn(installFailedLine(controlled, reason));
  };

  /** A worker on its way in: reported the moment it has installed, if it then has to wait. */
  const track = (worker: WaitingWorker | null): void => {
    if (!worker) return;
    if (worker.state === "installed") return found(worker);
    let installed = false;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed") {
        installed = true;
        found(worker);
      } else if (worker.state === "redundant" && !installed) {
        // Dropped before it ever installed: its install failed. (One that installed and was
        // then replaced also ends `redundant`, and that is no failure.)
        failed(undefined);
      }
    });
  };

  container.addEventListener("message", (event) => {
    const reason = installFailure(event.data);
    if (reason !== null) failed(reason || undefined);
  });

  container.addEventListener("controllerchange", () => {
    const taken = controlled;
    controlled = true;
    if (!taken) {
      // Claimed, not taken over. A build that was already waiting when this page arrived
      // uncontrolled was not reported then, and is an update now.
      if (registration?.waiting) found(registration.waiting);
      return;
    }
    if (reloaded || !options.mayReload()) return;
    reloaded = true;
    options.reload();
  });

  container.register(WORKER_URL, { updateViaCache: "none" }).then(
    (registered) => {
      registration = registered;
      // A worker is active and this page is not its: a hard reload, which goes round the worker
      // for the life of the document. Asked to take the page, it does, and the pictures the
      // page asks for from then on are answered. (A first visit has no active worker yet, and
      // is claimed when it has one.)
      if (!controlled && registered.active?.state === "activated") {
        registered.active.postMessage({ kind: CLAIM });
      }
      // A build that installed while no page of this document's was listening — an earlier
      // visit's, or another tab's — is already waiting when this page arrives.
      if (registered.waiting) found(registered.waiting);
      track(registered.installing);
      registered.addEventListener("updatefound", () => track(registered.installing));
    },
    // No worker is no pictures and no offline shell, and still an app: said, and nothing else.
    (error: unknown) => console.warn("MTG Grimoire: the service worker did not register.", error),
  );

  // A browser looks for a new worker on a navigation and about once a day. An installed app left
  // open for a week navigates nowhere, so it asks when it is looked at again — at most hourly.
  let asked = options.now();
  options.onVisible?.(() => {
    if (options.now() - asked < RECHECK_MS) return;
    asked = options.now();
    registration?.update().catch(() => undefined);
  });

  return {
    waiting: () => waiting !== null,
    apply() {
      if (!waiting) return false;
      waiting.postMessage({ kind: SKIP_WAITING });
      return true;
    },
  };
}
