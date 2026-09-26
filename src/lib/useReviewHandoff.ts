import { useEffect, useState } from "react";
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
  /** Whether the page is reading its cabinet flat on the hand-off's account. Passed to the list
   *  hook as `flattenLocally`, which ORs it with the stored switch and never writes it back. */
  reviewSweep: boolean;
  /**
   * The render-phase half — called **during render, after the list hook**, with that hook's own
   * filter state. Turns the filter (and the sweep) on for a hand-off landing on a page already
   * mounted, and spends the sweep once it has stopped doing anything.
   */
  settle: (needsReview: boolean | undefined, setNeedsReview: (value: boolean) => void) => void;
  /** The Flatten chip's `onToggle`: while the sweep stands, a press spends it and writes nothing;
   *  otherwise it is the page's own `toggle`, unchanged. */
  onFlattenToggle: (toggle: () => void) => () => void;
}

/**
 * **The To review widget's needs-review hand-off, answered** — `store.ts`'s `pendingReviewFilter`,
 * consumed by `CollectionPage` (`"collection"`) and `WishlistPage` (`"wishlist"`), which each call
 * this once and keep a one-line pointer here. It is `pendingFolder`'s one-shot shape aimed at a
 * filter rather than a drawer: read as the page renders, spent as it is read, remembered by
 * nothing. `scope` is what keeps the two pages from reading each other's post — one field serves
 * both lists, so the question is never "is there a hand-off" but "is there one for me".
 *
 * ## The filter
 *
 * **It sets the filter to `true` and nothing else about what the reader is looking at**, and
 * `!== true` rather than a falsy test for the needs-review banner's reason: `false` is the chip's
 * "not flagged" state, and a hand-off asking for the flagged rows has to move off it.
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
 * ## The sweep (the controller's ruling of 2026-09-26)
 *
 * To review counts the flagged rows across **every** drawer, but a page whose Flatten is off
 * stands at its root, which on the collection means "filed nowhere" since v25 — so the filter
 * alone would draw a flagged root, usually empty, under a widget that has just said "5 binder
 * entries". So wherever the reader's stored switch is off, the hand-off also turns on
 * `reviewSweep`, a **local** flag the list hook ORs into what it draws. It is `useState`, never
 * the store: leaving the view drops it, and the reader's persisted switch is never written —
 * `pendingOptimize`'s promise one page over. It lives exactly as long as it is doing something:
 *
 * - **the filter goes, it goes** — the chip, its ✕ and Reset all all land on a `needsReview` that
 *   is not `true`, and one clause in `settle` catches every one of them rather than a wrapper on
 *   each setter;
 * - **the stored switch comes on, it goes** — a sweep over a list the reader already reads flat is
 *   no sweep, and one left standing would make the reader's next Flatten press a no-op. That is
 *   also why the sweep is only **armed** while the switch is off (`!flattenStored`, at both arming
 *   sites): the collection's switch starts on, so for most readers it never arms there at all,
 *   while the wishlist's starts **off** — so on that page the sweep is the common case, and
 *   without it a reader sent by To review's `Wishes` row would land on a flagged root holding
 *   none of the wishes they were counted;
 * - **Flatten is pressed, it goes and writes nothing** — the chip draws the combined state, so the
 *   press that turns it off has to turn off the half that is on, which is this one
 *   ({@link ReviewHandoff.onFlattenToggle}); the page falls back on the stored switch, and the
 *   press after that is an ordinary one again.
 *
 * `settle`'s two clauses cannot chase each other: the sweep is only ever armed together with the
 * filter, so the clause that spends it — which needs the filter off or the switch on — is false
 * on the pass that armed it.
 *
 * @param scope Which list the calling page is.
 * @param flattenStored The reader's own Flatten switch for that list (`collectionFlattened` or
 *   `wishlistFlattened`), read by the page from the store — **not** the list hook's combined
 *   `flatten`, which this sweep is half of.
 */
export function useReviewHandoff(scope: ReviewScope, flattenStored: boolean): ReviewHandoff {
  const pending = useAppStore((s) => s.pendingReviewFilter);
  const clearPending = useAppStore((s) => s.clearPendingReviewFilter);
  const here = pending?.scope === scope;
  const [reviewSweep, setReviewSweep] = useState(() => here && !flattenStored);

  useEffect(() => {
    if (here) clearPending();
  }, [here, clearPending]);

  return {
    initialNeedsReview: here ? true : undefined,
    reviewSweep,
    settle: (needsReview, setNeedsReview) => {
      if (here && needsReview !== true) {
        setNeedsReview(true);
        if (!flattenStored) setReviewSweep(true);
      }
      if (reviewSweep && (needsReview !== true || flattenStored)) {
        setReviewSweep(false);
      }
    },
    onFlattenToggle: (toggle) => (reviewSweep ? () => setReviewSweep(false) : toggle),
  };
}
