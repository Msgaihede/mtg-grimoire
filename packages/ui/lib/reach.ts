import { createContext, useContext } from "react";
import type { ViewId } from "./store";

/**
 * Whether this window has a page for `view` — asked by a control whose whole job is to take the
 * reader there, and answered by the shell.
 *
 * **A capability, not the edition.** A page never reads the edition (`lib/edition.ts`); what one
 * may ask is whether the place a press of its own would go exists here, and not why. `AppShell`
 * provides the answer from its edition — the light app draws six destinations, so a way into a
 * shared binder has nowhere to land there — and no provider at all is every view, which is what
 * the desktop app, a story and a test get.
 *
 * First reader, 2026-10-03: the collection's **Open a shared collection**, whose `onOpened` is a
 * `setActiveView("shared")` the light app cannot draw (`docs/reference/light-app.md` §7.8).
 *
 * **A provider passes a stable function** — one made per render would re-render every reader on
 * every render of the shell, for an answer that does not change for the life of the window.
 */
export const ReachContext = createContext<(view: ViewId) => boolean>(() => true);

/** Whether a press that goes to `view` has somewhere to go in this window. */
export function useReaches(view: ViewId): boolean {
  return useContext(ReachContext)(view);
}

/**
 * Whether a press in this window can publish a share — asked by the collection's **Share**,
 * whose every row ends in a `share_*` command, and answered by the shell.
 *
 * **A capability, not the edition**, for {@link ReachContext}'s reason: a page asks whether its
 * own press can work here, never which edition or which host it is on. `AppShell` provides the
 * edition's `publishes` — false in the light app, whose hosts have no share commands — and no
 * provider at all is true, which is what the desktop app, a story and a test get.
 *
 * A `boolean` rather than a function: it is one answer, and a primitive is stable by value.
 */
export const PublishesContext = createContext<boolean>(true);

/** Whether publishing a share can work in this window. */
export function usePublishes(): boolean {
  return useContext(PublishesContext);
}
