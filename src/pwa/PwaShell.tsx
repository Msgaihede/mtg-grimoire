import type { JSX, ReactNode } from "react";
import { UpdateReadyBar } from "@/pwa/UpdateReadyBar";
import { useServiceWorker } from "@/pwa/useServiceWorker";

/**
 * The service worker's registration and the bar that answers it, around whatever root this
 * build renders.
 *
 * ## Why this is not in `App`, which is where it started
 *
 * **On the web target `<App />` is mounted only once a corpus exists.** `WebBoot` opens the
 * database, reads `sync_status`, and draws `BuildCorpus` for a count of zero — so a hook inside
 * `App` does not run until the reader has downloaded 75 MB. Driven in a real browser on
 * 2026-08-28 against a production build, a first visit reported
 * `navigator.serviceWorker.getRegistrations().length === 0` with the page showing "Build the
 * card database", and `navigator.serviceWorker.ready` never resolved at all.
 *
 * That is the shell's whole purpose deferred behind the one download it exists to survive: no
 * precache, no offline document, and no way to be told about a new build until the first sync
 * has finished. Mounted here, in `main.tsx`, it registers on the first paint of every build —
 * desktop included, where `useServiceWorker` returns without registering because `isWebTarget()`
 * is false, so this costs a `useState` and nothing else in the shipped window.
 *
 * **One mount, still.** `App` no longer holds a copy: two registrations would be two objects
 * racing to describe one waiting worker, which is `useUpdate`'s rule arrived at from the same
 * place.
 *
 * **There is no `MotionConfig` here, and the bar is therefore outside the app's one.**
 * `tokens.test.ts` requires exactly one in the whole of `src/` — a second would be two answers
 * to one question — and nothing is lost by its absence: `reducedMotion: "user"` reduces
 * *positional* keys, and the preset this bar uses is an opacity tween in both directions. A
 * cross-fade is what WCAG 2.3.3 permits; the hazard it names is movement, and there is none
 * here. A bar that ever *travelled* would need this reconsidering.
 */
export function PwaShell({ children }: { children: ReactNode }): JSX.Element {
  const update = useServiceWorker();
  return (
    <>
      {children}
      {/* A sibling of the root, which is the strongest form of `CardZoomIndicator`'s argument:
          the bar is `fixed` at `LAYER.popup`, a z-index competes only inside its own stacking
          context, and nothing at all stands between here and the document. */}
      <UpdateReadyBar ready={update.updateReady} onApply={update.applyUpdate} />
    </>
  );
}
