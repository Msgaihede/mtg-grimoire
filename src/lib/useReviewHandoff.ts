import { useEffect } from "react";
import { useAppStore, type PendingReviewFilter } from "./store";

/** The two lists a To review hand-off can name — {@link PendingReviewFilter}'s own union. */
export type ReviewScope = PendingReviewFilter["scope"];

/** What {@link useReviewHandoff} hands a page: two halves, one on each side of its list hook. */
export interface ReviewHandoff {
  /**
   * The needs-review filter the list hook should **mount** with — `true` while a hand-off naming
   * this page is waiting, otherwise nothing. Passed as `initialNeedsReview`; see the hook for why
   * a render-phase write alone is too late.
   */
  initialNeedsReview: true | undefined;
  /**
   * The render-phase half — called **during render, after the list hook**, with that hook's own
   * filter state. Turns the filter on for a hand-off landing on a page already mounted.
   */
  settle: (needsReview: boolean | undefined, setNeedsReview: (value: boolean) => void) => void;
}

/**
 * **The To review widget's needs-review hand-off, answered** — `store.ts`'s `pendingReviewFilter`,
 * consumed by `CollectionPage` (`"collection"`) and `WishlistPage` (`"wishlist"`), which each call
 * this once and keep a one-line pointer here. It is `pendingFolder`'s one-shot shape aimed at a
 * filter rather than a drawer: read as the page renders, spent as it is read, remembered by
 * nothing. `scope` is what keeps the two pages from reading each other's post — one field serves
 * both lists, so the question is never "is there a hand-off" but "is there one for me".
 *
 * **It sets the filter to `true` and nothing else about what the reader is looking at**, and
 * `!== true` rather than a falsy test for the needs-review banner's reason: `false` is the chip's
 * "not flagged" state, and a hand-off asking for the flagged rows has to move off it. Where the
 * reader stands is the page's business — both pages open the root for it, whose shelves are every
 * drawer, which is what To review counted.
 *
 * **On a mount it is the list hook's initial state, and that is not a stylistic choice.** The
 * first draft set it with a render-phase `setNeedsReview` on the first pass, and the page still
 * fetched the unfiltered list once: TanStack builds its `QueryObserver` in a `useState`
 * initializer, React keeps that hook state through the pass it restarts, and the observer
 * subscribes — and fetches — at commit with the **first** pass's options
 * (`[{marketplace, limit, offset}, {needsReview: true, …}]`, probed in `CollectionPage.test.tsx`
 * on 2026-09-26). So {@link ReviewHandoff.initialNeedsReview} is read before the list hook is
 * called, and the hook is born filtered.
 *
 * **On a page already mounted it is {@link ReviewHandoff.settle}**, the render-phase adjustment —
 * never a mount effect, which would fetch the whole list first and then the flagged rows, and a
 * `setState` inside an effect body is the lint failure that dies only at `verify`. That path is
 * what makes the widget's two store writes (`setActiveView`, then this hand-off) safe to land in
 * one commit or two. A discarded render-phase pass is never subscribed, so this path costs no
 * extra fetch either.
 *
 * **Spent by the effect below whether or not it changed anything**, so it cannot fire on a later
 * visit.
 *
 * @param scope Which list the calling page is.
 */
export function useReviewHandoff(scope: ReviewScope): ReviewHandoff {
  const pending = useAppStore((s) => s.pendingReviewFilter);
  const clearPending = useAppStore((s) => s.clearPendingReviewFilter);
  const here = pending?.scope === scope;

  useEffect(() => {
    if (here) clearPending();
  }, [here, clearPending]);

  return {
    initialNeedsReview: here ? true : undefined,
    settle: (needsReview, setNeedsReview) => {
      if (here && needsReview !== true) setNeedsReview(true);
    },
  };
}
