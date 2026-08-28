import { isWebTarget } from "@/pwa/target";

/**
 * Chrome's install event, which is in no TypeScript lib and is not on a standards track.
 * Declared here rather than shimmed globally so the shape is visible at the one place that
 * uses it.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallState = "unavailable" | "offered" | "installed";

let held: BeforeInstallPromptEvent | null = null;
let installed = false;
/** Takes the listeners off again. Non-null exactly while they are attached. */
let detach: (() => void) | null = null;

/**
 * Start listening for the browser's offer.
 *
 * **Called from `main.tsx`, before React**, because the event fires once and early: a page that
 * has not called `preventDefault()` on it by then has lost it, and there is no API to ask again.
 * That is also why this is a module-level latch rather than a hook — the offer arrives before
 * any component exists to hold it.
 *
 * **A second call attaches nothing**, and that guard is safe in a way its shape usually is not:
 * `src/workers/db.ts` had to memoise a *promise* because its `if (!glue)` test and its
 * assignment sat either side of an `await`, so two callers in one turn both passed. There is no
 * `await` here at all — `addEventListener` returns before this function does — so the latch and
 * the thing it guards are in the same synchronous step and no second caller can slip between
 * them. `reset` is the test hook, and it detaches rather than leaving a listener behind: without
 * that, the second test in a file would see `preventDefault` called once per previous call.
 */
export function captureInstallPrompt(target: EventTarget, options: { reset?: boolean } = {}): void {
  if (options.reset) {
    held = null;
    installed = false;
    detach?.();
    detach = null;
  }
  if (!isWebTarget() || detach) return;

  const onPrompt = (event: Event) => {
    // Without this Chrome draws its own install bar, and the app's own control becomes a second
    // one saying the same thing in a different place.
    event.preventDefault();
    held = event as BeforeInstallPromptEvent;
  };
  const onInstalled = () => {
    installed = true;
    held = null;
  };
  target.addEventListener("beforeinstallprompt", onPrompt);
  target.addEventListener("appinstalled", onInstalled);
  detach = () => {
    target.removeEventListener("beforeinstallprompt", onPrompt);
    target.removeEventListener("appinstalled", onInstalled);
  };
}

export function installState(): InstallState {
  if (installed) return "installed";
  return held ? "offered" : "unavailable";
}

/**
 * Show the browser's own install dialog.
 *
 * Must be called from a click: browsers refuse `prompt()` outside a user gesture. The event is
 * single-use, so the held one is dropped whatever the reader chooses — a second press on a
 * spent event throws.
 */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = held;
  if (!event) return "unavailable";
  held = null;
  await event.prompt();
  const { outcome } = await event.userChoice;
  return outcome;
}
